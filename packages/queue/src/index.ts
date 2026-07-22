export {
    buildEventEmitter,
    createTypedEmit,
    type EventCallback,
    type EventEmitter,
    type EventMap,
    type MergeEventMaps,
} from './events'

// Persist core (withPersist + strategy runtime) — separate from store factories.
export {
    isRowStore,
    isSnapshotStore,
    QueueHydratingError,
    withPersist,
    type QueueWithPersist,
    type RowPersistEvents,
    type RowRecord,
    type RowStore,
    type SnapshotPersistEvents,
    type SnapshotStore,
} from './persist'

// Built-in stores — own chunks so unused adapters drop from app bundles.
export {
    createMemoryRowStore,
    createMemorySnapshotStore,
    type MemoryRowStore,
    type MemorySnapshotStore,
} from './persist/stores/memory'

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
} from './persist/stores/web-storage'

export {
    buildQueue,
    QueueFullError,
    withWorker,
    type BuildQueueOptions,
    type Queue,
    type QueueEvents,
    type QueueSlot,
    type QueueWithWorker,
    type WithWorkerOptions,
    type WorkerControls,
    type WorkerEvents,
} from './queue'

export {
    buildRouter,
    type Binding,
    type BuildRouterOptions,
    type RouteMessage,
    type RouteTarget,
    type Router,
    type RouterEvents,
    type UnmatchedRecord,
} from './router'

export {
    pipelineWorker,
    pipelineDone,
    PipelineStepError,
    retryWorker,
    RetryExhaustedError,
    type PipelineDone,
    type PipelineStep,
    type PipelineStepContext,
    type PipelineStepObject,
    type RetryOptions,
    type StepFn,
    type WorkerFn,
} from './worker'
