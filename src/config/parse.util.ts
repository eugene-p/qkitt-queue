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

/** Finite number ≥ 1 (queue maxSize, worker concurrency, …). */
export const expectPositiveFinite = (value: unknown, path: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        throw new Error(`${path} must be a finite number >= 1`)
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
