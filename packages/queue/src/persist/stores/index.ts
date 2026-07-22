/**
 * Built-in store factories (memory + web storage).
 * Split from `withPersist` so apps that only attach a custom store
 * do not load these implementations.
 */

export {
    createMemoryRowStore,
    createMemorySnapshotStore,
    type MemoryRowStore,
    type MemorySnapshotStore,
} from './memory'

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
} from './web-storage'
