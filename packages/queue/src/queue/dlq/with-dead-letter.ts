import type { EventCallback, EventMap, MergeEventMaps } from '../../events'
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

/** Minimal enqueue surface for a dead-letter destination. */
export type DeadLetterTarget<U> = {
    enqueue: (item: U) => void
}

export type WithDeadLetterOptions<T, U = T> = {
    /** Remap the failed item before enqueue. Default: identity. */
    map?: (item: T, error: unknown) => U
    /** Skip dead-letter enqueue when false. Default: always enqueue. */
    filter?: (item: T, error: unknown) => boolean
}

export type DeadLetterEvents<T, U = T> = {
    /** Fired after a successful dead-letter enqueue. */
    'dlq:enqueued': { item: T; error: unknown; deadLetterItem: U }
    /**
     * Fired when `filter`, `map`, or destination `enqueue` throws.
     * {@link DeadLetterEnqueueError} wraps the original failure as `cause`
     * (often {@link import('../core/queue').QueueFullError}).
     */
    'dlq:error': { item: T; error: unknown; cause: DeadLetterEnqueueError }
}

/**
 * Worker queue events plus dead-letter events. Re-merges {@link WorkerEvents}
 * so they are not lost when the input event map is only inferred as queue events.
 */
export type DeadLetterQueueEvents<
    T,
    U,
    TEvents extends EventMap,
    R = unknown,
> = MergeEventMaps<
    MergeEventMaps<TEvents, WorkerEvents<T, R>>,
    DeadLetterEvents<T, U>
>

/** Thrown when {@link WithDeadLetterOptions} / destination pairing is invalid. */
export class InvalidDeadLetterOptionError extends Error {
    override readonly name = 'InvalidDeadLetterOptionError'

    constructor(message: string) {
        super(message)
    }
}

/** Emitted via `dlq:error` when dead-letter map/enqueue fails. */
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
 * Forward `worker:failed` items to a **distinct** dead-letter destination via `enqueue`.
 *
 * **Composition:** apply after the worker:
 * `withDeadLetter(withWorker(withPersist(buildQueue(), store), run), dlq)`.
 *
 * Destination must not be the same reference as `source`. For same-queue
 * re-entry with hop metadata, use {@link import('../loop/with-loop').withLoop}.
 *
 * Destination `filter` / `map` / `enqueue` failures emit `dlq:error` with
 * {@link DeadLetterEnqueueError} (does not rethrow). A full bounded sink is
 * misconfiguration — size or drain the destination and subscribe to `dlq:error`.
 *
 * Multiple `withDeadLetter` layers each subscribe and forward (multi-destination).
 *
 * @throws {InvalidQueueCompositionError} if `source` has no worker layer
 * @throws {InvalidDeadLetterOptionError} if `source === deadLetter`
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

    // Runtime reference check (types differ: worker queue vs enqueue target).
    if ((source as object) === (deadLetter as object)) {
        throw new InvalidDeadLetterOptionError(
            'withDeadLetter: destination must differ from source; use withLoop for same-queue re-entry',
        )
    }

    const map = options.map ?? ((item: T) => item as unknown as U)
    const filter = options.filter ?? (() => true)

    const inner = source
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
            if (!filter(item, error)) return
            const deadLetterItem = map(item, error)
            deadLetter.enqueue(deadLetterItem)
            emitInner('dlq:enqueued', { item, error, deadLetterItem })
        } catch (cause) {
            const wrapped = new DeadLetterEnqueueError(
                'withDeadLetter: failed to enqueue dead-letter item',
                { cause, item, workerError: error },
            )
            emitInner('dlq:error', { item, error, cause: wrapped })
        }
    })

    const api = markQueueLayer(decorateQueue(inner, {}), DLQ_LAYER)

    return api as unknown as QueueWithWorker<
        T,
        R,
        DeadLetterQueueEvents<T, U, TEvents, R>
    > &
        PreserveQueueExtras<TQueue>
}

/** Short alias for {@link withDeadLetter}. */
export const withDlq = withDeadLetter
