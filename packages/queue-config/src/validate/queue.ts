import type {
    DlqConfig,
    LoopConfig,
    PersistConfig,
    QueueConfig,
    RetryConfig,
    ObservabilityConfig,
    WorkerConfig,
} from '../types'
import type {
    RecoveryPolicy,
    WithRetryOptions,
} from '@qkitt/queue'
import { configError } from '../errors'
import {
    expectBoolean,
    expectNonNegativeFinite,
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
            `${path} must be a function or { run, concurrency?, autoStart?, timeoutMs?, traceContext?, onFailure? }`,
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

    const timeoutMs =
        value.timeoutMs === undefined
            ? undefined
            : expectNonNegativeFinite(value.timeoutMs, `${path}.timeoutMs`)

    const traceContext =
        value.traceContext === undefined
            ? undefined
            : typeof value.traceContext === 'function'
              ? (value.traceContext as (item: unknown) => unknown)
              : configError(
                    'INVALID_TYPE',
                    `${path}.traceContext must be a function`,
                    `${path}.traceContext`,
                )

    const onFailure = value.onFailure
    if (
        onFailure !== undefined &&
        onFailure !== 'fail' &&
        onFailure !== 'loop' &&
        typeof onFailure !== 'function'
    ) {
        return configError(
            'INVALID_TYPE',
            `${path}.onFailure must be "fail", "loop", or a function`,
            `${path}.onFailure`,
        )
    }

    return {
        run: value.run as Extract<WorkerConfig, { run: unknown }>['run'],
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(autoStart !== undefined ? { autoStart } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(traceContext !== undefined ? { traceContext } : {}),
        ...(onFailure !== undefined
            ? { onFailure: onFailure as RecoveryPolicy<unknown> }
            : {}),
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

    if (value.maxHandoffAttempts !== undefined) {
        dlq.maxHandoffAttempts = expectPositiveInteger(
            value.maxHandoffAttempts,
            `${path}.maxHandoffAttempts`,
        )
    }

    return dlq
}

export const parseRetryConfig = (
    value: unknown,
    path: string,
    ctx: ParseCtx,
): RetryConfig => {
    if (value === true) return true
    const obj = expectPlainObject(value, path)
    const maxAttempts =
        obj.maxAttempts === undefined
            ? undefined
            : expectPositiveInteger(obj.maxAttempts, `${path}.maxAttempts`)
    const initialDelayMs =
        obj.initialDelayMs === undefined
            ? undefined
            : expectNonNegativeFinite(
                  obj.initialDelayMs,
                  `${path}.initialDelayMs`,
              )
    const maxDelayMs =
        obj.maxDelayMs === undefined
            ? undefined
            : expectNonNegativeFinite(obj.maxDelayMs, `${path}.maxDelayMs`)
    const effectiveInitial = initialDelayMs ?? 1_000
    const effectiveMax = maxDelayMs ?? 30_000
    if (effectiveMax < effectiveInitial) {
        return configError(
            'INVALID_TYPE',
            `${path}.maxDelayMs must be >= initialDelayMs`,
            `${path}.maxDelayMs`,
        )
    }
    const jitter =
        obj.jitter === undefined
            ? undefined
            : expectNonNegativeFinite(obj.jitter, `${path}.jitter`)
    if (jitter !== undefined && jitter > 1) {
        return configError(
            'INVALID_TYPE',
            `${path}.jitter must be a finite number from 0 to 1`,
            `${path}.jitter`,
        )
    }
    const out: Exclude<RetryConfig, true> = {}
    if (obj.classify !== undefined) {
        if (!ctx.allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.classify is only valid in JS config`,
                `${path}.classify`,
            )
        }
        if (typeof obj.classify !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.classify must be a function`,
                `${path}.classify`,
            )
        }
        out.classify = obj.classify as NonNullable<
            WithRetryOptions<unknown>['classify']
        >
    }
    if (maxAttempts !== undefined) out.maxAttempts = maxAttempts
    if (initialDelayMs !== undefined) out.initialDelayMs = initialDelayMs
    if (maxDelayMs !== undefined) out.maxDelayMs = maxDelayMs
    if (jitter !== undefined) out.jitter = jitter
    return out
}

export const parseObservabilityConfig = (
    value: unknown,
    path: string,
    ctx: ParseCtx,
): ObservabilityConfig => {
    if (value === true) return true
    const obj = expectPlainObject(value, path)
    const out: Exclude<ObservabilityConfig, true> = {}
    for (const field of ['onMetrics', 'onTrace'] as const) {
        const candidate = obj[field]
        if (candidate === undefined) continue
        if (!ctx.allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.${field} is only valid in JS config`,
                `${path}.${field}`,
            )
        }
        if (typeof candidate !== 'function') {
            return configError(
                'INVALID_TYPE',
                `${path}.${field} must be a function`,
                `${path}.${field}`,
            )
        }
        out[field] = candidate as never
    }
    return out
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

    if (obj.retry !== undefined) {
        if (obj.loop !== undefined) {
            return configError(
                'CONFLICTING_FIELDS',
                `${path} cannot configure both "retry" and "loop" recovery`,
                path,
            )
        }
        if (
            queue.worker &&
            typeof queue.worker !== 'function' &&
            queue.worker.onFailure === 'loop'
        ) {
            return configError(
                'CONFLICTING_FIELDS',
                `${path}.retry conflicts with ${path}.worker.onFailure "loop"`,
                `${path}.retry`,
            )
        }
        queue.retry = parseRetryConfig(obj.retry, `${path}.retry`, ctx)
        if (queue.worker === undefined) {
            return configError(
                'INVALID_FIELD',
                `${path}.retry requires worker on the same queue`,
                `${path}.retry`,
            )
        }
    }

    if (obj.observability !== undefined) {
        queue.observability = parseObservabilityConfig(
            obj.observability,
            `${path}.observability`,
            ctx,
        )
    }

    return queue
}
