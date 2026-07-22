import type { BuiltinStoreAdapter } from './types'
import { configError } from './errors'
import { isIntegerInRange } from './number.util'

const BUILTIN_ADAPTERS = new Set<BuiltinStoreAdapter>([
    'memory',
    'localStorage',
    'sessionStorage',
])

/**
 * True for plain data objects (`{}` / `Object.create(null)`).
 * Rejects arrays, boxed primitives, and built-ins (`Date`, `Map`, `Set`, …).
 */
export const isPlainObject = (
    value: unknown,
): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false
    }
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/** Method-shape check shared by parse-time and resolve-time guards. */
export const hasSnapshotStoreShape = (value: object): boolean =>
    typeof (value as { load?: unknown }).load === 'function' &&
    typeof (value as { save?: unknown }).save === 'function'

/** Method-shape check shared by parse-time and resolve-time guards. */
export const hasRowStoreShape = (value: object): boolean => {
    const store = value as {
        loadAll?: unknown
        insert?: unknown
        remove?: unknown
        clear?: unknown
    }
    return (
        typeof store.loadAll === 'function' &&
        typeof store.insert === 'function' &&
        typeof store.remove === 'function' &&
        typeof store.clear === 'function'
    )
}

export const expectString = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        return configError(
            'INVALID_TYPE',
            `${path} must be a non-empty string`,
            path,
        )
    }
    return value
}

export const expectBoolean = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') {
        return configError('INVALID_TYPE', `${path} must be a boolean`, path)
    }
    return value
}

/** Safe integer ≥ 1 (queue maxSize, worker concurrency, …). */
export const expectPositiveInteger = (value: unknown, path: string): number => {
    if (!isIntegerInRange(value, 1)) {
        return configError(
            'INVALID_TYPE',
            `${path} must be a safe integer >= 1`,
            path,
        )
    }
    return value
}

/** Safe integer ≥ 0 (debounce ms, …). */
export const expectNonNegativeInteger = (
    value: unknown,
    path: string,
): number => {
    if (!isIntegerInRange(value, 0)) {
        return configError(
            'INVALID_TYPE',
            `${path} must be a safe integer >= 0`,
            path,
        )
    }
    return value
}

export const parseAdapter = (
    value: unknown,
    path: string,
): BuiltinStoreAdapter => {
    if (
        typeof value !== 'string' ||
        !BUILTIN_ADAPTERS.has(value as BuiltinStoreAdapter)
    ) {
        return configError(
            'INVALID_ADAPTER',
            `${path} must be one of: memory, localStorage, sessionStorage`,
            path,
        )
    }
    return value as BuiltinStoreAdapter
}

/** Parse-time duck check: plain object with snapshot methods. */
export const isSnapshotStoreLike = (value: unknown): boolean =>
    isPlainObject(value) && hasSnapshotStoreShape(value)

/** Parse-time duck check: plain object with row methods. */
export const isRowStoreLike = (value: unknown): boolean =>
    isPlainObject(value) && hasRowStoreShape(value)

export const parseStrategy = (
    value: unknown,
    path: string,
): 'snapshot' | 'row' => {
    if (value !== 'snapshot' && value !== 'row') {
        return configError(
            'INVALID_STRATEGY',
            `${path} must be "snapshot" or "row"`,
            path,
        )
    }
    return value
}

/**
 * Web adapters require a non-empty storage key.
 * Shared by validate-time and resolve-time checks.
 */
export const assertWebStorageKey = (
    adapter: string,
    key: string | undefined,
    path: string,
): string => {
    if (key === undefined || key.length === 0) {
        return configError(
            'KEY_REQUIRED',
            `${path} is required when adapter is "${adapter}"`,
            path,
        )
    }
    return key
}
