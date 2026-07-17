import {
    createTypedEmit,
    type EventCallback,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { isIntegerInRange } from '../../util/number.util'
import type { WorkerFn } from '../../worker/types'
import { decorateQueue, type PreserveQueueExtras } from '../core/forward.util'
import { markQueueLayer, WORKER_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents } from '../core/queue'
import { QueueHydratingError } from '../persist/hydrate-gate.util'

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

/**
 * Wrap a queue with a worker that dequeues and processes items FIFO-style.
 * Listens for `queue:enqueued` and pumps work up to `concurrency`.
 *
 * **Composition (required when using persist):** worker must be the **outer**
 * decorator so `dequeue` hits the persist override:
 * `withWorker(withRowPersist(buildQueue(), store), worker)` — not the reverse.
 *
 * Inner decorator extras (e.g. `flush` from row/snapshot persist) are preserved
 * at runtime and in the return type via {@link PreserveQueueExtras}.
 *
 * While a stacked persist layer is hydrating, `dequeue` throws
 * {@link QueueHydratingError}; the pump waits for the post-hydrate
 * `queue:enqueued` kick. Any other dequeue failure emits `worker:pump-error`
 * and stops the worker.
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
    const emitWorker = createTypedEmit<WorkerEvents<T, R>>(
        inner.emit as (eventName: string, data: unknown) => void,
    )
    const onQueue = inner.on as <K extends keyof QueueEvents<T>>(
        eventName: K,
        callback: EventCallback<QueueEvents<T>[K]>,
    ) => () => void

    let running = false
    let active = 0

    const processItem = async (item: T): Promise<void> => {
        emitWorker('worker:started', { item })

        try {
            const result = await worker(item)
            emitWorker('worker:completed', { item, result })
        } catch (error) {
            emitWorker('worker:failed', { item, error })
        } finally {
            active -= 1

            if (active === 0 && inner.isEmpty()) {
                emitWorker('worker:idle', undefined)
            }

            pump()
        }
    }

    let unsubscribeEnqueued: (() => void) | undefined

    const subscribeEnqueued = (): void => {
        if (unsubscribeEnqueued) return
        unsubscribeEnqueued = onQueue('queue:enqueued', () => {
            pump()
        })
    }

    const stop = (): void => {
        running = false
        unsubscribeEnqueued?.()
        unsubscribeEnqueued = undefined
    }

    const pump = (): void => {
        try {
            while (running && active < concurrency) {
                const item = inner.dequeue()
                if (item === undefined) break

                active += 1
                void processItem(item)
            }
        } catch (error) {
            // Persist hydrate: wait for post-hydrate restore kick.
            if (error instanceof QueueHydratingError) {
                return
            }
            // Unexpected dequeue failure: surface and stop so it is not silent.
            emitWorker('worker:pump-error', { error })
            stop()
        }
    }

    const start = (): void => {
        if (running) return
        running = true
        subscribeEnqueued()
        pump()
    }

    // Kick the pump when new work arrives (including post-hydrate restore kick).
    subscribeEnqueued()

    if (autoStart) {
        start()
    }

    const api = markQueueLayer(
        decorateQueue(inner, {
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
