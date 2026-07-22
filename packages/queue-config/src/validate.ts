import type {
    BindingConfig,
    PersistConfig,
    QueueConfig,
    RouterConfig,
    StoreDefinition,
    SystemConfig,
    WorkerConfig,
} from './types'
import { configError } from './errors'
import {
    assertWebStorageKey,
    expectBoolean,
    expectNonNegativeInteger,
    expectPositiveInteger,
    expectString,
    isJsonCodecLike,
    isPlainObject,
    isRowStoreLike,
    isSnapshotStoreLike,
    parseAdapter,
    parseStrategy,
} from './parse.util'

const expectPlainObject = (
    value: unknown,
    path: string,
): Record<string, unknown> => {
    if (!isPlainObject(value)) {
        return configError('INVALID_TYPE', `${path} must be an object`, path)
    }
    return value
}

/**
 * Parse one `config.stores.<name>` entry.
 * Built-in: `{ adapter, strategy, key? }`. Custom: `{ strategy, impl }` (JS only).
 */
const parseStoreDefinition = (
    value: unknown,
    path: string,
    { allowJs }: { allowJs: boolean },
): StoreDefinition => {
    const obj = expectPlainObject(value, path)
    const strategy = parseStrategy(obj.strategy, `${path}.strategy`)

    if (obj.impl !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.impl is only valid in JS config (not JSON); implement SnapshotStore/RowStore and pass the instance from a module`,
                `${path}.impl`,
            )
        }
        if (obj.adapter !== undefined) {
            return configError(
                'CONFLICTING_FIELDS',
                `${path} cannot set both "adapter" and "impl"`,
                path,
            )
        }
        if (obj.codec !== undefined || obj.itemCodec !== undefined) {
            return configError(
                'CONFLICTING_FIELDS',
                `${path} cannot set codec/itemCodec with custom "impl" (configure the store itself)`,
                path,
            )
        }
        if (strategy === 'snapshot') {
            if (!isSnapshotStoreLike(obj.impl)) {
                return configError(
                    'INVALID_IMPL',
                    `${path}.impl must be a SnapshotStore (load + save)`,
                    `${path}.impl`,
                )
            }
            return {
                strategy: 'snapshot',
                impl: obj.impl as Extract<
                    StoreDefinition,
                    { strategy: 'snapshot'; impl: unknown }
                >['impl'],
            }
        }
        if (!isRowStoreLike(obj.impl)) {
            return configError(
                'INVALID_IMPL',
                `${path}.impl must be a RowStore (loadAll + insert + remove + clear)`,
                `${path}.impl`,
            )
        }
        return {
            strategy: 'row',
            impl: obj.impl as Extract<
                StoreDefinition,
                { strategy: 'row'; impl: unknown }
            >['impl'],
        }
    }

    if (obj.adapter === undefined) {
        return configError(
            'MISSING_FIELD',
            `${path} must define "adapter" (built-in) or "impl" (custom store)`,
            path,
        )
    }

    const adapter = parseAdapter(obj.adapter, `${path}.adapter`)
    const key =
        obj.key === undefined
            ? undefined
            : expectString(obj.key, `${path}.key`)

    if (adapter === 'localStorage' || adapter === 'sessionStorage') {
        assertWebStorageKey(adapter, key, `${path}.key`)
    }

    if (obj.codec !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.codec is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.codec`,
            )
        }
        if (strategy !== 'snapshot') {
            return configError(
                'INVALID_FIELD',
                `${path}.codec is only valid for snapshot stores`,
                `${path}.codec`,
            )
        }
        if (adapter === 'memory') {
            return configError(
                'INVALID_FIELD',
                `${path}.codec is only valid for localStorage / sessionStorage adapters`,
                `${path}.codec`,
            )
        }
        if (!isJsonCodecLike(obj.codec)) {
            return configError(
                'INVALID_TYPE',
                `${path}.codec must be a JsonCodec (serialize + deserialize)`,
                `${path}.codec`,
            )
        }
    }

    if (obj.itemCodec !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.itemCodec is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.itemCodec`,
            )
        }
        if (strategy !== 'row') {
            return configError(
                'INVALID_FIELD',
                `${path}.itemCodec is only valid for row stores`,
                `${path}.itemCodec`,
            )
        }
        if (adapter === 'memory') {
            return configError(
                'INVALID_FIELD',
                `${path}.itemCodec is only valid for localStorage / sessionStorage adapters`,
                `${path}.itemCodec`,
            )
        }
        if (!isJsonCodecLike(obj.itemCodec)) {
            return configError(
                'INVALID_TYPE',
                `${path}.itemCodec must be a JsonCodec (serialize + deserialize)`,
                `${path}.itemCodec`,
            )
        }
    }

    if (strategy === 'snapshot') {
        return {
            strategy: 'snapshot',
            adapter,
            ...(key !== undefined ? { key } : {}),
            ...(obj.codec !== undefined
                ? {
                      codec: obj.codec as Extract<
                          StoreDefinition,
                          { strategy: 'snapshot'; adapter: unknown }
                      >['codec'],
                  }
                : {}),
        }
    }

    return {
        strategy: 'row',
        adapter,
        ...(key !== undefined ? { key } : {}),
        ...(obj.itemCodec !== undefined
            ? {
                  itemCodec: obj.itemCodec as Extract<
                      StoreDefinition,
                      { strategy: 'row'; adapter: unknown }
                  >['itemCodec'],
              }
            : {}),
    }
}

const parsePersistConfig = (
    value: unknown,
    path: string,
    storeNames: ReadonlySet<string>,
    storeStrategies: ReadonlyMap<string, 'snapshot' | 'row'>,
    { allowJs }: { allowJs: boolean },
): PersistConfig => {
    const obj = expectPlainObject(value, path)
    const store = expectString(obj.store, `${path}.store`)
    if (!storeNames.has(store)) {
        return configError(
            'STORE_NOT_FOUND',
            `${path}.store "${store}" is not defined in config.stores`,
            `${path}.store`,
        )
    }

    const strategy = storeStrategies.get(store)!

    const autoSave =
        obj.autoSave === undefined
            ? undefined
            : expectBoolean(obj.autoSave, `${path}.autoSave`)
    const autoSaveDebounceMs =
        obj.autoSaveDebounceMs === undefined
            ? undefined
            : expectNonNegativeInteger(
                  obj.autoSaveDebounceMs,
                  `${path}.autoSaveDebounceMs`,
              )

    if (autoSave !== undefined && strategy === 'row') {
        return configError(
            'INVALID_FIELD',
            `${path}.autoSave is only valid for snapshot stores (store "${store}" uses strategy "row")`,
            `${path}.autoSave`,
        )
    }
    if (autoSaveDebounceMs !== undefined && strategy === 'row') {
        return configError(
            'INVALID_FIELD',
            `${path}.autoSaveDebounceMs is only valid for snapshot stores (store "${store}" uses strategy "row")`,
            `${path}.autoSaveDebounceMs`,
        )
    }

    let createId: (() => string) | undefined
    if (obj.createId !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.createId is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.createId`,
            )
        }
        if (strategy !== 'row') {
            return configError(
                'INVALID_FIELD',
                `${path}.createId is only valid for row stores (store "${store}" uses strategy "snapshot")`,
                `${path}.createId`,
            )
        }
        if (typeof obj.createId !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.createId must be a function`,
                `${path}.createId`,
            )
        }
        createId = obj.createId as () => string
    }

    return {
        store,
        ...(autoSave !== undefined ? { autoSave } : {}),
        ...(autoSaveDebounceMs !== undefined
            ? { autoSaveDebounceMs }
            : {}),
        ...(createId !== undefined ? { createId } : {}),
    }
}

const parseWorkerConfig = (value: unknown, path: string): WorkerConfig => {
    if (typeof value === 'function') {
        return value as WorkerConfig
    }

    if (!isPlainObject(value)) {
        return configError(
            'INVALID_TYPE',
            `${path} must be a function or { run, concurrency?, autoStart? }`,
            path,
        )
    }

    if (typeof value.run !== 'function') {
        return configError(
            'INVALID_TYPE',
            `${path}.run must be a function`,
            `${path}.run`,
        )
    }

    const concurrency =
        value.concurrency === undefined
            ? undefined
            : expectPositiveInteger(value.concurrency, `${path}.concurrency`)

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
    storeStrategies: ReadonlyMap<string, 'snapshot' | 'row'>,
    { allowJs }: { allowJs: boolean },
): QueueConfig => {
    const obj = expectPlainObject(value, path)
    const queue: QueueConfig = {}

    if (obj.maxSize !== undefined) {
        queue.maxSize = expectPositiveInteger(obj.maxSize, `${path}.maxSize`)
    }

    if (obj.persist !== undefined) {
        queue.persist = parsePersistConfig(
            obj.persist,
            `${path}.persist`,
            storeNames,
            storeStrategies,
            { allowJs },
        )
    }

    if (obj.worker !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.worker is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.worker`,
            )
        }
        queue.worker = parseWorkerConfig(obj.worker, `${path}.worker`)
    }

    return queue
}

const parseBindingConfig = (value: unknown, path: string): BindingConfig => {
    const obj = expectPlainObject(value, path)
    return {
        pattern: expectString(obj.pattern, `${path}.pattern`),
        queue: expectString(obj.queue, `${path}.queue`),
    }
}

const parseRouterConfig = (value: unknown, path: string): RouterConfig => {
    const obj = expectPlainObject(value, path)
    const router: RouterConfig = {}

    if (obj.bindings !== undefined) {
        if (!Array.isArray(obj.bindings)) {
            return configError(
                'INVALID_TYPE',
                `${path}.bindings must be an array`,
                `${path}.bindings`,
            )
        }
        router.bindings = obj.bindings.map((binding, index) =>
            parseBindingConfig(binding, `${path}.bindings[${index}]`),
        )
    }

    if (obj.unmatchedQueue !== undefined) {
        router.unmatchedQueue = expectString(
            obj.unmatchedQueue,
            `${path}.unmatchedQueue`,
        )
    }

    return router
}

type ParseOptions = {
    /** Allow workers and custom store impls (JS modules). */
    allowJs: boolean
}

/**
 * Validate and rebuild a clean {@link SystemConfig} (data-only or JS).
 * Used by JSON paths where stripping unknown fields is desirable.
 */
const parseSystemConfigValue = (
    value: unknown,
    options: ParseOptions,
): SystemConfig => {
    const root = expectPlainObject(value, 'config')

    if (!isPlainObject(root.queues)) {
        return configError(
            'INVALID_TYPE',
            'config.queues must be an object',
            'config.queues',
        )
    }

    const queueNames = Object.keys(root.queues)
    if (queueNames.length === 0) {
        return configError(
            'EMPTY_QUEUES',
            'config.queues must define at least one queue',
            'config.queues',
        )
    }

    const stores: Record<string, StoreDefinition> = {}
    if (root.stores !== undefined) {
        if (!isPlainObject(root.stores)) {
            return configError(
                'INVALID_TYPE',
                'config.stores must be an object',
                'config.stores',
            )
        }
        for (const name of Object.keys(root.stores)) {
            if (name.length === 0) {
                return configError(
                    'EMPTY_KEY',
                    'config.stores keys must be non-empty strings',
                    'config.stores',
                )
            }
            stores[name] = parseStoreDefinition(
                root.stores[name],
                `config.stores.${name}`,
                { allowJs: options.allowJs },
            )
        }
    }

    const storeNames = new Set(Object.keys(stores))
    const storeStrategies = new Map<string, 'snapshot' | 'row'>()
    for (const [name, def] of Object.entries(stores)) {
        storeStrategies.set(name, def.strategy)
    }

    // Duplicate web storage keys (adapter + key) corrupt each other.
    const storageKeyUsage = new Map<string, string>()
    for (const [name, def] of Object.entries(stores)) {
        if (!('adapter' in def)) continue
        if (def.adapter !== 'localStorage' && def.adapter !== 'sessionStorage') {
            continue
        }
        if (def.key === undefined) continue
        const fingerprint = `${def.adapter}\0${def.key}`
        const existing = storageKeyUsage.get(fingerprint)
        if (existing !== undefined) {
            return configError(
                'DUPLICATE_STORAGE_KEY',
                `Stores "${existing}" and "${name}" both use ${def.adapter} key "${def.key}". ` +
                    'Each web store must use a unique adapter+key pair.',
                `config.stores.${name}.key`,
            )
        }
        storageKeyUsage.set(fingerprint, name)
    }

    const queues: Record<string, QueueConfig> = {}
    for (const name of queueNames) {
        if (name.length === 0) {
            return configError(
                'EMPTY_KEY',
                'config.queues keys must be non-empty strings',
                'config.queues',
            )
        }
        queues[name] = parseQueueConfig(
            root.queues[name],
            `config.queues.${name}`,
            storeNames,
            storeStrategies,
            { allowJs: options.allowJs },
        )
    }

    const storeUsage = new Map<string, string>()
    for (const [queueName, queueConfig] of Object.entries(queues)) {
        const storeName = queueConfig.persist?.store
        if (storeName === undefined) continue

        const existingQueue = storeUsage.get(storeName)
        if (existingQueue !== undefined) {
            return configError(
                'SHARED_STORE',
                `Store "${storeName}" is shared by queues "${existingQueue}" and "${queueName}". ` +
                    'Each queue must have a unique store instance to prevent data corruption.',
                `config.queues.${queueName}.persist.store`,
            )
        }
        storeUsage.set(storeName, queueName)
    }

    for (const storeName of storeNames) {
        if (!storeUsage.has(storeName)) {
            return configError(
                'UNUSED_STORE',
                `Store "${storeName}" is defined in config.stores but not referenced by any queue.persist.store`,
                `config.stores.${storeName}`,
            )
        }
    }

    const config: SystemConfig = { queues }

    if (Object.keys(stores).length > 0) {
        config.stores = stores
    }

    if (root.router !== undefined) {
        config.router = parseRouterConfig(root.router, 'config.router')
    }

    if (root.hydrate !== undefined) {
        config.hydrate = expectBoolean(root.hydrate, 'config.hydrate')
    }

    if (config.router?.bindings) {
        for (const [index, binding] of config.router.bindings.entries()) {
            if (!(binding.queue in queues)) {
                return configError(
                    'UNKNOWN_QUEUE',
                    `config.router.bindings[${index}].queue "${binding.queue}" is not defined in config.queues`,
                    `config.router.bindings[${index}].queue`,
                )
            }
        }
    }

    if (config.router?.unmatchedQueue !== undefined) {
        if (!(config.router.unmatchedQueue in queues)) {
            return configError(
                'UNKNOWN_QUEUE',
                `config.router.unmatchedQueue "${config.router.unmatchedQueue}" is not defined in config.queues`,
                'config.router.unmatchedQueue',
            )
        }
    }

    return config
}

/**
 * Validate an unknown value as **data-only** config (JSON-safe).
 * Rejects `worker` and custom store `impl` (JS-only fields).
 * Returns a cleaned {@link SystemConfig} (unknown fields stripped).
 */
export const validateSystemConfig = (value: unknown): SystemConfig =>
    parseSystemConfigValue(value, { allowJs: false })

/**
 * Validate a JS/TS module config **in place** and return the same reference.
 * Preserves workers, custom store impls, and any extra properties on `TConfig`.
 * Prefer {@link defineConfig} at the export site for typed inference.
 */
export const validateJsConfig = <TConfig extends SystemConfig>(
    value: TConfig,
): TConfig => {
    // Side-effect validation; discard the reconstructed SystemConfig so
    // callers keep their original object identity and type parameters.
    parseSystemConfigValue(value, { allowJs: true })
    return value
}

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
        return configError(
            'INVALID_JSON',
            `config JSON is invalid: ${message}`,
        )
    }
    return validateSystemConfig(parsed)
}
