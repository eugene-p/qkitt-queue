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
    DuplicateRowIdError,
    HydrateInProgressError,
    InvalidPersistOptionError,
    InvalidQueueCompositionError,
    InvalidRowIdError,
    InvalidStoreError,
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
    StorageUnavailableError,
    type JsonCodec,
    type WebRowStoreOptions,
    type WebSnapshotStoreOptions,
    type WebStorageLike,
} from './persist/stores/web-storage'

export {
    buildQueue,
    DeadLetterEnqueueError,
    getLoopHops,
    getQueueName,
    InvalidDeadLetterOptionError,
    InvalidLoopOptionError,
    InvalidQueueOptionError,
    InvalidWorkerOptionError,
    LifecycleTimeoutError,
    LoopEnqueueError,
    QKITT_QUEUE_KEY,
    QueueFullError,
    gracefulStop,
    whenIdle,
    withDeadLetter,
    withDlq,
    withLoop,
    withWorker,
    type BuildQueueOptions,
    type DeadLetterEvents,
    type DeadLetterQueueEvents,
    type DeadLetterTarget,
    type GracefulStopable,
    type GracefulStopOptions,
    type IdleWaitable,
    type LoopEvents,
    type LoopMapContext,
    type LoopQueueEvents,
    type Queue,
    type QueueEvents,
    type QueueSlot,
    type QueueWithWorker,
    type WhenIdleOptions,
    type WithDeadLetterOptions,
    type WithLoopOptions,
    type WithWorkerOptions,
    type WorkerControls,
    type WorkerEvents,
} from './queue'

export {
    buildRouter,
    InvalidRoutePatternError,
    InvalidTopicError,
    type Binding,
    type BuildRouterOptions,
    type RouteMessage,
    type RouteTarget,
    type Router,
    type RouterEvents,
    type UnmatchedRecord,
} from './router'

export type { DelayPolicy } from './util/delay-policy.util'

export {
    InvalidPipelineError,
    InvalidRetryOptionError,
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
