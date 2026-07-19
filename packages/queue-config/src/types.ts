import type {
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

/**
 * @deprecated Use {@link BuiltinStoreAdapter}. Kept as an alias.
 */
export type StoreKind = BuiltinStoreAdapter

/** Shared fields for built-in (library-constructed) store entries. */
type BuiltinStoreDefinition = {
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
 */
export type StoreDefinition =
    | ({ strategy: 'snapshot' } & BuiltinStoreDefinition)
    | ({ strategy: 'row' } & BuiltinStoreDefinition)
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
 */
export type PersistConfig = {
    /** Name of an entry in `config.stores`. */
    store: string
    /**
     * Snapshot stores only: auto-save after mutations.
     * Defaults to `true`. Ignored for row stores.
     */
    autoSave?: boolean
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
}

/** Resolved store instance after build (custom or built-in). */
export type ResolvedStore<T = unknown> = SnapshotStore<T> | RowStore<T>

/**
 * Queue surface returned by the config builder.
 * Persist / worker helpers are present only when configured.
 */
export type ConfiguredQueue<T = unknown> = Queue<T> &
    Partial<WorkerControls> & {
        hydrate?: () => Promise<void>
        persist?: () => Promise<void>
        flush?: () => Promise<void>
        rowIds?: () => string[]
    }

export type ConfiguredSystem<
    TConfig extends SystemConfig = SystemConfig,
    T = unknown,
> = {
    queues: { [K in keyof TConfig['queues']]: ConfiguredQueue<T> }
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
    router: TConfig extends { router: RouterConfig } ? Router : Router | undefined
    /** Hydrate every queue that exposes `hydrate`. */
    hydrateAll: () => Promise<void>
    /** Flush every queue that exposes `flush`. */
    flushAll: () => Promise<void>
    /**
     * The config used to build this system (nested plain data frozen).
     * Function references (workers, store impls) are preserved.
     */
    config: Readonly<TConfig>
}
