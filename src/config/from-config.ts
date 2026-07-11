import { buildQueue } from '../queue/core/queue'
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
    let queue: ConfiguredQueue<T> = buildQueue<T>(
        queueConfig.maxSize !== undefined
            ? { maxSize: queueConfig.maxSize }
            : {},
    )

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
            queue = withRowPersist(queue, store)
        }
    }

    if (queueConfig.worker) {
        const { run, options: workerOptions } = resolveWorker(queueConfig.worker)
        queue = withWorker(queue, run as WorkerFn<T, unknown>, workerOptions)
    }

    return queue
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

    let router: Router | undefined

    if (validated.router) {
        const queueMap = queues as Record<string, ConfiguredQueue<T>>
        let unmatchedTarget: RouteTarget | undefined

        if (validated.router.unmatchedQueue !== undefined) {
            const sink = queueMap[validated.router.unmatchedQueue]
            if (!sink) {
                throw new Error(
                    `router unmatchedQueue "${validated.router.unmatchedQueue}" is not defined`,
                )
            }
            unmatchedTarget = sink as unknown as RouteTarget
        }

        const built = buildRouter(
            unmatchedTarget !== undefined ? { unmatchedTarget } : {},
        )
        for (const binding of validated.router.bindings ?? []) {
            const target = queueMap[binding.queue]
            if (!target) {
                throw new Error(
                    `router binding queue "${binding.queue}" is not defined`,
                )
            }
            built.bind(binding.pattern, target as unknown as RouteTarget)
        }
        router = built
    }

    const hydrateAll = async (): Promise<void> => {
        const tasks: Promise<void>[] = []
        for (const queue of Object.values(
            queues as Record<string, ConfiguredQueue<T>>,
        )) {
            if (typeof queue.hydrate === 'function') {
                tasks.push(queue.hydrate())
            }
        }
        await Promise.all(tasks)
    }

    const flushAll = async (): Promise<void> => {
        const tasks: Promise<void>[] = []
        for (const queue of Object.values(
            queues as Record<string, ConfiguredQueue<T>>,
        )) {
            if (typeof queue.flush === 'function') {
                tasks.push(queue.flush())
            }
        }
        await Promise.all(tasks)
    }

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
