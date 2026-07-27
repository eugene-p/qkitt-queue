import { isRowStore } from '@qkitt/queue'
import type { BuiltinStoreAdapter } from './types'
import { configError } from './errors'
import { isIntegerInRange } from './number.util'

const BUILTIN_ADAPTERS = new Set<BuiltinStoreAdapter>([
    'memory',
    'localStorage',
    'sessionStorage',
])

export const isPlainObject = (
    value: unknown,
): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false
    }
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

export const isObjectLike = (
    value: unknown,
): value is object =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

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

/** Parse-time duck check for {@link import('@qkitt/queue').RowStore}. */
export const isRowStoreLike = (value: unknown): boolean =>
    isObjectLike(value) && isRowStore(value)

export const isJsonCodecLike = (value: unknown): boolean =>
    isObjectLike(value) &&
    typeof (value as { serialize?: unknown }).serialize === 'function' &&
    typeof (value as { deserialize?: unknown }).deserialize === 'function'

/**
 * Web adapters require a non-empty storage key.
 */
export const assertWebStorageKey = (
    adapter: BuiltinStoreAdapter,
    key: string | undefined,
    path: string,
): string => {
    if (adapter === 'memory') {
        return key ?? ''
    }
    if (key === undefined || key.trim() === '') {
        return configError(
            'MISSING_FIELD',
            `${path} is required for ${adapter} adapter`,
            path,
        )
    }
    return key
}
