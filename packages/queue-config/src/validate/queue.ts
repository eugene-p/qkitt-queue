import type { PersistConfig, QueueConfig, WorkerConfig } from '../types'
import { configError } from '../errors'
import {
    expectBoolean,
    expectNonNegativeInteger,
    expectPositiveInteger,
    expectString,
    isPlainObject,
} from '../parse.util'
import type { ParseCtx } from './ctx'
import { expectPlainObject } from './expect'

export const parsePersistConfig = (
    value: unknown,
    path: string,
    ctx: ParseCtx,
): PersistConfig => {
    const obj = expectPlainObject(value, path)
    const store = expectString(obj.store, `${path}.store`)
    if (!ctx.storeNames.has(store)) {
        return configError(
            'STORE_NOT_FOUND',
            `${path}.store "${store}" is not defined in config.stores`,
            `${path}.store`,
        )
    }

    const strategy = ctx.storeStrategies.get(store)!

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
        if (!ctx.allowJs) {
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

export const parseWorkerConfig = (value: unknown, path: string): WorkerConfig => {
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

export const parseQueueConfig = (
    value: unknown,
    path: string,
    ctx: ParseCtx,
): QueueConfig => {
    const obj = expectPlainObject(value, path)
    const queue: QueueConfig = {}

    if (obj.maxSize !== undefined) {
        queue.maxSize = expectPositiveInteger(obj.maxSize, `${path}.maxSize`)
    }

    if (obj.persist !== undefined) {
        queue.persist = parsePersistConfig(obj.persist, `${path}.persist`, ctx)
    }

    if (obj.worker !== undefined) {
        if (!ctx.allowJs) {
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
