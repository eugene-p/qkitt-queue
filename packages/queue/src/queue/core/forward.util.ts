import type { EventMap } from '../../events'
import { copyQueueLayers } from './layers.util'
import type { Queue } from './queue'

/**
 * Build a queue decorator surface via prototypical inheritance: `overrides`
 * shadow `inner`, and all other methods fall through to `inner` (OCP).
 *
 * Queue methods rely on closure scope rather than `this`, so prototype
 * fall-through proxies un-overridden methods without manual forwarding.
 *
 * Non-enumerable layer brands from `inner` are reapplied on the result
 * (`Object.create` does not copy own or inherited symbols).
 */
export const decorateQueue = <
    TInner extends object,
    TOverrides extends object,
>(
    inner: TInner,
    overrides: TOverrides,
): Omit<TInner, keyof TOverrides> & TOverrides => {
    const next = Object.assign(
        Object.create(inner),
        overrides,
    ) as Omit<TInner, keyof TOverrides> & TOverrides
    return copyQueueLayers(inner, next)
}

/** Keys that are part of the core {@link Queue} contract (not decorator extras). */
type QueueCoreKeys = keyof Queue<unknown, EventMap>

/**
 * Preserve non-core methods from an inner queue when typing an outer decorator.
 * e.g. `withWorker(withPersist(...))` keeps `flush` / `hydrate` / `rowIds`.
 */
export type PreserveQueueExtras<TQueue extends object> = Omit<
    TQueue,
    QueueCoreKeys
>