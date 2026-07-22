/**
 * Non-enumerable maxSize brand on queues built with `buildQueue`.
 * Allows persist strategies to preserve maxSize when building inner queues
 * without changing the public Queue type.
 */

const QUEUE_MAX_SIZE = Symbol.for('qkitt:queue-max-size')

/** Stamp maxSize on a queue object (called by `buildQueue`). */
export const markQueueMaxSize = <T extends object>(
    queue: T,
    maxSize: number | undefined,
): T => {
    if (maxSize === undefined) return queue
    Object.defineProperty(queue, QUEUE_MAX_SIZE, {
        value: maxSize,
        enumerable: false,
        configurable: false,
        writable: false,
    })
    return queue
}

/** Read the maxSize a queue was built with (undefined if unbounded). */
export const getQueueMaxSize = (queue: object): number | undefined =>
    (queue as Record<symbol, unknown>)[QUEUE_MAX_SIZE] as number | undefined
