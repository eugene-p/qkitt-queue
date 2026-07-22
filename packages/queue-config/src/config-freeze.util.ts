import type {
    BindingConfig,
    PersistConfig,
    QueueConfig,
    RouterConfig,
    StoreDefinition,
    SystemConfig,
    WorkerConfig,
} from './types'
import { isPlainObject } from './parse.util'

/**
 * Freeze a plain nested data object without walking into class instances
 * or function-bearing store implementations.
 */
const freezePlainData = <T extends object>(value: T): Readonly<T> => {
    const copy: Record<string, unknown> = {
        ...(value as Record<string, unknown>),
    }
    for (const [key, nested] of Object.entries(copy)) {
        if (isPlainObject(nested)) {
            copy[key] = freezePlainData(nested)
        }
    }
    return Object.freeze(copy) as Readonly<T>
}

const freezePersist = (persist: PersistConfig): Readonly<PersistConfig> => {
    // Keep createId as a live function reference; freeze the wrapper only.
    return Object.freeze({ ...persist })
}

const freezeWorker = (worker: WorkerConfig): WorkerConfig => {
    if (typeof worker === 'function') {
        return worker
    }
    // Shallow-freeze options; keep `run` as a live function reference.
    return Object.freeze({ ...worker })
}

const freezeQueueConfig = (queue: QueueConfig): Readonly<QueueConfig> => {
    const next: QueueConfig = { ...queue }
    if (queue.persist !== undefined) {
        next.persist = freezePersist(queue.persist)
    }
    if (queue.worker !== undefined) {
        next.worker = freezeWorker(queue.worker)
    }
    return Object.freeze(next)
}

/**
 * Freeze a store definition without deep-freezing `impl` / codecs (live refs).
 */
const freezeStoreDefinition = (
    store: StoreDefinition,
): Readonly<StoreDefinition> => {
    if ('impl' in store) {
        // Copy + freeze wrapper only — do not walk into the store instance
        // (memory stores are plain objects with mutable internal arrays).
        return Object.freeze({ ...store }) as Readonly<StoreDefinition>
    }
    // Builtin defs may hold codec function refs — shallow freeze only.
    if ('codec' in store || 'itemCodec' in store) {
        return Object.freeze({ ...store }) as Readonly<StoreDefinition>
    }
    return freezePlainData(store) as Readonly<StoreDefinition>
}

const freezeBinding = (binding: BindingConfig): Readonly<BindingConfig> =>
    Object.freeze({ ...binding })

const freezeRouter = (router: RouterConfig): Readonly<RouterConfig> => {
    const next: RouterConfig = { ...router }
    if (router.bindings !== undefined) {
        next.bindings = Object.freeze(
            router.bindings.map((b) => freezeBinding(b)),
        ) as BindingConfig[]
    }
    return Object.freeze(next)
}

/**
 * Freeze config so callers cannot reassign fields on the snapshot returned
 * from `buildFromConfig`, while keeping worker / store `impl` references intact.
 *
 * Nested plain data (`persist`, router bindings, builtin store defs) is frozen.
 * Function references and custom store instances are preserved unfrozen.
 */
export const freezeConfig = <TConfig extends SystemConfig>(
    config: TConfig,
): Readonly<TConfig> => {
    const queues: Record<string, QueueConfig> = {}
    for (const [name, queue] of Object.entries(config.queues)) {
        queues[name] = freezeQueueConfig(queue)
    }

    const frozen: Record<string, unknown> = {
        ...config,
        queues: Object.freeze(queues),
    }

    if (config.stores) {
        const stores: Record<string, StoreDefinition> = {}
        for (const [name, store] of Object.entries(config.stores)) {
            stores[name] = freezeStoreDefinition(store)
        }
        frozen.stores = Object.freeze(stores)
    }

    if (config.router) {
        frozen.router = freezeRouter(config.router)
    }

    return Object.freeze(frozen) as Readonly<TConfig>
}
