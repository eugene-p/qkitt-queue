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
import { configError } from './errors'
import {
    assertWebStorageKey,
    hasRowStoreShape,
    hasSnapshotStoreShape,
} from './parse.util'
import type {
    BuildFromConfigOptions,
    BuiltinStoreAdapter,
    ResolvedStore,
    StoreDefinition,
} from './types'

export const isSnapshotStore = <T>(
    value: SnapshotStore<T> | RowStore<T>,
): value is SnapshotStore<T> => hasSnapshotStoreShape(value)

export const isRowStore = <T>(
    value: SnapshotStore<T> | RowStore<T>,
): value is RowStore<T> => hasRowStoreShape(value)

type WebAdapter = Exclude<BuiltinStoreAdapter, 'memory'>

type AdapterFactories = {
    snapshot: (key: string, options: BuildFromConfigOptions) => SnapshotStore<unknown>
    row: (key: string, options: BuildFromConfigOptions) => RowStore<unknown>
}

/**
 * Internal registry of built-in adapters.
 * Add a new built-in by extending {@link BuiltinStoreAdapter} and this map —
 * resolution logic stays unchanged.
 */
const WEB_ADAPTER_FACTORIES: Record<WebAdapter, AdapterFactories> = {
    localStorage: {
        snapshot: (key, options) =>
            options.storage
                ? createWebSnapshotStore({ key, storage: options.storage })
                : createLocalStorageSnapshotStore(key),
        row: (key, options) =>
            options.storage
                ? createWebRowStore({ key, storage: options.storage })
                : createLocalStorageRowStore(key),
    },
    sessionStorage: {
        snapshot: (key, options) =>
            options.storage
                ? createWebSnapshotStore({ key, storage: options.storage })
                : createSessionStorageSnapshotStore(key),
        row: (key, options) =>
            options.storage
                ? createWebRowStore({ key, storage: options.storage })
                : createSessionStorageRowStore(key),
    },
}

const MEMORY_FACTORIES = {
    snapshot: <T>() => createMemorySnapshotStore<T>(),
    row: <T>() => createMemoryRowStore<T>(),
} as const

/**
 * Materialize one store definition into a live SnapshotStore or RowStore.
 * Custom `impl` is used as-is; built-ins are constructed from `adapter`.
 *
 * Resolution is synchronous. If a future adapter needs async init
 * (IndexedDB, network-backed stores), introduce an async path rather than
 * blocking here — {@link resolveAllStores} would need a matching redesign.
 */
const resolveStore = <T>(
    storeName: string,
    definition: StoreDefinition,
    options: BuildFromConfigOptions,
): ResolvedStore<T> => {
    if ('impl' in definition) {
        const impl = definition.impl as ResolvedStore<T>
        if (definition.strategy === 'snapshot' && !isSnapshotStore(impl)) {
            return configError(
                'INVALID_IMPL',
                `config.stores.${storeName}.impl must be a SnapshotStore (strategy is "snapshot")`,
                `config.stores.${storeName}.impl`,
            )
        }
        if (definition.strategy === 'row' && !isRowStore(impl)) {
            return configError(
                'INVALID_IMPL',
                `config.stores.${storeName}.impl must be a RowStore (strategy is "row")`,
                `config.stores.${storeName}.impl`,
            )
        }
        return impl
    }

    const { adapter, strategy } = definition

    if (adapter === 'memory') {
        return strategy === 'snapshot'
            ? MEMORY_FACTORIES.snapshot<T>()
            : MEMORY_FACTORIES.row<T>()
    }

    const key = assertWebStorageKey(
        adapter,
        definition.key,
        `config.stores.${storeName}.key`,
    )

    const factories = WEB_ADAPTER_FACTORIES[adapter]
    if (strategy === 'snapshot') {
        return factories.snapshot(key, options) as SnapshotStore<T>
    }
    return factories.row(key, options) as RowStore<T>
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
