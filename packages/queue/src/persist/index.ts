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

// Store factories: re-exported for `@qkitt/queue/persist` convenience.
// Runtime lives in separate chunks (`persist/stores/*`) for tree-shaking.
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
