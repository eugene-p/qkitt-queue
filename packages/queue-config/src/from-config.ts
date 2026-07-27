import {
    buildQueue,
    buildRouter,
    withDlq,
    withLoop,
    withWorker,
    type RouteTarget,
    type Router,
    type WithDeadLetterOptions,
    type WithLoopOptions,
    type WithWorkerOptions,
    type WorkerFn,
} from '@qkitt/queue'
import { freezeConfig } from './config-freeze.util'
import { configError } from './errors'
import { resolveAllStores } from './store-resolve.util'
import type {
    BuildFromConfigOptions,
    ConfiguredQueue,
    ConfiguredSystem,
    DlqConfig,
    LoopConfig,
    QueueConfig,
    ResolvedStore,
    SystemConfig,
    WorkerConfig,
} from './types'
import { parseSystemConfig, validateJsConfig } from './validate'
import { dlqTargetName } from './validate/queue'

const resolveWorker = <T>(
    worker: WorkerConfig,
): { run: WorkerFn<T, unknown>; options: WithWorkerOptions<T> } => {
    if (typeof worker === 'function') {
        return { run: worker as WorkerFn<T, unknown>, options: {} }
    }
    const { run, concurrency, autoStart, onFailure } = worker
    return {
        run: run as WorkerFn<T, unknown>,
        options: {
            ...(concurrency !== undefined ? { concurrency } : {}),
            ...(autoStart !== undefined ? { autoStart } : {}),
            ...(onFailure !== undefined
                ? { onFailure: onFailure as WithWorkerOptions<T>['onFailure'] }
                : {}),
        },
    }
}

const asRouteTarget = <T>(queue: ConfiguredQueue<T>): RouteTarget =>
    queue as unknown as RouteTarget

const resolveLoopOptions = <T>(loop: LoopConfig): WithLoopOptions<T, T> => {
    if (loop === true) return {}
    return {
        ...(loop.map !== undefined ? { map: loop.map } : {}),
        ...(loop.filter !== undefined ? { filter: loop.filter } : {}),
        ...(loop.delay !== undefined ? { delay: loop.delay } : {}),
    }
}

const resolveDlqOptions = <T>(
    dlq: DlqConfig,
): WithDeadLetterOptions<T, T> => {
    if (typeof dlq === 'string') return {}
    return {
        ...(dlq.map !== undefined ? { map: dlq.map } : {}),
        ...(dlq.filter !== undefined ? { filter: dlq.filter } : {}),
    }
}

/**
 * Build one queue: `buildQueue({ store? })` → worker → loop.
 * Dead-letter is applied in a second pass so targets can resolve.
 */
const buildQueueFromConfig = <T>(
    queueName: string,
    queueConfig: QueueConfig,
    storeDefs: Record<string, unknown> | undefined,
    resolvedStores: Record<string, ResolvedStore<T>>,
): ConfiguredQueue<T> => {
    const buildOptions: {
        name: string
        maxSize?: number
        store?: ResolvedStore<T>
        leaseTtlMs?: number
    } = {
        name: queueName,
    }
    if (queueConfig.maxSize !== undefined) {
        buildOptions.maxSize = queueConfig.maxSize
    }

    if (queueConfig.persist) {
        const storeName = queueConfig.persist.store
        const store = resolvedStores[storeName]
        if (!storeDefs?.[storeName] || !store) {
            return configError(
                'STORE_NOT_FOUND',
                `config.queues.${queueName}.persist.store "${storeName}" is not defined in config.stores`,
                `config.queues.${queueName}.persist.store`,
            )
        }
        buildOptions.store = store
        if (queueConfig.persist.leaseTtlMs !== undefined) {
            buildOptions.leaseTtlMs = queueConfig.persist.leaseTtlMs
        }
    }

    let queue = buildQueue<T>(buildOptions) as ConfiguredQueue<T>

    if (queueConfig.worker) {
        const { run, options: workerOptions } = resolveWorker<T>(
            queueConfig.worker,
        )
        queue = withWorker(queue, run, workerOptions)
    }

    if (queueConfig.loop !== undefined) {
        queue = withLoop(
            queue as never,
            resolveLoopOptions(queueConfig.loop),
        ) as ConfiguredQueue<T>
    }

    return queue
}

const applyDlqLayers = <T>(
    validated: SystemConfig,
    queues: Record<string, ConfiguredQueue<T>>,
): void => {
    for (const [name, queueConfig] of Object.entries(validated.queues)) {
        if (queueConfig.dlq === undefined) continue

        const targetName = dlqTargetName(queueConfig.dlq)
        const source = queues[name]
        const target = queues[targetName]
        if (!source || !target) {
            return configError(
                'UNKNOWN_QUEUE',
                `config.queues.${name}.dlq "${targetName}" is not defined in config.queues`,
                typeof queueConfig.dlq === 'string'
                    ? `config.queues.${name}.dlq`
                    : `config.queues.${name}.dlq.queue`,
            )
        }

        queues[name] = withDlq(
            source as never,
            target,
            resolveDlqOptions(queueConfig.dlq),
        ) as ConfiguredQueue<T>
    }
}

const buildQueues = <TConfig extends SystemConfig, T>(
    validated: SystemConfig,
    resolvedStores: Record<string, ResolvedStore<T>>,
): ConfiguredSystem<TConfig, T>['queues'] => {
    const queues = {} as ConfiguredSystem<TConfig, T>['queues']
    const queueMap = queues as Record<string, ConfiguredQueue<T>>

    for (const [name, queueConfig] of Object.entries(validated.queues)) {
        queueMap[name] = buildQueueFromConfig(
            name,
            queueConfig,
            validated.stores,
            resolvedStores,
        )
    }

    applyDlqLayers(validated, queueMap)

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

const runOnQueues = async <T>(
    queues: Record<string, ConfiguredQueue<T>>,
    method: 'hydrate' | 'flush',
): Promise<void> => {
    const tasks: Promise<void>[] = []
    for (const queue of Object.values(queues)) {
        const fn = queue[method]
        if (typeof fn === 'function') {
            tasks.push(Promise.resolve(fn.call(queue)))
        }
    }
    await Promise.all(tasks)
}

/**
 * Build queues (and optional router) from a system config.
 */
export const buildFromConfig = <TConfig extends SystemConfig, T = unknown>(
    config: TConfig,
    options: BuildFromConfigOptions = {},
): ConfiguredSystem<TConfig, T> => {
    const validated = options.skipValidate
        ? config
        : validateJsConfig(config)

    const resolvedStores = resolveAllStores<T>(validated.stores, options)
    const queues = buildQueues<TConfig, T>(validated, resolvedStores)
    const queueMap = queues as Record<string, ConfiguredQueue<T>>

    const router =
        validated.router !== undefined
            ? buildConfiguredRouter(validated.router, queueMap)
            : undefined

    return {
        queues,
        stores: resolvedStores as ConfiguredSystem<TConfig, T>['stores'],
        router: router as ConfiguredSystem<TConfig, T>['router'],
        hydrateAll: () => runOnQueues(queueMap, 'hydrate'),
        flushAll: () => runOnQueues(queueMap, 'flush'),
        config: freezeConfig(validated) as Readonly<TConfig>,
    }
}

export const buildFromConfigSync = buildFromConfig

export const buildFromJson = <T = unknown>(
    json: string,
    options?: BuildFromConfigOptions,
): ConfiguredSystem<SystemConfig, T> => {
    const config = parseSystemConfig(json)
    return buildFromConfig(config, options)
}

export const defineConfig = <TConfig extends SystemConfig>(
    config: TConfig,
): TConfig => validateJsConfig(config) as TConfig
