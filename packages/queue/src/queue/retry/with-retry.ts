import type { EventMap, MergeEventMaps } from '../../events'
import { InvalidQueueCompositionError } from '../../persist/errors'
import { isIntegerInRange, isNonNegativeFinite } from '../../util/number.util'
import {
    decorateQueue,
    type PreserveQueueExtras,
} from '../core/forward.util'
import {
    hasQueueLayer,
    markQueueLayer,
    RETRY_LAYER,
    WORKER_LAYER,
} from '../core/layers.util'
import type { QueueEvents } from '../core/queue'
import type { QueueWithWorker, WorkerEvents } from '../worker/with-worker'
import {
    configureRetryRecovery,
    type RetryClassification,
} from '../worker/recovery.util'

export type RetryContext<T> = {
    item: T
    error: unknown
    /** The failed 1-based delivery attempt. */
    attempt: number
}

export type WithRetryOptions<T> = {
    /** Total deliveries, including the first. Defaults to 3. */
    maxAttempts?: number
    /** Delay before the second attempt. Defaults to 1,000 ms. */
    initialDelayMs?: number
    /** Maximum exponential delay. Defaults to 30,000 ms. */
    maxDelayMs?: number
    /** Symmetric random spread from 0 to 1. Defaults to 0.2. */
    jitter?: number
    /** Classify a failure. `fail` skips remaining retries and uses the DLQ path. */
    classify?: (
        ctx: RetryContext<T>,
    ) => RetryClassification | Promise<RetryClassification>
}

export type RetryEvents<T> = {
    'retry:scheduled': {
        item: T
        error: unknown
        attempt: number
        nextAttempt: number
        delayMs: number
    }
    'retry:exhausted': { item: T; error: unknown; attempt: number }
}

export type RetryQueueEvents<
    T,
    TEvents extends EventMap,
    R = unknown,
> = MergeEventMaps<MergeEventMaps<TEvents, WorkerEvents<T, R>>, RetryEvents<T>>

export class InvalidDurableRetryOptionError extends Error {
    override readonly name = 'InvalidDurableRetryOptionError'

    constructor(message: string) {
        super(message)
    }
}

/**
 * Persist failed delivery attempts outside the application payload.
 *
 * Compose after the worker and before/after `withDeadLetter`:
 * `withRetry(withWorker(buildQueue({ store }), run), options)`.
 */
export const withRetry = <
    T,
    R = unknown,
    TEvents extends EventMap = QueueEvents<T>,
    TQueue extends QueueWithWorker<T, R, TEvents> = QueueWithWorker<
        T,
        R,
        TEvents
    >,
>(
    queue: TQueue & QueueWithWorker<T, R, TEvents>,
    options: WithRetryOptions<T> = {},
): QueueWithWorker<T, R, RetryQueueEvents<T, TEvents, R>> &
    PreserveQueueExtras<TQueue> => {
    if (!hasQueueLayer(queue, WORKER_LAYER)) {
        throw new InvalidQueueCompositionError(
            'withRetry requires a worker layer; compose withWorker first',
        )
    }
    if (hasQueueLayer(queue, RETRY_LAYER)) {
        throw new InvalidDurableRetryOptionError(
            'withRetry supports one retry policy per worker queue',
        )
    }

    const maxAttempts = options.maxAttempts ?? 3
    const initialDelayMs = options.initialDelayMs ?? 1_000
    const maxDelayMs = options.maxDelayMs ?? 30_000
    const jitter = options.jitter ?? 0.2

    if (!isIntegerInRange(maxAttempts, 1)) {
        throw new InvalidDurableRetryOptionError(
            'maxAttempts must be a safe integer >= 1',
        )
    }
    if (!isNonNegativeFinite(initialDelayMs)) {
        throw new InvalidDurableRetryOptionError(
            'initialDelayMs must be a finite number >= 0',
        )
    }
    if (!isNonNegativeFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
        throw new InvalidDurableRetryOptionError(
            'maxDelayMs must be a finite number >= initialDelayMs',
        )
    }
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
        throw new InvalidDurableRetryOptionError(
            'jitter must be a finite number from 0 to 1',
        )
    }

    configureRetryRecovery(queue, {
        maxAttempts,
        initialDelayMs,
        maxDelayMs,
        jitter,
        classify: options.classify,
    })

    return markQueueLayer(decorateQueue(queue, {}), RETRY_LAYER) as unknown as QueueWithWorker<
        T,
        R,
        RetryQueueEvents<T, TEvents, R>
    > &
        PreserveQueueExtras<TQueue>
}
