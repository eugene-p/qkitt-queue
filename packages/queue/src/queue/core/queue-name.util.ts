/**
 * Non-enumerable logical name brand on queues built with `buildQueue({ name })`.
 * Survives `decorateQueue` via the prototype chain (same pattern as maxSize).
 */

const QUEUE_NAME = Symbol.for('qkitt:queue-name')

/** Stamp a non-empty logical name on a queue object (called by `buildQueue`). */
export const markQueueName = <T extends object>(
    queue: T,
    name: string | undefined,
): T => {
    if (name === undefined) return queue
    Object.defineProperty(queue, QUEUE_NAME, {
        value: name,
        enumerable: false,
        configurable: false,
        writable: false,
    })
    return queue
}

/**
 * Read the logical name a queue was built with (`undefined` if unnamed).
 * Walks the decorator prototype chain.
 */
export const getQueueName = (queue: object): string | undefined =>
    (queue as Record<symbol, unknown>)[QUEUE_NAME] as string | undefined
