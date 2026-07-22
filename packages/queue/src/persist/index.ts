export type {
    QueueWithPersist,
    RowPersistEvents,
    RowRecord,
    RowStore,
    SnapshotPersistEvents,
    SnapshotStore,
} from './contracts'

export { withPersist } from './with-persist'

export { QueueHydratingError } from './hydrate-gate.util'

export { isRowStore, isSnapshotStore } from './store-guards.util'

export {
    createMemoryRowStore,
    createMemorySnapshotStore,
    type MemoryRowStore,
    type MemorySnapshotStore,
} from './stores/memory'

export {
    createLocalStorageRowStore,
    createLocalStorageSnapshotStore,
    createSessionStorageRowStore,
    createSessionStorageSnapshotStore,
    createWebRowStore,
    createWebSnapshotStore,
    StorageCodecError,
    type JsonCodec,
    type WebRowStoreOptions,
    type WebSnapshotStoreOptions,
    type WebStorageLike,
} from './stores/web-storage'
