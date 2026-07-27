import type { EventMap, MergeEventMaps } from '../../events'
import { InvalidQueueCompositionError } from '../../persist/errors'
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
import { configureDlqRecovery } from '../worker/recovery.util'

/** Minimal enqueue surface for a dead-letter destination. */
export type DeadLetterTarget<U> = {
    enqueue: (item: U) => void | Promise<void>
}

export type WithDeadLetterOptions<T, U = T> = {
    map?: (item: T, error: unknown) => U
    filter?: (item: T, error: unknown) => boolean
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

export class DeadLetterEnqueueError extends Error {
    override readonly name = 'DeadLetterEnqueueError'
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
 * Register a dead-letter destination used when recovery policy is **`fail`**.
 *
 * Handoff order: durable dest enqueue first, then source `ack`. Handoff
 * failure emits `dlq:error` and loops the source item back with backoff.
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

    if ((source as object) === (deadLetter as object)) {
        throw new InvalidDeadLetterOptionError(
            'withDeadLetter: destination must differ from source; use withLoop for same-queue re-entry',
        )
    }

    configureDlqRecovery(source, {
        target: deadLetter as DeadLetterTarget<unknown>,
        map: options.map as WithDeadLetterOptions<T>['map'],
        filter: options.filter,
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
