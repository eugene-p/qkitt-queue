import type { EventMap } from '../../events'
import { copyQueueLayers } from './layers.util'
import type { Queue } from './queue'

/**
 * Build a queue decorator surface: start from `queue` (keeps stacked extras
 * such as `hydrate` / `flush`), then overlay `extra` (overrides win).
 *
 * Prefer this over re-listing every {@link Queue} method so new base methods
 * and inner-wrapper APIs flow through automatically (OCP).
 *
 * Non-enumerable layer brands from `queue` are reapplied on the result
 * (object spread does not copy non-enumerable symbols).
 */
export const forwardQueue = <
    TQueue extends object,
    TExtra extends object,
>(
    queue: TQueue,
    extra: TExtra,
): Omit<TQueue, keyof TExtra> & TExtra => {
    const next = {
        ...queue,
        ...extra,
    } as Omit<TQueue, keyof TExtra> & TExtra
    return copyQueueLayers(queue, next)
}

/** Keys that are part of the core {@link Queue} contract (not decorator extras). */
export type QueueCoreKeys = keyof Queue<unknown, EventMap>

/**
 * Preserve non-core methods from an inner queue when typing an outer decorator.
 * e.g. `withWorker(withRowPersist(...))` keeps `flush` / `hydrate` / `rowIds`.
 */
export type PreserveQueueExtras<TQueue extends object> = Omit<
    TQueue,
    QueueCoreKeys
>
