import type { QueueConfig, StoreDefinition, SystemConfig } from '../types'
import { configError } from '../errors'
import { expectBoolean, isPlainObject } from '../parse.util'
import type { ParseCtx, ParseJsOptions } from './ctx'
import { expectPlainObject } from './expect'
import { dlqTargetName, parseQueueConfig } from './queue'
import { parseRouterConfig } from './router'
import { parseStoreDefinition } from './store'

/**
 * Validate and rebuild a clean {@link SystemConfig} (data-only or JS).
 * Used by JSON paths where stripping unknown fields is desirable.
 */
export const parseSystemConfigValue = (
    value: unknown,
    options: ParseJsOptions,
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

    const ctx: ParseCtx = {
        allowJs: options.allowJs,
        storeNames,
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
            ctx,
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

    for (const [queueName, queueConfig] of Object.entries(queues)) {
        if (queueConfig.dlq === undefined) continue
        const target = dlqTargetName(queueConfig.dlq)
        const path =
            typeof queueConfig.dlq === 'string'
                ? `config.queues.${queueName}.dlq`
                : `config.queues.${queueName}.dlq.queue`

        if (!(target in queues)) {
            return configError(
                'UNKNOWN_QUEUE',
                `config.queues.${queueName}.dlq "${target}" is not defined in config.queues`,
                path,
            )
        }
        if (target === queueName) {
            return configError(
                'INVALID_FIELD',
                `config.queues.${queueName}.dlq must differ from the source queue; use loop for same-queue re-entry`,
                path,
            )
        }
    }

    return config
}
