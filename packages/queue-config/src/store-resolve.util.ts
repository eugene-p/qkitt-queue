import {
    createMemoryRowStore,
    createMemorySnapshotStore,
    createWebRowStore,
    createWebSnapshotStore,
    type JsonCodec,
    type RowStore,
    type SnapshotStore,
    type WebStorageLike,
} from '@qkitt/queue'
import { configError } from './errors'
import { assertWebStorageKey } from './parse.util'
import type {
    BuildFromConfigOptions,
    BuiltinStoreAdapter,
    ResolvedStore,
    StoreDefinition,
} from './types'

type WebAdapter = Exclude<BuiltinStoreAdapter, 'memory'>

/**
 * Lazy global storage proxy matching core's `lazyGlobalStorage` behavior
 * without importing private helpers. Resolves on first use.
 */
const lazyGlobalStorage = (
    name: 'localStorage' | 'sessionStorage',
): WebStorageLike => {
    let cached: WebStorageLike | undefined
    const resolve = (): WebStorageLike => {
        if (cached) return cached
        const storage = (
            globalThis as unknown as Record<string, WebStorageLike | undefined>
        )[name]
        if (!storage) {
            throw new Error(
                `${name} is not available; pass an explicit \`storage\` option`,
            )
        }
        cached = storage
        return cached
    }
    return {
        getItem: (key) => resolve().getItem(key),
        setItem: (key, value) => resolve().setItem(key, value),
        removeItem: (key) => resolve().removeItem(key),
    }
}

const resolveWebStorage = (
    adapter: WebAdapter,
    options: BuildFromConfigOptions,
): WebStorageLike => options.storage ?? lazyGlobalStorage(adapter)

/**
 * Materialize one store definition into a live SnapshotStore or RowStore.
 * Custom `impl` is used as-is; built-ins are constructed from `adapter`.
 *
 * Resolution is synchronous. If a future adapter needs async init
 * (IndexedDB, network-backed stores), introduce an async path rather than
 * blocking here — {@link resolveAllStores} would need a matching redesign.
 *
 * Store shape was already validated in parse; custom `impl` is trusted here.
 */
const resolveStore = <T>(
    storeName: string,
    definition: StoreDefinition,
    options: BuildFromConfigOptions,
): ResolvedStore<T> => {
    if ('impl' in definition) {
        return definition.impl as ResolvedStore<T>
    }

    const { adapter, strategy } = definition

    if (adapter === 'memory') {
        return strategy === 'snapshot'
            ? createMemorySnapshotStore<T>()
            : createMemoryRowStore<T>()
    }

    const key = assertWebStorageKey(
        adapter,
        definition.key,
        `config.stores.${storeName}.key`,
    )
    const storage = resolveWebStorage(adapter, options)

    if (strategy === 'snapshot') {
        const codec = definition.codec as JsonCodec<T[]> | undefined
        return createWebSnapshotStore<T>({
            key,
            storage,
            ...(codec !== undefined ? { codec } : {}),
        }) as SnapshotStore<T>
    }

    const itemCodec = definition.itemCodec as JsonCodec<T> | undefined
    return createWebRowStore<T>({
        key,
        storage,
        ...(itemCodec !== undefined ? { itemCodec } : {}),
    }) as RowStore<T>
}

export const resolveAllStores = <T>(
    stores: Record<string, StoreDefinition> | undefined,
    options: BuildFromConfigOptions,
): Record<string, ResolvedStore<T>> => {
    const resolved: Record<string, ResolvedStore<T>> = {}
    if (!stores) return resolved

    for (const [name, definition] of Object.entries(stores)) {
        resolved[name] = resolveStore<T>(name, definition, options)
    }
    return resolved
}
