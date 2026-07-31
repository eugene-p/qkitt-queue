import type { EventMap, MergeEventMaps } from '../../events'
import { InvalidQueueCompositionError } from '../../persist/errors'
import { isIntegerInRange } from '../../util/number.util'
import {
    decorateQueue,
    type PreserveQueueExtras,
} from '../core/forward.util'
import {
    DLQ_LAYER,
    hasQueueLayer,
    markQueueLayer,
    WORKER_LAYER,
} from '../core/layers.util'
import type { QueueEvents } from '../core/queue'
import type { QueueWithWorker, WorkerEvents } from '../worker/with-worker'
import {
    configureDlqRecovery,
    DeadLetterEnqueueError,
} from '../worker/recovery.util'

/** Minimal enqueue surface for a dead-letter destination. */
export type DeadLetterTarget<U> = {
    enqueue: (item: U) => void | Promise<void>
}

export type WithDeadLetterOptions<T, U = T> = {
    map?: (item: T, error: unknown) => U
    filter?: (item: T, error: unknown) => boolean
    /** Total destination enqueue attempts after a worker failure. Defaults to 3. */
    maxHandoffAttempts?: number
}

export type DeadLetterEvents<T, U = T> = {
    'dlq:enqueued': { item: T; error: unknown; deadLetterItem: U }
    'dlq:error': { item: T; error: unknown; cause: unknown }
}

export type DeadLetterQueueEvents<
    T,
    U,
    TEvents extends EventMap,
    R = unknown,
> = MergeEventMaps<
    MergeEventMaps<TEvents, WorkerEvents<T, R>>,
    DeadLetterEvents<T, U>
>

export class InvalidDeadLetterOptionError extends Error {
    override readonly name = 'InvalidDeadLetterOptionError'

    constructor(message: string) {
        super(message)
    }
}

export { DeadLetterEnqueueError } from '../worker/recovery.util'

/**
 * Register a dead-letter destination used when recovery policy is **`fail`**.
 *
 * Handoff order: durable dest enqueue first, then source `ack`. Handoff
 * failure emits `dlq:error` and retries the source item with backoff up to the
 * configured handoff cap, then drops it.
 *
 * **Composition:** `withDeadLetter(withWorker(buildQueue({ store }), run), dlq)`.
 */
export const withDeadLetter = <
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
    source: TQueue & QueueWithWorker<T, R, TEvents>,
    deadLetter: DeadLetterTarget<U>,
    options: WithDeadLetterOptions<T, U> = {},
): QueueWithWorker<T, R, DeadLetterQueueEvents<T, U, TEvents, R>> &
    PreserveQueueExtras<TQueue> => {
    if (!hasQueueLayer(source, WORKER_LAYER)) {
        throw new InvalidQueueCompositionError(
            'withDeadLetter requires a worker layer; compose withWorker first',
        )
    }

    if (hasQueueLayer(source, DLQ_LAYER)) {
        throw new InvalidDeadLetterOptionError(
            'withDeadLetter supports one destination per worker queue',
        )
    }

    if ((source as object) === (deadLetter as object)) {
        throw new InvalidDeadLetterOptionError(
            'withDeadLetter: destination must differ from source; use withLoop for same-queue re-entry',
        )
    }

    const maxHandoffAttempts = options.maxHandoffAttempts ?? 3
    if (!isIntegerInRange(maxHandoffAttempts, 1)) {
        throw new InvalidDeadLetterOptionError(
            'maxHandoffAttempts must be a safe integer >= 1',
        )
    }

    configureDlqRecovery(source, {
        target: deadLetter as DeadLetterTarget<unknown>,
        map: options.map as WithDeadLetterOptions<T>['map'],
        filter: options.filter,
        maxHandoffAttempts,
    })

    const api = markQueueLayer(decorateQueue(source, {}), DLQ_LAYER)

    return api as unknown as QueueWithWorker<
        T,
        R,
        DeadLetterQueueEvents<T, U, TEvents, R>
    > &
        PreserveQueueExtras<TQueue>
}

export const withDlq = withDeadLetter
