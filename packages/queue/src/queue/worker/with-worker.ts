import {
    type EventCallback,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { LeaseMismatchError } from '../../persist/errors'
import { isIntegerInRange } from '../../util/number.util'
import {
    isInvalidStaticDelay,
    resolveDelayMs,
} from '../../util/delay-policy.util'
import { isNonNegativeFinite } from '../../util/number.util'
import {
    cancelTimeout,
    scheduleTimeout,
} from '../../util/schedule-timeout.util'
import type {
    WorkerContext,
    WorkerFn,
} from '../../worker/types'
import {
    decorateQueue,
    type PreserveQueueExtras,
} from '../core/forward.util'
import { markQueueLayer, WORKER_LAYER } from '../core/layers.util'
import type { Lease, Queue, QueueEvents } from '../core/queue'
import { getQueueName } from '../core/queue-name.util'
import { isJob } from '../jobs/job'
import {
    getLoopHops,
    queueMetaEqual,
    readMappedQueueMeta,
    stampLoopHops,
    QKITT_QUEUE_KEY,
} from '../loop/hop-meta.util'
import {
    gracefulStop as runGracefulStop,
    type GracefulStopable,
    type GracefulStopOptions,
} from './graceful-stop'
import { InvalidWorkerOptionError } from './invalid-worker-option-error'
import { resolveTimeoutMs } from './resolve-timeout-ms.util'
import {
    attachRecoveryConfig,
    DeadLetterEnqueueError,
    DLQ_RETRY_BACKOFF_MS,
    getRecoveryConfig,
    LoopEnqueueError,
    type LoopMapContext,
    type RecoveryConfig,
    type RecoveryPolicy,
    type RecoveryPolicyResult,
} from './recovery.util'

export { InvalidWorkerOptionError } from './invalid-worker-option-error'
export type { WorkerAbortSignal, WorkerContext } from '../../worker/types'
export type {
    RecoveryPolicy,
    RecoveryPolicyResult,
} from './recovery.util'

export type WorkerEvents<T, R = unknown> = {
    'worker:started': { item: T }
    'worker:completed': { item: T; result: R }
    'worker:failed': { item: T; error: unknown }
    /** Handler duration, separate to keep completion/failure event payloads stable. */
    'worker:handled': { item: T; outcome: 'completed' | 'failed'; durationMs: number }
    'worker:requeued': { item: T; error?: unknown; delayMs?: number }
    'worker:dropped': { item: T; error?: unknown }
    'worker:idle': undefined
    'worker:pump-error': { error: unknown }
}

export type WithWorkerOptions<T = unknown> = {
    concurrency?: number
    autoStart?: boolean
    /** Cooperatively abort a handler after this many milliseconds. */
    timeoutMs?: number
    /** Derive opaque tracing/correlation context for each delivery. */
    traceContext?: (item: T) => unknown
    /**
     * Recovery policy after worker failure. Default `'fail'` (DLQ if
     * registered via withDeadLetter, else drop).
     */
    onFailure?: RecoveryPolicy<T>
}

/** Abort reason when a worker exceeds its configured cooperative timeout. */
export class WorkerTimeoutError extends Error {
    override readonly name = 'WorkerTimeoutError'
    readonly timeoutMs: number

    constructor(timeoutMs: number) {
        super(`worker timed out after ${timeoutMs}ms`)
        this.timeoutMs = timeoutMs
    }
}

/** Abort reason when the queue lease deadline elapses while a handler runs. */
export class WorkerLeaseExpiredError extends Error {
    override readonly name = 'WorkerLeaseExpiredError'
    readonly leaseDeadline: number

    constructor(leaseDeadline: number) {
        super(`worker lease expired at ${leaseDeadline}`)
        this.leaseDeadline = leaseDeadline
    }
}

type WorkerQueueEvents<T, R, TEvents extends EventMap> = MergeEventMaps<
    TEvents,
    WorkerEvents<T, R>
>

export type WorkerControls = {
    start: () => void
    stop: () => void
    gracefulStop: (options?: GracefulStopOptions) => Promise<void>
    isRunning: () => boolean
    isProcessing: () => boolean
    activeCount: () => number
}

export type QueueWithWorker<
    T,
    R = unknown,
    TEvents extends EventMap = WorkerQueueEvents<T, R, QueueEvents<T>>,
> = Queue<T, TEvents> & WorkerControls

const resolveConcurrency = (value: number | undefined): number => {
    const concurrency = value ?? 1
    if (!isIntegerInRange(concurrency, 1)) {
        throw new InvalidWorkerOptionError(
            'concurrency must be a safe integer >= 1',
        )
    }
    return concurrency
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    value != null && typeof (value as { then?: unknown }).then === 'function'

type AbortControllerLike = {
    readonly signal: AbortSignal
    abort: (reason?: unknown) => void
}

const createAbortController = (): AbortControllerLike =>
    new (
        globalThis as unknown as {
            AbortController: new () => AbortControllerLike
        }
    ).AbortController()

const NEVER_ABORT_SIGNAL = createAbortController().signal
const NOOP_DISPOSE = (): void => {}
const elapsedDuration = (startedAt: number | undefined): number =>
    startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)

const isPlainQueueMeta = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(item, QKITT_QUEUE_KEY)) {
        return undefined
    }
    return (item as Record<string, unknown>)[QKITT_QUEUE_KEY]
}

/**
 * Wrap a queue with a worker that claims and processes items.
 *
 * Default recovery is `'fail'`: DLQ when registered, else drop. Use
 * `onFailure: 'loop'` or {@link import('../loop/with-loop').withLoop} to requeue.
 * Success always `ack`s the lease.
 */
export const withWorker = <
    T,
    R = unknown,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
    TQueue extends Queue<T, TEvents> = Queue<T, TEvents>,
>(
    queue: TQueue & Queue<T, TEvents>,
    worker: WorkerFn<T, R>,
    options: WithWorkerOptions<T> = {},
): QueueWithWorker<T, R, WorkerQueueEvents<T, R, TEvents>> &
    PreserveQueueExtras<TQueue> => {
    const concurrency = resolveConcurrency(options.concurrency)
    const autoStart = options.autoStart ?? true
    const timeoutMs = resolveTimeoutMs(options.timeoutMs)
    const policyExplicit = options.onFailure !== undefined
    const recovery: RecoveryConfig<T> = {
        policyExplicit,
        policy: options.onFailure ?? 'fail',
    }

    const inner = queue
    const emitInner = inner.emit as (
        eventName: string,
        data: unknown,
    ) => void
    const onInner = inner.on as (
        eventName: string,
        callback: EventCallback<unknown>,
    ) => () => void
    const on = onInner as QueueWithWorker<
        T,
        R,
        WorkerQueueEvents<T, R, TEvents>
    >['on']

    let running = false
    let active = 0
    let pumping = false
    /** Set when work arrives while a pump await is in flight. */
    let pumpAgain = false

    /** Idle only when nothing is pending (including delayed rows). */
    const isIdleForWorker = (): boolean => inner.size() === 0

    const finishItem = (): void => {
        active -= 1
        if (active === 0 && isIdleForWorker()) {
            emitInner('worker:idle', undefined)
        }
        if (!pumping) {
            pump()
        }
    }

    const settleAck = async (lease: Lease<T>): Promise<void> => {
        await inner.ack(lease)
    }

    const settleReschedule = async (
        lease: Lease<T>,
        next: {
            item: T
            delayMs?: number
            attempt?: number
            dlqHandoffAttempt?: number
        },
    ): Promise<void> => {
        await inner.reschedule(lease, next)
    }

    const applyLoop = async (
        lease: Lease<T>,
        item: T,
        error: unknown | undefined,
        override?: { item?: T; delayMs?: number; dlqHandoffAttempt?: number },
    ): Promise<void> => {
        try {
            const name = getQueueName(inner)
            const loopOpts = recovery.loop
            let nextItem: T = override?.item ?? item
            let delayMs = override?.delayMs ?? 0

            if (loopOpts && name !== undefined) {
                const previousHops = getLoopHops(item, name)
                const hops = (previousHops ?? 0) + 1
                const ctx: LoopMapContext = { name, previousHops, hops }
                // Filter false → fail path (DLQ if registered), not silent drop.
                if (loopOpts.filter && !loopOpts.filter(item, error, ctx)) {
                    await applyFail(lease, item, error)
                    return
                }
                if (loopOpts.delay !== undefined) {
                    if (isInvalidStaticDelay(loopOpts.delay)) {
                        throw new InvalidWorkerOptionError(
                            'loop delay must be a finite number >= 0',
                        )
                    }
                    const ms = resolveDelayMs(loopOpts.delay, hops)
                    if (!isNonNegativeFinite(ms)) {
                        throw new InvalidWorkerOptionError(
                            'loop delay must be a finite number >= 0',
                        )
                    }
                    delayMs = ms
                }
                if (loopOpts.map) {
                    const mapped = loopOpts.map(item, error, ctx)
                    const originalMeta = isPlainQueueMeta(item)
                    const attempted = readMappedQueueMeta(mapped)
                    if (
                        attempted !== undefined &&
                        !queueMetaEqual(attempted, originalMeta)
                    ) {
                        emitInner('loop:meta-override', {
                            item,
                            error,
                            name,
                            attempted,
                            applied: { hops },
                        })
                    }
                    nextItem = stampLoopHops(mapped, item, name, hops) as T
                } else {
                    nextItem = stampLoopHops(item, item, name, hops) as T
                }
            } else if (override?.item !== undefined) {
                nextItem = override.item
            }

            await settleReschedule(lease, {
                item: nextItem,
                delayMs,
                dlqHandoffAttempt: override?.dlqHandoffAttempt,
            })
            emitInner('worker:requeued', { item, error, delayMs })
        } catch (cause) {
            const loopError = new LoopEnqueueError(
                'failed to re-enqueue loop item',
                { cause, item, workerError: error },
            )
            emitInner('loop:error', { item, error, cause: loopError })
            throw loopError
        }
    }

    const applyFail = async (
        lease: Lease<T>,
        item: T,
        error: unknown,
    ): Promise<void> => {
        const dlq = recovery.dlq
        if (!dlq) {
            await settleAck(lease)
            emitInner('worker:dropped', { item, error })
            return
        }

        try {
            if (dlq.filter && !dlq.filter(item, error)) {
                await settleAck(lease)
                emitInner('worker:dropped', { item, error })
                return
            }
            const map = dlq.map ?? ((x: T) => x as unknown)
            const deadLetterItem = map(item, error)
            await Promise.resolve(dlq.target.enqueue(deadLetterItem as never))
            await settleAck(lease)
            emitInner('dlq:enqueued', {
                item,
                error,
                deadLetterItem,
            })
        } catch (cause) {
            const handoffError = new DeadLetterEnqueueError(
                'failed to enqueue dead-letter item',
                { cause, item, workerError: error },
            )
            emitInner('dlq:error', {
                item,
                error,
                cause: handoffError,
            })
            const handoffAttempt =
                (lease.dlqHandoffAttempt ?? 0) + 1
            if (handoffAttempt >= dlq.maxHandoffAttempts) {
                await settleAck(lease)
                emitInner('worker:dropped', { item, error })
                return
            }
            await applyLoop(lease, item, error, {
                item,
                delayMs: DLQ_RETRY_BACKOFF_MS,
                dlqHandoffAttempt: handoffAttempt,
            })
        }
    }

    const applyRecovery = async (
        lease: Lease<T>,
        item: T,
        error: unknown,
    ): Promise<void> => {
        const retry = recovery.retry
        if (retry) {
            let classification: 'retry' | 'fail' = 'retry'
            if (retry.classify) {
                classification = await retry.classify({
                    item,
                    error,
                    attempt: lease.attempt,
                })
            }
            if (classification === 'retry' && lease.attempt < retry.maxAttempts) {
                const exponent = Math.min(lease.attempt - 1, 52)
                const baseDelay = Math.min(
                    retry.maxDelayMs,
                    retry.initialDelayMs * 2 ** exponent,
                )
                const spread =
                    1 - retry.jitter + Math.random() * retry.jitter * 2
                const delayMs = Math.min(
                    retry.maxDelayMs,
                    Math.round(baseDelay * spread),
                )
                await settleReschedule(lease, {
                    item,
                    delayMs,
                    attempt: lease.attempt + 1,
                })
                emitInner('retry:scheduled', {
                    item,
                    error,
                    attempt: lease.attempt,
                    nextAttempt: lease.attempt + 1,
                    delayMs,
                })
                emitInner('worker:requeued', { item, error, delayMs })
                return
            }
            emitInner('retry:exhausted', {
                item,
                error,
                attempt: lease.attempt,
            })
        }
        const policy = recovery.policy
        if (policy === 'loop') {
            await applyLoop(lease, item, error)
            return
        }
        if (policy === 'fail') {
            await applyFail(lease, item, error)
            return
        }
        try {
            const result = await policy({ item, error, lease })
            if (result == null) {
                await applyFail(lease, item, error)
                return
            }
            if (result.action === 'loop') {
                await applyLoop(lease, item, error, {
                    item: result.item,
                    delayMs: result.delayMs,
                })
                return
            }
            if (result.action === 'fail') {
                await applyFail(lease, item, error)
            }
        } catch {
            await applyLoop(lease, item, error)
        }
    }

    const failLease = (
        lease: Lease<T>,
        item: T,
        error: unknown,
        startedAt: number | undefined,
    ): void => {
        void applyRecovery(lease, item, error)
            .catch(async (err) => {
                if (err instanceof LeaseMismatchError) return
                emitInner('worker:pump-error', { error: err })
                try {
                    await inner.release(lease)
                } catch {
                    /* already settled or reclaim won */
                }
            })
            .finally(() => {
                // Finish after recovery so gracefulStop waits for it.
                finishItem()
                emitInner('worker:failed', { item, error })
                emitInner('worker:handled', {
                    item,
                    outcome: 'failed',
                    durationMs: elapsedDuration(startedAt),
                })
            })
    }

    const completeLease = (
        lease: Lease<T>,
        item: T,
        result: R,
        startedAt: number | undefined,
    ): void => {
        void inner
            .ack(lease)
            .then(() => {
                finishItem()
                emitInner('worker:completed', { item, result })
                emitInner('worker:handled', {
                    item,
                    outcome: 'completed',
                    durationMs: elapsedDuration(startedAt),
                })
            })
            .catch((err) => {
                finishItem()
                if (!(err instanceof LeaseMismatchError)) {
                    emitInner('worker:pump-error', { error: err })
                }
            })
    }

    const callWorker = (
        item: T,
        context: WorkerContext,
    ): R | PromiseLike<R> => worker(item, context)

    const processLease = (lease: Lease<T>): void => {
        const item = lease.item
        emitInner('worker:started', { item })

        const startedAt = Date.now()
        const needsAbort =
            timeoutMs !== undefined || lease.expiresAt !== null
        const controller = needsAbort ? createAbortController() : undefined
        const job =
            item !== null && typeof item === 'object' && isJob(item)
                ? item
                : undefined
        const traceContext = options.traceContext
            ? options.traceContext(item)
            : job?.metadata
        const context: WorkerContext = {
            jobId: job?.id,
            attempt: lease.attempt,
            leaseDeadline: lease.expiresAt ?? undefined,
            traceContext,
            signal: controller?.signal ?? NEVER_ABORT_SIGNAL,
        }

        let dispose: () => void = NOOP_DISPOSE
        if (needsAbort) {
            const timers: unknown[] = []
            const abortAfter = (ms: number, reason: unknown): void => {
                timers.push(
                    scheduleTimeout(() => {
                        if (!controller!.signal.aborted) {
                            controller!.abort(reason)
                        }
                    }, ms),
                )
            }
            if (timeoutMs !== undefined) {
                abortAfter(timeoutMs, new WorkerTimeoutError(timeoutMs))
            }
            if (lease.expiresAt !== null) {
                abortAfter(
                    Math.max(0, lease.expiresAt - Date.now()),
                    new WorkerLeaseExpiredError(lease.expiresAt),
                )
            }
            dispose = () => {
                for (const timer of timers) cancelTimeout(timer)
            }
        }

        let ret: R | PromiseLike<R>
        try {
            ret = callWorker(item, context)
            if (isThenable(ret)) {
                Promise.resolve(ret).then(
                    (result) => {
                        dispose()
                        completeLease(lease, item, result as R, startedAt)
                    },
                    (error: unknown) => {
                        dispose()
                        failLease(lease, item, error, startedAt)
                    },
                )
                return
            }
        } catch (error) {
            dispose()
            failLease(lease, item, error, startedAt)
            return
        }

        dispose()
        completeLease(lease, item, ret, startedAt)
    }

    let unsubscribeEnqueued: (() => void) | undefined

    const stop = (): void => {
        running = false
        unsubscribeEnqueued?.()
        unsubscribeEnqueued = undefined
    }

    const pumpAsync = async (): Promise<void> => {
        if (pumping) {
            pumpAgain = true
            return
        }
        pumping = true
        try {
            do {
                pumpAgain = false
                while (running && active < concurrency) {
                    let lease: Lease<T> | undefined
                    try {
                        lease = await inner.claim()
                    } catch (error) {
                        emitInner('worker:pump-error', { error })
                        stop()
                        break
                    }
                    if (lease === undefined) break
                    active += 1
                    processLease(lease)
                }
            } while (pumpAgain && running)
        } finally {
            pumping = false
            if (pumpAgain && running) {
                pumpAgain = false
                void pumpAsync()
            }
        }
    }

    const pump = (): void => {
        void pumpAsync()
    }

    const subscribeEnqueued = (): void => {
        if (unsubscribeEnqueued) return
        unsubscribeEnqueued = onInner('queue:enqueued', () => {
            pump()
        })
    }

    const start = (): void => {
        if (running) return
        running = true
        subscribeEnqueued()
        pump()
    }

    if (autoStart) {
        start()
    }

    const isProcessing = (): boolean => active > 0

    const gracefulStop = (options?: GracefulStopOptions): Promise<void> => {
        const flush = (inner as { flush?: () => void | PromiseLike<void> })
            .flush
        return runGracefulStop(
            {
                stop,
                isProcessing,
                on: on as GracefulStopable['on'],
                ...(typeof flush === 'function'
                    ? {
                          flush: () =>
                              (
                                  flush as () => void | PromiseLike<void>
                              ).call(inner),
                      }
                    : {}),
            },
            options,
        )
    }

    const hydrate = async (): Promise<void> => {
        if (running || active > 0) {
            const { HydrateWhileActiveError } = await import(
                '../../persist/errors'
            )
            throw new HydrateWhileActiveError()
        }
        return inner.hydrate()
    }

    const api = markQueueLayer(
        decorateQueue(inner, {
            on,
            start,
            stop,
            gracefulStop,
            isRunning: () => running,
            isProcessing,
            activeCount: () => active,
            hydrate,
        }),
        WORKER_LAYER,
    )

    attachRecoveryConfig(api, recovery)

    return api as unknown as QueueWithWorker<
        T,
        R,
        WorkerQueueEvents<T, R, TEvents>
    > &
        PreserveQueueExtras<TQueue>
}
