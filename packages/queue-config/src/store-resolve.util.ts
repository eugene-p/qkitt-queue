import {
    createLocalStorageRowStore,
    createLocalStorageSnapshotStore,
    createMemoryRowStore,
    createMemorySnapshotStore,
    createSessionStorageRowStore,
    createSessionStorageSnapshotStore,
    createWebRowStore,
    createWebSnapshotStore,
    type RowStore,
    type SnapshotStore,
} from '@qkitt/queue'
import type {
    BuildFromConfigOptions,
    ResolvedStore,
    StoreDefinition,
} from './types'

export const isSnapshotStore = <T>(
    value: SnapshotStore<T> | RowStore<T>,
): value is SnapshotStore<T> =>
    typeof (value as SnapshotStore<T>).load === 'function' &&
    typeof (value as SnapshotStore<T>).save === 'function'

export const isRowStore = <T>(
    value: SnapshotStore<T> | RowStore<T>,
): value is RowStore<T> => {
    const store = value as RowStore<T>
    return (
        typeof store.loadAll === 'function' &&
        typeof store.insert === 'function' &&
        typeof store.remove === 'function' &&
        typeof store.clear === 'function'
    )
}

/** Built-in snapshot store for a validated Web Storage key (not memory). */
const createBuiltinSnapshot = <T>(
    adapter: 'localStorage' | 'sessionStorage',
    key: string,
    options: BuildFromConfigOptions,
): SnapshotStore<T> => {
    if (options.storage) {
        return createWebSnapshotStore<T>({
            key,
            storage: options.storage,
        })
    }

    if (adapter === 'localStorage') {
        return createLocalStorageSnapshotStore<T>(key)
    }

    return createSessionStorageSnapshotStore<T>(key)
}

/** Built-in row store for a validated Web Storage key (not memory). */
const createBuiltinRow = <T>(
    adapter: 'localStorage' | 'sessionStorage',
    key: string,
    options: BuildFromConfigOptions,
): RowStore<T> => {
    if (options.storage) {
        return createWebRowStore<T>({
            key,
            storage: options.storage,
        })
    }

    if (adapter === 'localStorage') {
        return createLocalStorageRowStore<T>(key)
    }

    return createSessionStorageRowStore<T>(key)
}

/**
 * Materialize one store definition into a live SnapshotStore or RowStore.
 * Custom `impl` is used as-is; built-ins are constructed from `adapter`.
 */
export const resolveStore = <T>(
    storeName: string,
    definition: StoreDefinition,
    options: BuildFromConfigOptions,
): ResolvedStore<T> => {
    if ('impl' in definition) {
        const impl = definition.impl as ResolvedStore<T>
        if (definition.strategy === 'snapshot' && !isSnapshotStore(impl)) {
            throw new Error(
                `config.stores.${storeName}.impl must be a SnapshotStore (strategy is "snapshot")`,
            )
        }
        if (definition.strategy === 'row' && !isRowStore(impl)) {
            throw new Error(
                `config.stores.${storeName}.impl must be a RowStore (strategy is "row")`,
            )
        }
        return impl
    }

    const { adapter, strategy } = definition

    if (adapter === 'memory') {
        return strategy === 'snapshot'
            ? createMemorySnapshotStore<T>()
            : createMemoryRowStore<T>()
    }

    const key = definition.key
    if (key === undefined || key.length === 0) {
        throw new Error(
            `config.stores.${storeName}.key is required when adapter is "${adapter}"`,
        )
    }

    if (strategy === 'snapshot') {
        return createBuiltinSnapshot<T>(adapter, key, options)
    }

    return createBuiltinRow<T>(adapter, key, options)
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
