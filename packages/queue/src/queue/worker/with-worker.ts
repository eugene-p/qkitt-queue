import {
    type EventCallback,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { createSubscriptionCounts } from '../../events/subscription-counts'
import { isIntegerInRange } from '../../util/number.util'
import type { WorkerFn } from '../../worker/types'
import { decorateQueue } from '../core/forward.util'
import { markQueueLayer, WORKER_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents } from '../core/queue'
import { QueueHydratingError } from '../../persist/hydrate-gate.util'

/** Non-core keys from an inner queue (e.g. persist `flush` / `hydrate`). */
type PreserveQueueExtras<TQueue extends object> = Omit<
    TQueue,
    keyof Queue<unknown, EventMap>
>

export type WorkerEvents<T, R = unknown> = {
    /** Fired just before the worker runs an item. */
    'worker:started': { item: T }
    /** Fired when the worker resolves successfully. */
    'worker:completed': { item: T; result: R }
    /** Fired when the worker throws or rejects. */
    'worker:failed': { item: T; error: unknown }
    /** Fired when nothing is in-flight and the queue is empty. */
    'worker:idle': undefined
    /**
     * Fired when `dequeue` throws an unexpected error (not hydrate).
     * The worker stops taking new items; call `start()` after fixing the cause.
     */
    'worker:pump-error': { error: unknown }
}

export type WithWorkerOptions = {
    /** Max items processed at the same time. Defaults to 1. Must be a safe integer ≥ 1. */
    concurrency?: number
    /** Start pumping immediately. Defaults to true. */
    autoStart?: boolean
}

type WorkerQueueEvents<T, R, TEvents extends EventMap> = MergeEventMaps<
    TEvents,
    WorkerEvents<T, R>
>

export type WorkerControls = {
    /** Begin processing queued items. */
    start: () => void
    /** Stop taking new items. In-flight work still finishes. */
    stop: () => void
    /** Whether the worker is allowed to take new items. */
    isRunning: () => boolean
    /** Whether any items are currently being processed. */
    isProcessing: () => boolean
    /** Number of items currently being processed. */
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
        throw new Error('concurrency must be a safe integer >= 1')
    }
    return concurrency
}

/** Thenable check — same unwrapping surface as `await` (not only native Promise). */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    value != null && typeof (value as { then?: unknown }).then === 'function'

/**
 * Wrap a queue with a worker that dequeues and processes items FIFO-style.
 * Listens for `queue:enqueued` and pumps work up to `concurrency`.
 *
 * Failed items are **not** re-queued. Use `retryWorker` for in-call retries,
 * or handle `worker:failed` and re-enqueue yourself.
 *
 * **Composition (required when using persist):** worker must be the **outer**
 * decorator so `dequeue` hits the persist override:
 * `withWorker(withPersist(buildQueue(), store), worker)` — not the reverse.
 *
 * Inner decorator extras (e.g. `flush` from row/snapshot persist) are preserved
 * at runtime and in the return type.
 *
 * While a stacked persist layer is hydrating, `tryDequeue` throws
 * {@link QueueHydratingError}; the pump waits for the post-hydrate
 * `queue:enqueued` kick. Any other dequeue failure emits `worker:pump-error`
 * and stops the worker. Nullish payloads are valid — the pump uses
 * {@link Queue.tryDequeue} so emptiness is structural, not value-based.
 */
export const withWorker = <
    T,
    R = unknown,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
    TQueue extends Queue<T, TEvents> = Queue<T, TEvents>,
>(
    queue: TQueue & Queue<T, TEvents>,
    worker: WorkerFn<T, R>,
    options: WithWorkerOptions = {},
): QueueWithWorker<T, R, WorkerQueueEvents<T, R, TEvents>> &
    PreserveQueueExtras<TQueue> => {
    const concurrency = resolveConcurrency(options.concurrency)
    const autoStart = options.autoStart ?? true

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
    /** Prevents nested pump when a sync worker finishes inside the pump loop. */
    let pumping = false

    const finishItem = (): void => {
        active -= 1

        if (active === 0 && inner.isEmpty() && subs.idle > 0) {
            emitInner('worker:idle', undefined)
        }

        // Sync completions re-enter the open `while` via `active--` only.
        // Async completions need an explicit pump after the microtask.
        if (!pumping) {
            pump()
        }
    }

    const processItem = (item: T): void => {
        if (subs.started > 0) {
            emitInner('worker:started', { item })
        }

        let ret: R | PromiseLike<R>
        try {
            ret = worker(item)
        } catch (error) {
            if (subs.failed > 0) {
                emitInner('worker:failed', { item, error })
            }
            finishItem()
            return
        }

        if (isThenable(ret)) {
            // One thenable hop — no outer `async` function Promise.
            Promise.resolve(ret).then(
                (result) => {
                    if (subs.completed > 0) {
                        emitInner('worker:completed', {
                            item,
                            result: result as R,
                        })
                    }
                    finishItem()
                },
                (error: unknown) => {
                    if (subs.failed > 0) {
                        emitInner('worker:failed', { item, error })
                    }
                    finishItem()
                },
            )
            return
        }

        if (subs.completed > 0) {
            emitInner('worker:completed', { item, result: ret })
        }
        finishItem()
    }

    let unsubscribeEnqueued: (() => void) | undefined

    const subscribeEnqueued = (): void => {
        if (unsubscribeEnqueued) return
        unsubscribeEnqueued = onInner('queue:enqueued', () => {
            pump()
        })
    }

    const stop = (): void => {
        running = false
        unsubscribeEnqueued?.()
        unsubscribeEnqueued = undefined
    }

    const pump = (): void => {
        if (pumping) return
        pumping = true
        try {
            while (running && active < concurrency) {
                // Slot presence = non-empty; payload may be null/undefined.
                const slot = inner.tryDequeue()
                if (slot === undefined) break

                active += 1
                processItem(slot.value)
            }
        } catch (error) {
            // Persist hydrate: wait for post-hydrate restore kick.
            if (error instanceof QueueHydratingError) {
                return
            }
            // Unexpected dequeue failure: surface and stop so it is not silent.
            if (subs.pumpError > 0) {
                emitInner('worker:pump-error', { error })
            }
            stop()
        } finally {
            pumping = false
        }
    }

    const start = (): void => {
        if (running) return
        running = true
        // Subscribe here so autoStart: false has no listener until start().
        // Post-hydrate queue:enqueued kick only reaches running workers.
        subscribeEnqueued()
        pump()
    }

    if (autoStart) {
        start()
    }

    const api = markQueueLayer(
        decorateQueue(inner, {
            on,
            start,
            stop,
            isRunning: () => running,
            isProcessing: () => active > 0,
            activeCount: () => active,
        }),
        WORKER_LAYER,
    )

    return api as unknown as QueueWithWorker<
        T,
        R,
        WorkerQueueEvents<T, R, TEvents>
    > &
        PreserveQueueExtras<TQueue>
}
