import type {
    JsonCodec,
    Queue,
    Router,
    RowStore,
    SnapshotStore,
    WebStorageLike,
    WithWorkerOptions,
    WorkerControls,
    WorkerFn,
} from '@qkitt/queue'

/**
 * Built-in store **adapters** the library can construct for you.
 * Custom backends do not appear here — implement {@link SnapshotStore} or
 * {@link RowStore} and register the instance under `stores`.
 */
export type BuiltinStoreAdapter = 'memory' | 'localStorage' | 'sessionStorage'

/** Shared fields for built-in (library-constructed) store entries. */
type BuiltinStoreDefinitionBase = {
    adapter: BuiltinStoreAdapter
    /**
     * Required when `adapter` is `localStorage` or `sessionStorage`.
     * Snapshot: storage key for the full JSON array.
     * Row: key prefix for order list + per-row keys.
     */
    key?: string
}

/**
 * Named entry in `config.stores`.
 *
 * - **Built-in**: `{ adapter, strategy, key? }` — library creates the store.
 * - **Custom**: `{ strategy, impl }` — your {@link SnapshotStore} / {@link RowStore}.
 *
 * Web adapters accept optional codecs (JS only — not JSON-serializable).
 */
export type StoreDefinition =
    | ({
          strategy: 'snapshot'
          /**
           * JS only — custom JSON codec for the snapshot array.
           * Only used with `localStorage` / `sessionStorage`.
           */
          // Item type is app-specific; config stores stay untyped at this layer.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          codec?: JsonCodec<any[]>
      } & BuiltinStoreDefinitionBase)
    | ({
          strategy: 'row'
          /**
           * JS only — custom JSON codec for each row item.
           * Only used with `localStorage` / `sessionStorage`.
           */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          itemCodec?: JsonCodec<any>
      } & BuiltinStoreDefinitionBase)
    | {
          strategy: 'snapshot'
          /** JS config only — custom snapshot backend. */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          impl: SnapshotStore<any>
      }
    | {
          strategy: 'row'
          /** JS config only — custom row backend. */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          impl: RowStore<any>
      }

/**
 * Queue-level persistence: pick a named store from `config.stores`.
 * Strategy comes from the store definition, not from the queue.
 *
 * Snapshot-only: `autoSave`, `autoSaveDebounceMs`.
 * Row-only: `createId` (JS only).
 */
export type PersistConfig = {
    /** Name of an entry in `config.stores`. */
    store: string
    /**
     * Snapshot stores only: auto-save after mutations.
     * Defaults to `true`. Rejected for row stores.
     */
    autoSave?: boolean
    /**
     * Snapshot stores only: debounce auto-save after mutations (ms).
     * `0` / omitted = one save per microtask; `> 0` waits after the last mutation.
     * Rejected for row stores. Must be a safe integer ≥ 0.
     */
    autoSaveDebounceMs?: number
    /**
     * Row stores only (JS config): custom id factory for new rows.
     * Defaults to core `createId`. Rejected for snapshot stores.
     */
    createId?: () => string
}

/**
 * Worker attachment for a queue (JS config only — functions are not JSON).
 *
 * ```ts
 * import { handleJob } from './workers/job'
 *
 * worker: handleJob
 * // or
 * worker: { run: handleJob, concurrency: 4, autoStart: false }
 * ```
 */
export type WorkerConfig =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | WorkerFn<any, any>
    | ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          run: WorkerFn<any, any>
      } & WithWorkerOptions)

export type QueueConfig = {
    /**
     * Maximum items in the in-memory queue (backpressure).
     * Same semantics as `buildQueue({ maxSize })` — enqueue throws
     * `QueueFullError` when exceeded.
     */
    maxSize?: number
    /** Optional persistence via a named store in `config.stores`. */
    persist?: PersistConfig
    /**
     * JS config only — process items with withWorker.
     * Import the function from your app and pass it here.
     */
    worker?: WorkerConfig
}

export type BindingConfig = {
    /** Topic pattern (`orders.*`, `mail.#`, …). */
    pattern: string
    /** Name of a queue defined under `queues`. */
    queue: string
}

export type RouterConfig = {
    bindings?: BindingConfig[]
    /**
     * Named queue that receives route-message envelopes when a publish
     * matches **no** bindings (unrouted). Must exist under `queues`.
     * The queue is not auto-bound as a pattern — it is only the unmatched sink.
     */
    unmatchedQueue?: string
}

/**
 * Single system config: **stores** (adapters) + **queues** (+ optional router).
 *
 * Prefer a JS/TS module so workers and custom store `impl`s can be imported.
 * A JSON subset (built-in adapters only, no workers) works via
 * {@link parseSystemConfig} / {@link buildFromJson}.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@qkitt/queue-config'
 * import { handleMail } from './workers/mail'
 * import { createRedisRowStore } from './stores/redis'
 *
 * export default defineConfig({
 *   stores: {
 *     mailDb: { adapter: 'localStorage', strategy: 'row', key: 'mail' },
 *     redis: { strategy: 'row', impl: createRedisRowStore() },
 *   },
 *   queues: {
 *     mail: {
 *       persist: { store: 'mailDb' },
 *       worker: { run: handleMail, concurrency: 2 },
 *     },
 *   },
 *   router: {
 *     bindings: [{ pattern: 'mail.#', queue: 'mail' }],
 *     unmatchedQueue: 'unrouted',
 *   },
 * })
 * ```
 */
export type SystemConfig = {
    /**
     * Named store adapters. Queues reference them with `persist.store`.
     * Omit (or `{}`) when no queue uses persistence.
     * Every named store must be referenced by exactly one queue.
     */
    stores?: Record<string, StoreDefinition>
    queues: Record<string, QueueConfig>
    /**
     * When present, a router is created and bindings applied.
     * Use `{}` or `{ bindings: [] }` for an empty router.
     * Optional `unmatchedQueue` parks unrouted publishes.
     */
    router?: RouterConfig
    /**
     * Hydrate all persisted queues after construction (and after workers
     * are attached, so restored items can be processed when autoStart is on).
     * Defaults to `true` when any queue has `persist`.
     */
    hydrate?: boolean
}

/** Build-time options that cannot live in config data. */
export type BuildFromConfigOptions = {
    /**
     * Inject Web Storage (tests, Node, custom backends).
     * Used when a store's `adapter` is `localStorage` or `sessionStorage`.
     */
    storage?: WebStorageLike
    /**
     * Skip re-validation (advanced). Use only when `config` was already
     * returned from {@link defineConfig}, {@link validateJsConfig},
     * {@link validateSystemConfig}, or {@link parseSystemConfig}.
     */
    skipValidate?: boolean
}

/** Resolved store instance after build (custom or built-in). */
export type ResolvedStore<T = unknown> = SnapshotStore<T> | RowStore<T>

/** Persist helpers attached by `withPersist`. */
export type ConfiguredPersistMethods = {
    hydrate: () => Promise<void>
    flush: () => Promise<void>
    /** Snapshot strategy only. */
    persist?: () => Promise<void>
    /** Row strategy only. */
    rowIds?: () => string[]
}

/**
 * Queue surface returned by the config builder.
 * Persist / worker helpers are present only when configured.
 */
export type ConfiguredQueue<T = unknown> = Queue<T> &
    Partial<WorkerControls> &
    Partial<ConfiguredPersistMethods>

/**
 * Precise queue type from a single {@link QueueConfig} entry.
 * Worker and persist method sets become required when those fields are set.
 */
export type ConfiguredQueueFor<
    Q extends QueueConfig,
    T = unknown,
> = Queue<T> &
    (Q extends { worker: WorkerConfig } ? WorkerControls : unknown) &
    (Q extends { persist: PersistConfig } ? ConfiguredPersistMethods : unknown)

export type ConfiguredSystemQueues<
    TConfig extends SystemConfig,
    T = unknown,
> = {
    [K in keyof TConfig['queues']]: ConfiguredQueueFor<
        TConfig['queues'][K],
        T
    >
}

type ConfiguredSystemRouter<TConfig extends SystemConfig> = TConfig extends {
    router: RouterConfig
}
    ? Router
    : Router | undefined

export type ConfiguredSystem<
    TConfig extends SystemConfig = SystemConfig,
    T = unknown,
> = {
    queues: ConfiguredSystemQueues<TConfig, T>
    /**
     * Resolved store instances keyed by `config.stores` names.
     * Empty object when no stores were defined.
     */
    stores: {
        [K in keyof NonNullable<TConfig['stores']>]: ResolvedStore<T>
    } & Record<string, ResolvedStore<T>>
    /**
     * Present when `router` was set in config.
     * Always defined for that case; `undefined` when no router was requested.
     */
    router: ConfiguredSystemRouter<TConfig>
    /** Hydrate every queue that exposes `hydrate`. */
    hydrateAll: () => Promise<void>
    /**
     * Flush every queue that exposes `flush` (drains pending auto-saves /
     * write chains). Does not force a full snapshot write when `autoSave` is
     * false — use {@link persistAll} or per-queue `persist()` for that.
     */
    flushAll: () => Promise<void>
    /**
     * Call `persist()` on every snapshot-persisted queue that exposes it.
     * No-op for row stores and non-persisted queues.
     */
    persistAll: () => Promise<void>
    /**
     * The config used to build this system (nested plain data frozen).
     * Function references (workers, store impls) are preserved.
     */
    config: Readonly<TConfig>
}
