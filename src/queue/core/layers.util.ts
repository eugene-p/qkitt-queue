/**
 * Decorator layer brands for composition guards.
 * Uses `Symbol.for` so checks remain valid across duplicate package copies.
 */

export const WORKER_LAYER = Symbol.for('qkitt:worker-layer')
export const PERSIST_LAYER = Symbol.for('qkitt:persist-layer')

export type QueueLayerBrand = typeof WORKER_LAYER | typeof PERSIST_LAYER

/** Non-enumerable brand on a queue decorator object (idempotent). */
export const markQueueLayer = <T extends object>(
    queue: T,
    layer: QueueLayerBrand,
): T => {
    if (hasQueueLayer(queue, layer)) return queue
    Object.defineProperty(queue, layer, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    })
    return queue
}

export const hasQueueLayer = (
    queue: object,
    layer: QueueLayerBrand,
): boolean => (queue as Record<symbol, unknown>)[layer] === true

/** Copy known layer brands from an inner queue onto an outer decorator object. */
export const copyQueueLayers = <T extends object>(
    from: object,
    to: T,
): T => {
    if (hasQueueLayer(from, WORKER_LAYER)) {
        markQueueLayer(to, WORKER_LAYER)
    }
    if (hasQueueLayer(from, PERSIST_LAYER)) {
        markQueueLayer(to, PERSIST_LAYER)
    }
    return to
}
