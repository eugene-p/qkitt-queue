import { isIntegerInRange } from '../util/number.util'
import type { BuiltinStoreAdapter } from './types'

export const BUILTIN_ADAPTERS = new Set<BuiltinStoreAdapter>([
    'memory',
    'localStorage',
    'sessionStorage',
])

export const isPlainObject = (
    value: unknown,
): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const expectString = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${path} must be a non-empty string`)
    }
    return value
}

export const expectBoolean = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`)
    }
    return value
}

/** Safe integer ≥ 1 (queue maxSize, worker concurrency, …). */
export const expectPositiveInteger = (value: unknown, path: string): number => {
    if (!isIntegerInRange(value, 1)) {
        throw new Error(`${path} must be a safe integer >= 1`)
    }
    return value
}

/**
 * @deprecated Prefer {@link expectPositiveInteger}. Alias kept for call sites
 * that previously accepted finite floats.
 */
export const expectPositiveFinite = expectPositiveInteger

export const parseAdapter = (
    value: unknown,
    path: string,
): BuiltinStoreAdapter => {
    if (
        typeof value !== 'string' ||
        !BUILTIN_ADAPTERS.has(value as BuiltinStoreAdapter)
    ) {
        throw new Error(
            `${path} must be one of: memory, localStorage, sessionStorage`,
        )
    }
    return value as BuiltinStoreAdapter
}

export const isSnapshotStoreLike = (value: unknown): boolean =>
    isPlainObject(value) &&
    typeof value.load === 'function' &&
    typeof value.save === 'function'

export const isRowStoreLike = (value: unknown): boolean =>
    isPlainObject(value) &&
    typeof value.loadAll === 'function' &&
    typeof value.insert === 'function' &&
    typeof value.remove === 'function' &&
    typeof value.clear === 'function'

export const parseStrategy = (
    value: unknown,
    path: string,
): 'snapshot' | 'row' => {
    if (value !== 'snapshot' && value !== 'row') {
        throw new Error(`${path} must be "snapshot" or "row"`)
    }
    return value
}
