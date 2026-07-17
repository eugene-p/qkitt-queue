import { buildQueue } from '../queue/core/queue'
import type { RowRecord } from '../queue/persist/persist.types'
import { withRowPersist } from '../queue/persist/with-row-persist'
import { withSnapshotPersist } from '../queue/persist/with-snapshot-persist'
import {
    withWorker,
    type WithWorkerOptions,
} from '../queue/worker/with-worker'
import { buildRouter, type RouteTarget, type Router } from '../router'
import type { WorkerFn } from '../worker/types'
import { freezeConfig } from './config-freeze.util'
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
            throw new Error(
                `config.queues.${queueName}.persist.store "${storeName}" is not defined in config.stores`,
            )
        }

        if (definition.strategy === 'snapshot') {
            if (!isSnapshotStore(store)) {
                throw new Error(
                    `config.stores.${storeName} is not a SnapshotStore`,
                )
            }
            queue = withSnapshotPersist(queue, store, {
                autoSave: queueConfig.persist.autoSave,
            })
        } else {
            if (!isRowStore(store)) {
                throw new Error(
                    `config.stores.${storeName} is not a RowStore`,
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
            throw new Error(
                `router unmatchedQueue "${routerConfig.unmatchedQueue}" is not defined`,
            )
        }
        unmatchedTarget = sink as unknown as RouteTarget
    }

    const built = buildRouter(
        unmatchedTarget !== undefined ? { unmatchedTarget } : {},
    )
    for (const binding of routerConfig.bindings ?? []) {
        const target = queues[binding.queue]
        if (!target) {
            throw new Error(
                `router binding queue "${binding.queue}" is not defined`,
            )
        }
        built.bind(binding.pattern, target as unknown as RouteTarget)
    }
    return built
}

const createSystemLifecycle = <T>(
    queues: Record<string, ConfiguredQueue<T>>,
): {
    hydrateAll: () => Promise<void>
    flushAll: () => Promise<void>
} => {
    const hydrateAll = async (): Promise<void> => {
        const tasks: Promise<void>[] = []
        for (const queue of Object.values(queues)) {
            if (typeof queue.hydrate === 'function') {
                tasks.push(queue.hydrate())
            }
        }
        await Promise.all(tasks)
    }

    const flushAll = async (): Promise<void> => {
        const tasks: Promise<void>[] = []
        for (const queue of Object.values(queues)) {
            if (typeof queue.flush === 'function') {
                tasks.push(queue.flush())
            }
        }
        await Promise.all(tasks)
    }

    return { hydrateAll, flushAll }
}

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
        config: freezeConfig(validated as TConfig),
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
    const config = parseSystemConfig(json)
    return buildFromConfig(config, options)
}
