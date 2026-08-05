import type {
    JsonCodec,
    LoopMapContext,
    Queue,
    QueueMetrics,
    Router,
    RowStore,
    WebStorageLike,
    WithWorkerOptions,
    WithObservabilityOptions,
    WithRetryOptions,
    WorkerControls,
    WorkerFn,
} from '@qkitt/queue'

/**
 * Built-in store **adapters** the library can construct for you.
 * Custom backends do not appear here — implement {@link RowStore} and register
 * the instance under `stores`.
 */
export type BuiltinStoreAdapter = 'memory' | 'localStorage' | 'sessionStorage'

/** Shared fields for built-in (library-constructed) store entries. */
type BuiltinStoreDefinitionBase = {
    adapter: BuiltinStoreAdapter
    /**
     * Required when `adapter` is `localStorage` or `sessionStorage`.
     * Key prefix for order list + per-record keys.
     */
    key?: string
}

/**
 * Named entry in `config.stores`.
 *
 * - **Built-in**: `{ adapter: 'localStorage' | 'sessionStorage', key }` (durable Web Storage)
 * - **Custom**: `{ impl }` — your {@link RowStore}
 */
export type StoreDefinition =
    | ({
          /**
           * JS only — custom JSON codec for each row item.
           * Only used with `localStorage` / `sessionStorage`.
           */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          itemCodec?: JsonCodec<any>
      } & BuiltinStoreDefinitionBase)
    | {
          /** JS config only — custom store backend. */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          impl: RowStore<any>
      }

/**
 * Queue-level persistence: pick a named store from `config.stores`.
 * The store is passed to `buildQueue({ store })`.
 */
export type PersistConfig = {
    /** Name of an entry in `config.stores`. */
    store: string
    /** Optional in-process lease TTL (ms). */
    leaseTtlMs?: number
}

/**
 * Worker attachment for a queue (JS config only — functions are not JSON).
 */
export type WorkerConfig =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | WorkerFn<any, any>
    | ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          run: WorkerFn<any, any>
      } & WithWorkerOptions)

/**
 * Same-queue failure re-entry via `withLoop` (requires `worker`).
 * Sets recovery policy to `loop` with optional map/filter/delay.
 */
export type LoopConfig =
    | true
    | {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map?: (item: any, error: unknown, ctx: LoopMapContext) => any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter?: (item: any, error: unknown, ctx: LoopMapContext) => boolean
          delay?: number | ((hops: number) => number)
      }

/**
 * Distinct dead-letter destination via `withDlq` (requires `worker`).
 * Used when recovery policy is `fail` (default).
 */
export type DlqConfig =
    | string
    | {
          queue: string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map?: (item: any, error: unknown) => any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter?: (item: any, error: unknown) => boolean
          maxHandoffAttempts?: number
      }

export type RetryConfig =
    | true
    | {
          maxAttempts?: number
          initialDelayMs?: number
          maxDelayMs?: number
          jitter?: number
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          classify?: NonNullable<WithRetryOptions<any>['classify']>
      }

export type ObservabilityConfig =
    | true
    | {
          onMetrics?: WithObservabilityOptions<unknown>['onMetrics']
          onTrace?: WithObservabilityOptions<unknown>['onTrace']
      }

export type QueueConfig = {
    maxSize?: number
    uniqueJobIds?: boolean
    /** Optional durable store via a named entry in `config.stores`. */
    persist?: PersistConfig
    worker?: WorkerConfig
    loop?: LoopConfig
    dlq?: DlqConfig
    retry?: RetryConfig
    observability?: ObservabilityConfig
}

export type BindingConfig = {
    pattern: string
    queue: string
}

export type RouterConfig = {
    bindings?: BindingConfig[]
    unmatchedQueue?: string
}

export type SystemConfig = {
    stores?: Record<string, StoreDefinition>
    queues: Record<string, QueueConfig>
    router?: RouterConfig
    /**
     * Hydrate all durable queues after construction.
     * Defaults to `true` when any queue has `persist`.
     */
    hydrate?: boolean
}

export type BuildFromConfigOptions = {
    storage?: WebStorageLike
    skipValidate?: boolean
}

export type ResolvedStore<T = unknown> = RowStore<T>

export type ConfiguredPersistMethods = {
    hydrate: () => Promise<void>
    flush: () => Promise<void>
    rowIds: () => number[]
}

export type ConfiguredQueue<T = unknown> = Queue<T> &
    Partial<WorkerControls> &
    Partial<ConfiguredPersistMethods> &
    Partial<{ metrics: () => QueueMetrics }>

export type ConfiguredQueueFor<
    Q extends QueueConfig,
    T = unknown,
> = Queue<T> &
    (Q extends { worker: WorkerConfig } ? WorkerControls : unknown) &
    (Q extends { persist: PersistConfig } ? ConfiguredPersistMethods : unknown) &
    (Q extends { observability: ObservabilityConfig }
        ? { metrics: () => QueueMetrics }
        : unknown)

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
    stores: {
        [K in keyof NonNullable<TConfig['stores']>]: ResolvedStore<T>
    } & Record<string, ResolvedStore<T>>
    router: ConfiguredSystemRouter<TConfig>
    hydrateAll: () => Promise<void>
    flushAll: () => Promise<void>
    config: Readonly<TConfig>
}
