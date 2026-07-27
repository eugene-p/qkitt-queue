import {
    type EventCallback,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { createSubscriptionCounts } from '../../events/subscription-counts'
import { LeaseMismatchError } from '../../persist/errors'
import { isIntegerInRange } from '../../util/number.util'
import {
    isInvalidStaticDelay,
    resolveDelayMs,
} from '../../util/delay-policy.util'
import { isNonNegativeFinite } from '../../util/number.util'
import type { WorkerFn } from '../../worker/types'
import {
    decorateQueue,
    type PreserveQueueExtras,
} from '../core/forward.util'
import { getInlineOps } from '../core/inline-ops'
import { markQueueLayer, WORKER_LAYER } from '../core/layers.util'
import type { Lease, Queue, QueueEvents } from '../core/queue'
import { getQueueName } from '../core/queue-name.util'
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
import {
    attachRecoveryConfig,
    DLQ_RETRY_BACKOFF_MS,
    getRecoveryConfig,
    type LoopMapContext,
    type RecoveryConfig,
    type RecoveryPolicy,
    type RecoveryPolicyResult,
} from './recovery.util'

export { InvalidWorkerOptionError } from './invalid-worker-option-error'
export type {
    RecoveryPolicy,
    RecoveryPolicyResult,
} from './recovery.util'

export type WorkerEvents<T, R = unknown> = {
    'worker:started': { item: T }
    'worker:completed': { item: T; result: R }
    'worker:failed': { item: T; error: unknown }
    'worker:requeued': { item: T; error?: unknown; delayMs?: number }
    'worker:dropped': { item: T; error?: unknown }
    'worker:idle': undefined
    'worker:pump-error': { error: unknown }
}

export type WithWorkerOptions<T = unknown> = {
    concurrency?: number
    autoStart?: boolean
    /**
     * Recovery policy after worker failure. Default `'fail'` (DLQ if
     * registered via withDeadLetter, else drop).
     */
    onFailure?: RecoveryPolicy<T>
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
    const { counts: subs, wrapOn } = createSubscriptionCounts({
        started: 'worker:started',
        completed: 'worker:completed',
        failed: 'worker:failed',
        requeued: 'worker:requeued',
        dropped: 'worker:dropped',
        idle: 'worker:idle',
        pumpError: 'worker:pump-error',
    })
    const on = wrapOn(onInner) as QueueWithWorker<
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

    const inlineOps = getInlineOps<T>(inner)

    const finishItem = (): void => {
        active -= 1
        if (active === 0 && subs.idle > 0 && isIdleForWorker()) {
            emitInner('worker:idle', undefined)
        }
        if (!pumping) {
            pump()
        }
    }

    const settleAck = async (lease: Lease<T>): Promise<void> => {
        if (inlineOps) {
            inlineOps.ackSync(lease)
            return
        }
        await inner.ack(lease)
    }

    const settleReschedule = async (
        lease: Lease<T>,
        next: { item: T; delayMs?: number },
    ): Promise<void> => {
        if (inlineOps) {
            inlineOps.rescheduleSync(lease, next)
            return
        }
        await inner.reschedule(lease, next)
    }

    const applyLoop = async (
        lease: Lease<T>,
        item: T,
        error: unknown | undefined,
        override?: { item?: T; delayMs?: number },
    ): Promise<void> => {
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

        await settleReschedule(lease, { item: nextItem, delayMs })
        if (subs.requeued > 0) {
            emitInner('worker:requeued', { item, error, delayMs })
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
            if (subs.dropped > 0) {
                emitInner('worker:dropped', { item, error })
            }
            return
        }

        try {
            if (dlq.filter && !dlq.filter(item, error)) {
                await settleAck(lease)
                if (subs.dropped > 0) {
                    emitInner('worker:dropped', { item, error })
                }
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
            emitInner('dlq:error', {
                item,
                error,
                cause,
            })
            await applyLoop(lease, item, error, {
                item,
                delayMs: DLQ_RETRY_BACKOFF_MS,
            })
        }
    }

    const applyRecovery = async (
        lease: Lease<T>,
        item: T,
        error: unknown,
    ): Promise<void> => {
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
            if (result == null) return
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

    const failLease = (lease: Lease<T>, item: T, error: unknown): void => {
        void applyRecovery(lease, item, error)
            .catch(async (err) => {
                if (err instanceof LeaseMismatchError) return
                if (subs.pumpError > 0) {
                    emitInner('worker:pump-error', { error: err })
                }
                try {
                    if (inlineOps) inlineOps.releaseSync(lease)
                    else await inner.release(lease)
                } catch {
                    /* already settled or reclaim won */
                }
            })
            .finally(() => {
                // active-- then failed so gracefulStop settles after recovery.
                finishItem()
                if (subs.failed > 0) {
                    emitInner('worker:failed', { item, error })
                }
            })
    }

    const completeLease = (lease: Lease<T>, item: T, result: R): void => {
        // Inline: ack is sync — finish without Promise hops.
        if (inlineOps) {
            try {
                inlineOps.ackSync(lease)
                finishItem()
                if (subs.completed > 0) {
                    emitInner('worker:completed', { item, result })
                }
            } catch (err) {
                finishItem()
                if (
                    !(err instanceof LeaseMismatchError) &&
                    subs.pumpError > 0
                ) {
                    emitInner('worker:pump-error', { error: err })
                }
            }
            return
        }
        void inner
            .ack(lease)
            .then(() => {
                finishItem()
                if (subs.completed > 0) {
                    emitInner('worker:completed', { item, result })
                }
            })
            .catch((err) => {
                finishItem()
                if (
                    !(err instanceof LeaseMismatchError) &&
                    subs.pumpError > 0
                ) {
                    emitInner('worker:pump-error', { error: err })
                }
            })
    }

    const processLease = (lease: Lease<T>): void => {
        const item = lease.item
        if (subs.started > 0) {
            emitInner('worker:started', { item })
        }

        let ret: R | PromiseLike<R>
        try {
            ret = worker(item)
        } catch (error) {
            failLease(lease, item, error)
            return
        }

        if (isThenable(ret)) {
            Promise.resolve(ret).then(
                (result) => {
                    completeLease(lease, item, result as R)
                },
                (error: unknown) => {
                    failLease(lease, item, error)
                },
            )
            return
        }

        completeLease(lease, item, ret)
    }

    let unsubscribeEnqueued: (() => void) | undefined

    const stop = (): void => {
        running = false
        unsubscribeEnqueued?.()
        unsubscribeEnqueued = undefined
    }

    /**
     * Inline pump is fully synchronous (no Promise alloc per kick).
     * Durable path awaits claim on the write chain in pumpDurable.
     */
    const pumpInline = (): void => {
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
                        lease = inlineOps!.claimSync()
                    } catch (error) {
                        if (subs.pumpError > 0) {
                            emitInner('worker:pump-error', { error })
                        }
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
                pumpInline()
            }
        }
    }

    const pumpDurable = async (): Promise<void> => {
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
                        if (subs.pumpError > 0) {
                            emitInner('worker:pump-error', { error })
                        }
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
                void pumpDurable()
            }
        }
    }

    const pump = (): void => {
        if (inlineOps) pumpInline()
        else void pumpDurable()
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

