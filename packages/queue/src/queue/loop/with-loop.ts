import type { EventMap, MergeEventMaps } from '../../events'
import { InvalidQueueCompositionError } from '../../persist/errors'
import {
    type DelayPolicy,
    isInvalidStaticDelay,
} from '../../util/delay-policy.util'
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
    configureLoopRecovery,
    type LoopMapContext,
} from '../worker/recovery.util'
import { getLoopHops, QKITT_QUEUE_KEY } from './hop-meta.util'

export type { LoopMapContext }

export type WithLoopOptions<T, U = T> = {
    map?: (item: T, error: unknown, ctx: LoopMapContext) => U
    filter?: (item: T, error: unknown, ctx: LoopMapContext) => boolean
    /**
     * Delay in ms before re-availability after a failure. Number or function of
     * the 1-based hop count. Durable when the queue has a store (row
     * `availableAt`); timers only wake the pump.
     */
    delay?: DelayPolicy
}

export type LoopEvents<T, U = T> = {
    /**
     * @deprecated Prefer `worker:requeued`. Kept for transition; not emitted by
     * the recovery path (worker emits `worker:requeued`).
     */
    'loop:enqueued'?: { item: T; error: unknown; loopItem: U }
    'loop:meta-override': {
        item: T
        error: unknown
        name: string
        attempted: unknown
        applied: { hops: number }
    }
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

export class InvalidLoopOptionError extends Error {
    override readonly name = 'InvalidLoopOptionError'

    constructor(message: string) {
        super(message)
    }
}

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
 * Configure failure recovery to **loop** (durable reschedule) with optional
 * map/filter/delay. Must wrap a worker queue.
 *
 * **Composition:** `withLoop(withWorker(buildQueue({ name: 'jobs' }), run))`.
 *
 * Conflicts with an explicit `onFailure` other than `'loop'` (throws).
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

    if (isInvalidStaticDelay(options.delay)) {
        throw new InvalidLoopOptionError(
            'loop delay must be a finite number >= 0',
        )
    }

    configureLoopRecovery(
        queue,
        {
            map: options.map as WithLoopOptions<T>['map'],
            filter: options.filter as WithLoopOptions<T>['filter'],
            delay: options.delay,
        },
        true,
    )

    const api = markQueueLayer(decorateQueue(queue, {}), LOOP_LAYER)

    return api as unknown as QueueWithWorker<
        T,
        R,
        LoopQueueEvents<T, U, TEvents, R>
    > &
        PreserveQueueExtras<TQueue>
}

export { getLoopHops, QKITT_QUEUE_KEY }
