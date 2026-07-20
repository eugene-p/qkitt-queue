import {
    buildQueue,
    buildRouter,
    withRowPersist,
    withSnapshotPersist,
    withWorker,
    type RouteTarget,
    type Router,
    type RowRecord,
    type WithWorkerOptions,
    type WorkerFn,
} from '@qkitt/queue'
import { freezeConfig } from './config-freeze.util'
import { configError } from './errors'
import {
    isRowStore,
    isSnapshotStore,
    resolveAllStores,
} from './store-resolve.util'
import type {
    BuildFromConfigOptions,
    ConfiguredQueue,
    ConfiguredSystem,
    QueueConfig,
    ResolvedStore,
    StoreDefinition,
    SystemConfig,
    WorkerConfig,
} from './types'
import { parseSystemConfig, validateJsConfig } from './validate'

const resolveWorker = (
    worker: WorkerConfig,
): { run: WorkerFn<unknown, unknown>; options: WithWorkerOptions } => {
    if (typeof worker === 'function') {
        return { run: worker, options: {} }
    }
    const { run, concurrency, autoStart } = worker
    return {
        run,
        options: {
            ...(concurrency !== undefined ? { concurrency } : {}),
            ...(autoStart !== undefined ? { autoStart } : {}),
        },
    }
}

/**
 * Bridge a configured queue into the router's minimal {@link RouteTarget}
 * surface. `ConfiguredQueue.enqueue` is typed as `(item: T) => void` while
 * `RouteTarget` expects `RouteMessage`; at runtime router publishes always
 * enqueue envelopes. Kept as an explicit helper so the variance is documented
 * rather than silenced with ad-hoc double casts at call sites.
 */
const asRouteTarget = <T>(queue: ConfiguredQueue<T>): RouteTarget =>
    queue as unknown as RouteTarget

const buildQueueFromConfig = <T>(
    queueName: string,
    queueConfig: QueueConfig,
    storeDefs: Record<string, StoreDefinition> | undefined,
    resolvedStores: Record<string, ResolvedStore<T>>,
): ConfiguredQueue<T> => {
    const buildOptions =
        queueConfig.maxSize !== undefined
            ? { maxSize: queueConfig.maxSize }
            : {}

    let queue: ConfiguredQueue<T> = buildQueue<T>(buildOptions)

    if (queueConfig.persist) {
        const storeName = queueConfig.persist.store
        const definition = storeDefs?.[storeName]
        const store = resolvedStores[storeName]

        if (!definition || !store) {
            return configError(
                'STORE_NOT_FOUND',
                `config.queues.${queueName}.persist.store "${storeName}" is not defined in config.stores`,
                `config.queues.${queueName}.persist.store`,
            )
        }

        if (definition.strategy === 'snapshot') {
            if (!isSnapshotStore(store)) {
                return configError(
                    'INVALID_IMPL',
                    `config.stores.${storeName} is not a SnapshotStore`,
                    `config.stores.${storeName}`,
                )
            }
            queue = withSnapshotPersist(queue, store, {
                autoSave: queueConfig.persist.autoSave,
                autoSaveDebounceMs: queueConfig.persist.autoSaveDebounceMs,
            })
        } else {
            if (!isRowStore(store)) {
                return configError(
                    'INVALID_IMPL',
                    `config.stores.${storeName} is not a RowStore`,
                    `config.stores.${storeName}`,
                )
            }
            queue = withRowPersist(
                buildQueue<RowRecord<T>>(buildOptions),
                store,
            )
        }
    }

    if (queueConfig.worker) {
        const { run, options: workerOptions } = resolveWorker(queueConfig.worker)
        queue = withWorker(queue, run as WorkerFn<T, unknown>, workerOptions)
    }

    return queue
}

const buildQueues = <TConfig extends SystemConfig, T>(
    validated: SystemConfig,
    resolvedStores: Record<string, ResolvedStore<T>>,
): ConfiguredSystem<TConfig, T>['queues'] => {
    const queues = {} as ConfiguredSystem<TConfig, T>['queues']

    for (const [name, queueConfig] of Object.entries(validated.queues)) {
        ;(queues as Record<string, ConfiguredQueue<T>>)[name] =
            buildQueueFromConfig(
                name,
                queueConfig,
                validated.stores,
                resolvedStores,
            )
    }

    return queues
}

const buildConfiguredRouter = <T>(
    routerConfig: NonNullable<SystemConfig['router']>,
    queues: Record<string, ConfiguredQueue<T>>,
): Router => {
    let unmatchedTarget: RouteTarget | undefined

    if (routerConfig.unmatchedQueue !== undefined) {
        const sink = queues[routerConfig.unmatchedQueue]
        if (!sink) {
            return configError(
                'UNKNOWN_QUEUE',
                `router unmatchedQueue "${routerConfig.unmatchedQueue}" is not defined`,
                'config.router.unmatchedQueue',
            )
        }
        unmatchedTarget = asRouteTarget(sink)
    }

    const built = buildRouter(
        unmatchedTarget !== undefined ? { unmatchedTarget } : {},
    )
    for (const binding of routerConfig.bindings ?? []) {
        const target = queues[binding.queue]
        if (!target) {
            return configError(
                'UNKNOWN_QUEUE',
                `router binding queue "${binding.queue}" is not defined`,
                'config.router.bindings',
            )
        }
        built.bind(binding.pattern, asRouteTarget(target))
    }
    return built
}

type QueueLifecycleMethod = 'hydrate' | 'flush'

/** Run a lifecycle method on every queue that exposes it. */
const runOnQueues = async <T>(
    queues: Record<string, ConfiguredQueue<T>>,
    method: QueueLifecycleMethod,
): Promise<void> => {
    const tasks: Promise<void>[] = []
    for (const queue of Object.values(queues)) {
        const fn = queue[method]
        if (typeof fn === 'function') {
            tasks.push(fn.call(queue))
        }
    }
    await Promise.all(tasks)
}

const createSystemLifecycle = <T>(
    queues: Record<string, ConfiguredQueue<T>>,
): {
    hydrateAll: () => Promise<void>
    flushAll: () => Promise<void>
} => ({
    hydrateAll: () => runOnQueues(queues, 'hydrate'),
    flushAll: () => runOnQueues(queues, 'flush'),
})

/**
 * Build named stores, queues, optional workers, and an optional topic router
 * from a single {@link SystemConfig}.
 *
 * ```ts
 * const config = defineConfig({
 *   stores: {
 *     jobsDb: { adapter: 'memory', strategy: 'row' },
 *     redis: { strategy: 'row', impl: createRedisRowStore() },
 *   },
 *   queues: {
 *     jobs: {
 *       persist: { store: 'jobsDb' },
 *       worker: { run: handleJob, concurrency: 2 },
 *     },
 *   },
 *   router: { bindings: [{ pattern: 'jobs.#', queue: 'jobs' }] },
 * })
 *
 * const system = await buildFromConfig(config)
 * ```
 *
 * Order: resolve stores → queue → persist → worker → router bind → hydrate.
 */
export const buildFromConfig = async <
    TConfig extends SystemConfig,
    T = unknown,
>(
    config: TConfig,
    options: BuildFromConfigOptions = {},
): Promise<ConfiguredSystem<TConfig, T>> => {
    const validated = validateJsConfig(config)

    const resolvedStores = resolveAllStores<T>(validated.stores, options)
    const queues = buildQueues<TConfig, T>(validated, resolvedStores)

    const queueMap = queues as Record<string, ConfiguredQueue<T>>
    const router = validated.router
        ? buildConfiguredRouter(validated.router, queueMap)
        : undefined

    const { hydrateAll, flushAll } = createSystemLifecycle(queueMap)

    const shouldHydrate =
        validated.hydrate ??
        Object.values(validated.queues).some((q) => q.persist !== undefined)

    if (shouldHydrate) {
        await hydrateAll()
    }

    return {
        queues,
        stores: resolvedStores as ConfiguredSystem<TConfig, T>['stores'],
        router: router as ConfiguredSystem<TConfig, T>['router'],
        hydrateAll,
        flushAll,
        config: freezeConfig(validated),
    } satisfies ConfiguredSystem<TConfig, T>
}

/**
 * Parse **data-only** JSON, validate, and build the system.
 * Workers / custom store `impl` cannot appear in JSON — use a JS module and
 * {@link buildFromConfig} instead.
 */
export const buildFromJson = async <T = unknown>(
    json: string,
    options: BuildFromConfigOptions = {},
): Promise<ConfiguredSystem<SystemConfig, T>> => {
    const parsed = parseSystemConfig(json)
    return buildFromConfig(parsed, options)
}
