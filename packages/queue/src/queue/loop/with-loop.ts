import type { EventCallback, EventMap, MergeEventMaps } from '../../events'
import { InvalidQueueCompositionError } from '../../persist/errors'
import {
    decorateQueue,
    type PreserveQueueExtras,
} from '../core/forward.util'
import {
    hasQueueLayer,
    LOOP_LAYER,
    markQueueLayer,
    WORKER_LAYER,
} from '../core/layers.util'
import type { QueueEvents } from '../core/queue'
import { getQueueName } from '../core/queue-name.util'
import type { QueueWithWorker, WorkerEvents } from '../worker/with-worker'
import {
    getLoopHops,
    QKITT_QUEUE_KEY,
    queueMetaEqual,
    readMappedQueueMeta,
    stampLoopHops,
} from './hop-meta.util'

export type LoopMapContext = {
    /** Logical queue key from {@link import('../core/queue').buildQueue} `name`. */
    name: string
    /** Hop count on the original item, if any. */
    previousHops: number | undefined
    /** Hop count that will be stamped after map (previous + 1, or 1). */
    hops: number
}

export type WithLoopOptions<T, U = T> = {
    /**
     * Remap the **original** failed item before re-enqueue.
     * Receives hop context; library always re-stamps {@link QKITT_QUEUE_KEY}.
     * If the result changes `__qkittQueue` vs the original, emits
     * `loop:meta-override` and overwrites with the library stamp.
     */
    map?: (item: T, error: unknown, ctx: LoopMapContext) => U
    /** Skip re-enqueue when false. Default: always re-enqueue. */
    filter?: (item: T, error: unknown, ctx: LoopMapContext) => boolean
}

export type LoopEvents<T, U = T> = {
    /** Fired after a successful re-enqueue onto the same queue. */
    'loop:enqueued': { item: T; error: unknown; loopItem: U }
    /**
     * Fired when user `map` changed `__qkittQueue` vs the original.
     * Library still re-stamps and re-enqueues.
     */
    'loop:meta-override': {
        item: T
        error: unknown
        name: string
        attempted: unknown
        applied: { hops: number }
    }
    /**
     * Fired when `filter`, `map`, or re-enqueue throws.
     * {@link LoopEnqueueError} wraps the original failure as `cause`.
     */
    'loop:error': { item: T; error: unknown; cause: LoopEnqueueError }
}

export type LoopQueueEvents<
    T,
    U,
    TEvents extends EventMap,
    R = unknown,
> = MergeEventMaps<
    MergeEventMaps<TEvents, WorkerEvents<T, R>>,
    LoopEvents<T, U>
>

/** Thrown when the queue is unnamed or loop options are invalid. */
export class InvalidLoopOptionError extends Error {
    override readonly name = 'InvalidLoopOptionError'

    constructor(message: string) {
        super(message)
    }
}

/** Emitted via `loop:error` when loop map/enqueue fails. */
export class LoopEnqueueError extends Error {
    override readonly name = 'LoopEnqueueError'
    override readonly cause: unknown
    readonly item: unknown
    readonly workerError: unknown

    constructor(
        message: string,
        options: { cause: unknown; item: unknown; workerError: unknown },
    ) {
        super(message, { cause: options.cause })
        this.cause = options.cause
        this.item = options.item
        this.workerError = options.workerError
    }
}

/**
 * On `worker:failed`, re-enqueue onto the **same** worker queue (failure loop).
 *
 * Requires a named queue: `buildQueue({ name: 'jobs' })`. Hop meta lives under
 * `item.__qkittQueue.loop[name].hops` (see {@link getLoopHops}).
 * Optional `map` runs on the **original** item with hop context; the library
 * always re-stamps `__qkittQueue`. If map changes that bag, emits
 * `loop:meta-override` and overwrites.
 *
 * Non-plain payloads become `{ value, __qkittQueue: { loop: { [name]: { hops } } } }`.
 *
 * **Not a dead letter.** For a separate sink use
 * {@link import('../dlq/with-dead-letter').withDeadLetter}.
 *
 * **Composition:** `withLoop(withWorker(buildQueue({ name: 'jobs' }), run))`.
 *
 * A always-failing worker can spin forever — use `filter` on hops, or stop the worker.
 *
 * @throws {InvalidQueueCompositionError} if `queue` has no worker layer
 * @throws {InvalidLoopOptionError} if the queue has no {@link import('../core/queue').BuildQueueOptions.name}
 */
export const withLoop = <
    T,
    R = unknown,
    TEvents extends EventMap = QueueEvents<T>,
    TQueue extends QueueWithWorker<T, R, TEvents> = QueueWithWorker<
        T,
        R,
        TEvents
    >,
    U = T,
>(
    queue: TQueue & QueueWithWorker<T, R, TEvents>,
    options: WithLoopOptions<T, U> = {},
): QueueWithWorker<T, R, LoopQueueEvents<T, U, TEvents, R>> &
    PreserveQueueExtras<TQueue> => {
    if (!hasQueueLayer(queue, WORKER_LAYER)) {
        throw new InvalidQueueCompositionError(
            'withLoop requires a worker layer; compose withWorker first',
        )
    }

    const name = getQueueName(queue)
    if (name === undefined) {
        throw new InvalidLoopOptionError(
            'withLoop requires a named queue; pass name to buildQueue({ name: "..." })',
        )
    }

    const userMap = options.map
    const filter = options.filter ?? (() => true)

    const inner = queue
    const emitInner = inner.emit as (
        eventName: string,
        data: unknown,
    ) => void
    const onInner = inner.on as (
        eventName: string,
        callback: EventCallback<unknown>,
    ) => () => void

    onInner('worker:failed', (payload) => {
        const { item, error } = payload as { item: T; error: unknown }
        try {
            const previousHops = getLoopHops(item, name)
            const hops = (previousHops ?? 0) + 1
            const ctx: LoopMapContext = { name, previousHops, hops }

            if (!filter(item, error, ctx)) return

            const mapped: unknown = userMap
                ? userMap(item, error, ctx)
                : item

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

            const loopItem = stampLoopHops(mapped, item, name, hops) as U
            inner.enqueue(loopItem as unknown as T)
            emitInner('loop:enqueued', { item, error, loopItem })
        } catch (cause) {
            const wrapped = new LoopEnqueueError(
                'withLoop: failed to re-enqueue item',
                { cause, item, workerError: error },
            )
            emitInner('loop:error', { item, error, cause: wrapped })
        }
    })

    const api = markQueueLayer(decorateQueue(inner, {}), LOOP_LAYER)

    return api as unknown as QueueWithWorker<
        T,
        R,
        LoopQueueEvents<T, U, TEvents, R>
    > &
        PreserveQueueExtras<TQueue>
}

const isPlainQueueMeta = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(item, QKITT_QUEUE_KEY)) {
        return undefined
    }
    return (item as Record<string, unknown>)[QKITT_QUEUE_KEY]
}

export { getLoopHops, QKITT_QUEUE_KEY }
