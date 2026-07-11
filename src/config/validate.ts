import type {
    BindingConfig,
    PersistConfig,
    QueueConfig,
    RouterConfig,
    StoreDefinition,
    SystemConfig,
    WorkerConfig,
} from './types'
import {
    expectBoolean,
    expectPositiveFinite,
    expectString,
    isPlainObject,
    isRowStoreLike,
    isSnapshotStoreLike,
    parseAdapter,
    parseStrategy,
} from './parse.util'

/**
 * Parse one `config.stores.<name>` entry.
 * Built-in: `{ adapter, strategy, key? }`. Custom: `{ strategy, impl }` (JS only).
 */
const parseStoreDefinition = (
    value: unknown,
    path: string,
    { allowJs }: { allowJs: boolean },
): StoreDefinition => {
    if (!isPlainObject(value)) {
        throw new Error(`${path} must be an object`)
    }

    const strategy = parseStrategy(value.strategy, `${path}.strategy`)

    if (value.impl !== undefined) {
        if (!allowJs) {
            throw new Error(
                `${path}.impl is only valid in JS config (not JSON); implement SnapshotStore/RowStore and pass the instance from a module`,
            )
        }
        if (value.adapter !== undefined) {
            throw new Error(
                `${path} cannot set both "adapter" and "impl"`,
            )
        }
        if (strategy === 'snapshot') {
            if (!isSnapshotStoreLike(value.impl)) {
                throw new Error(
                    `${path}.impl must be a SnapshotStore (load + save)`,
                )
            }
            return {
                strategy: 'snapshot',
                impl: value.impl as Extract<
                    StoreDefinition,
                    { strategy: 'snapshot'; impl: unknown }
                >['impl'],
            }
        }
        if (!isRowStoreLike(value.impl)) {
            throw new Error(
                `${path}.impl must be a RowStore (loadAll + insert + remove + clear)`,
            )
        }
        return {
            strategy: 'row',
            impl: value.impl as Extract<
                StoreDefinition,
                { strategy: 'row'; impl: unknown }
            >['impl'],
        }
    }

    if (value.adapter === undefined) {
        throw new Error(
            `${path} must define "adapter" (built-in) or "impl" (custom store)`,
        )
    }

    const adapter = parseAdapter(value.adapter, `${path}.adapter`)
    const key =
        value.key === undefined
            ? undefined
            : expectString(value.key, `${path}.key`)

    if (
        (adapter === 'localStorage' || adapter === 'sessionStorage') &&
        (key === undefined || key.length === 0)
    ) {
        throw new Error(
            `${path}.key is required when adapter is "${adapter}"`,
        )
    }

    if (strategy === 'snapshot') {
        return {
            strategy: 'snapshot',
            adapter,
            ...(key !== undefined ? { key } : {}),
        }
    }

    return {
        strategy: 'row',
        adapter,
        ...(key !== undefined ? { key } : {}),
    }
}

const parsePersistConfig = (
    value: unknown,
    path: string,
    storeNames: ReadonlySet<string>,
): PersistConfig => {
    if (!isPlainObject(value)) {
        throw new Error(`${path} must be an object`)
    }

    const store = expectString(value.store, `${path}.store`)
    if (!storeNames.has(store)) {
        throw new Error(
            `${path}.store "${store}" is not defined in config.stores`,
        )
    }

    const autoSave =
        value.autoSave === undefined
            ? undefined
            : expectBoolean(value.autoSave, `${path}.autoSave`)

    return {
        store,
        ...(autoSave !== undefined ? { autoSave } : {}),
    }
}

const parseWorkerConfig = (value: unknown, path: string): WorkerConfig => {
    if (typeof value === 'function') {
        return value as WorkerConfig
    }

    if (!isPlainObject(value)) {
        throw new Error(
            `${path} must be a function or { run, concurrency?, autoStart? }`,
        )
    }

    if (typeof value.run !== 'function') {
        throw new Error(`${path}.run must be a function`)
    }

    const concurrency =
        value.concurrency === undefined
            ? undefined
            : expectPositiveFinite(value.concurrency, `${path}.concurrency`)

    const autoStart =
        value.autoStart === undefined
            ? undefined
            : expectBoolean(value.autoStart, `${path}.autoStart`)

    return {
        run: value.run as Extract<WorkerConfig, { run: unknown }>['run'],
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(autoStart !== undefined ? { autoStart } : {}),
    }
}

const parseQueueConfig = (
    value: unknown,
    path: string,
    storeNames: ReadonlySet<string>,
    { allowJs }: { allowJs: boolean },
): QueueConfig => {
    if (!isPlainObject(value)) {
        throw new Error(`${path} must be an object`)
    }

    const queue: QueueConfig = {}

    if (value.maxSize !== undefined) {
        queue.maxSize = expectPositiveFinite(value.maxSize, `${path}.maxSize`)
    }

    if (value.persist !== undefined) {
        queue.persist = parsePersistConfig(
            value.persist,
            `${path}.persist`,
            storeNames,
        )
    }

    if (value.worker !== undefined) {
        if (!allowJs) {
            throw new Error(
                `${path}.worker is only valid in JS config (functions cannot be expressed in JSON)`,
            )
        }
        queue.worker = parseWorkerConfig(value.worker, `${path}.worker`)
    }

    return queue
}

const parseBindingConfig = (value: unknown, path: string): BindingConfig => {
    if (!isPlainObject(value)) {
        throw new Error(`${path} must be an object`)
    }

    return {
        pattern: expectString(value.pattern, `${path}.pattern`),
        queue: expectString(value.queue, `${path}.queue`),
    }
}

const parseRouterConfig = (value: unknown, path: string): RouterConfig => {
    if (!isPlainObject(value)) {
        throw new Error(`${path} must be an object`)
    }

    const router: RouterConfig = {}

    if (value.bindings !== undefined) {
        if (!Array.isArray(value.bindings)) {
            throw new Error(`${path}.bindings must be an array`)
        }
        router.bindings = value.bindings.map((binding, index) =>
            parseBindingConfig(binding, `${path}.bindings[${index}]`),
        )
    }

    if (value.unmatchedQueue !== undefined) {
        router.unmatchedQueue = expectString(
            value.unmatchedQueue,
            `${path}.unmatchedQueue`,
        )
    }

    return router
}

type ParseOptions = {
    /** Allow workers and custom store impls (JS modules). */
    allowJs: boolean
}

const parseSystemConfigValue = (
    value: unknown,
    options: ParseOptions,
): SystemConfig => {
    if (!isPlainObject(value)) {
        throw new Error('config must be an object')
    }

    if (!isPlainObject(value.queues)) {
        throw new Error('config.queues must be an object')
    }

    const queueNames = Object.keys(value.queues)
    if (queueNames.length === 0) {
        throw new Error('config.queues must define at least one queue')
    }

    const stores: Record<string, StoreDefinition> = {}
    if (value.stores !== undefined) {
        if (!isPlainObject(value.stores)) {
            throw new Error('config.stores must be an object')
        }
        for (const name of Object.keys(value.stores)) {
            if (name.length === 0) {
                throw new Error('config.stores keys must be non-empty strings')
            }
            stores[name] = parseStoreDefinition(
                value.stores[name],
                `config.stores.${name}`,
                { allowJs: options.allowJs },
            )
        }
    }

    const storeNames = new Set(Object.keys(stores))

    const queues: Record<string, QueueConfig> = {}
    for (const name of queueNames) {
        if (name.length === 0) {
            throw new Error('config.queues keys must be non-empty strings')
        }
        queues[name] = parseQueueConfig(
            value.queues[name],
            `config.queues.${name}`,
            storeNames,
            { allowJs: options.allowJs },
        )
    }

    const config: SystemConfig = { queues }

    if (Object.keys(stores).length > 0) {
        config.stores = stores
    }

    if (value.router !== undefined) {
        config.router = parseRouterConfig(value.router, 'config.router')
    }

    if (value.hydrate !== undefined) {
        config.hydrate = expectBoolean(value.hydrate, 'config.hydrate')
    }

    if (config.router?.bindings) {
        for (const [index, binding] of config.router.bindings.entries()) {
            if (!(binding.queue in queues)) {
                throw new Error(
                    `config.router.bindings[${index}].queue "${binding.queue}" is not defined in config.queues`,
                )
            }
        }
    }

    if (config.router?.unmatchedQueue !== undefined) {
        if (!(config.router.unmatchedQueue in queues)) {
            throw new Error(
                `config.router.unmatchedQueue "${config.router.unmatchedQueue}" is not defined in config.queues`,
            )
        }
    }

    return config
}

/**
 * Validate an unknown value as **data-only** config (JSON-safe).
 * Rejects `worker` and custom store `impl` (JS-only fields).
 */
export const validateSystemConfig = (value: unknown): SystemConfig =>
    parseSystemConfigValue(value, { allowJs: false })

/**
 * Validate a JS/TS module config, preserving workers and custom store impls.
 * Prefer {@link defineConfig} at the export site for typed inference.
 */
export const validateJsConfig = <TConfig extends SystemConfig>(
    value: TConfig,
): TConfig => parseSystemConfigValue(value, { allowJs: true }) as TConfig

/**
 * Identity helper for typed JS config modules.
 * Validates structure and preserves function / store instance references.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   stores: {
 *     jobs: { adapter: 'memory', strategy: 'row' },
 *   },
 *   queues: {
 *     jobs: {
 *       persist: { store: 'jobs' },
 *       worker: handleJob,
 *     },
 *   },
 * })
 * ```
 */
export const defineConfig = <const TConfig extends SystemConfig>(
    config: TConfig,
): TConfig => validateJsConfig(config)

/**
 * Parse a JSON string into a validated **data-only** {@link SystemConfig}.
 */
export const parseSystemConfig = (json: string): SystemConfig => {
    let parsed: unknown
    try {
        parsed = JSON.parse(json) as unknown
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'invalid JSON'
        throw new Error(`config JSON is invalid: ${message}`)
    }
    return validateSystemConfig(parsed)
}
