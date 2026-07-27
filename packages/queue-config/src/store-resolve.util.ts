import {
    createMemoryRowStore,
    createWebRowStore,
    StorageUnavailableError,
    type JsonCodec,
    type RowStore,
    type WebStorageLike,
} from '@qkitt/queue'
import { assertWebStorageKey } from './parse.util'
import type {
    BuildFromConfigOptions,
    BuiltinStoreAdapter,
    ResolvedStore,
    StoreDefinition,
} from './types'

type WebAdapter = Exclude<BuiltinStoreAdapter, 'memory'>

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
            throw new StorageUnavailableError(name)
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

const resolveStore = <T>(
    storeName: string,
    definition: StoreDefinition,
    options: BuildFromConfigOptions,
): ResolvedStore<T> => {
    if ('impl' in definition) {
        return definition.impl as ResolvedStore<T>
    }

    const { adapter } = definition

    if (adapter === 'memory') {
        return createMemoryRowStore<T>()
    }

    const key = assertWebStorageKey(
        adapter,
        definition.key,
        `config.stores.${storeName}.key`,
    )
    const storage = resolveWebStorage(adapter, options)
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
