import type {
    DlqConfig,
    LoopConfig,
    PersistConfig,
    QueueConfig,
    WorkerConfig,
} from '../types'
import { configError } from '../errors'
import {
    expectBoolean,
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

    if (obj.autoSave !== undefined || obj.autoSaveDebounceMs !== undefined) {
        return configError(
            'INVALID_FIELD',
            `${path}: snapshot autoSave options are no longer supported`,
            path,
        )
    }
    if (obj.createId !== undefined) {
        return configError(
            'INVALID_FIELD',
            `${path}.createId is no longer supported (ids are numeric and allocated by the queue)`,
            `${path}.createId`,
        )
    }

    const leaseTtlMs =
        obj.leaseTtlMs === undefined
            ? undefined
            : expectPositiveInteger(obj.leaseTtlMs, `${path}.leaseTtlMs`)

    return {
        store,
        ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
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

export const parseLoopConfig = (
    value: unknown,
    path: string,
    ctx: ParseCtx,
): LoopConfig => {
    if (value === true) return true

    if (!isPlainObject(value)) {
        return configError(
            'INVALID_TYPE',
            `${path} must be true or { map?, filter?, delay? }`,
            path,
        )
    }

    const loop: Exclude<LoopConfig, true> = {}

    if (value.map !== undefined) {
        if (!ctx.allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.map is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.map`,
            )
        }
        if (typeof value.map !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.map must be a function`,
                `${path}.map`,
            )
        }
        loop.map = value.map as Exclude<LoopConfig, true>['map']
    }

    if (value.filter !== undefined) {
        if (!ctx.allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.filter is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.filter`,
            )
        }
        if (typeof value.filter !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.filter must be a function`,
                `${path}.filter`,
            )
        }
        loop.filter = value.filter as Exclude<LoopConfig, true>['filter']
    }

    if (value.delay !== undefined) {
        if (typeof value.delay === 'function') {
            if (!ctx.allowJs) {
                return configError(
                    'JS_ONLY_FIELD',
                    `${path}.delay as a function is only valid in JS config`,
                    `${path}.delay`,
                )
            }
            loop.delay = value.delay as Exclude<LoopConfig, true>['delay']
        } else if (
            typeof value.delay === 'number' &&
            Number.isFinite(value.delay) &&
            value.delay >= 0
        ) {
            loop.delay = value.delay
        } else {
            return configError(
                'INVALID_TYPE',
                `${path}.delay must be a finite number >= 0 or a function (hops) => ms`,
                `${path}.delay`,
            )
        }
    }

    return loop
}

export const parseDlqConfig = (
    value: unknown,
    path: string,
    ctx: ParseCtx,
): DlqConfig => {
    if (typeof value === 'string') {
        const queue = expectString(value, path)
        return queue
    }

    if (!isPlainObject(value)) {
        return configError(
            'INVALID_TYPE',
            `${path} must be a queue name string or { queue, map?, filter? }`,
            path,
        )
    }

    const queue = expectString(value.queue, `${path}.queue`)
    const dlq: Exclude<DlqConfig, string> = { queue }

    if (value.map !== undefined) {
        if (!ctx.allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.map is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.map`,
            )
        }
        if (typeof value.map !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.map must be a function`,
                `${path}.map`,
            )
        }
        dlq.map = value.map as Exclude<DlqConfig, string>['map']
    }

    if (value.filter !== undefined) {
        if (!ctx.allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.filter is only valid in JS config (functions cannot be expressed in JSON)`,
                `${path}.filter`,
            )
        }
        if (typeof value.filter !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.filter must be a function`,
                `${path}.filter`,
            )
        }
        dlq.filter = value.filter as Exclude<DlqConfig, string>['filter']
    }

    return dlq
}

/** Target queue name for a parsed {@link DlqConfig}. */
export const dlqTargetName = (dlq: DlqConfig): string =>
    typeof dlq === 'string' ? dlq : dlq.queue

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

    if (obj.loop !== undefined) {
        queue.loop = parseLoopConfig(obj.loop, `${path}.loop`, ctx)
        if (queue.worker === undefined) {
            return configError(
                'INVALID_FIELD',
                `${path}.loop requires worker on the same queue`,
                `${path}.loop`,
            )
        }
    }

    if (obj.dlq !== undefined) {
        queue.dlq = parseDlqConfig(obj.dlq, `${path}.dlq`, ctx)
        if (queue.worker === undefined) {
            return configError(
                'INVALID_FIELD',
                `${path}.dlq requires worker on the same queue`,
                `${path}.dlq`,
            )
        }
    }

    return queue
}
