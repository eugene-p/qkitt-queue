import type { StoreDefinition } from '../types'
import { configError } from '../errors'
import {
    assertWebStorageKey,
    expectString,
    isJsonCodecLike,
    isRowStoreLike,
    parseAdapter,
} from '../parse.util'
import type { ParseJsOptions } from './ctx'
import { expectPlainObject } from './expect'

/**
 * Parse one `config.stores.<name>` entry.
 * Built-in: `{ adapter, key? }`. Custom: `{ impl }` (JS only).
 */
export const parseStoreDefinition = (
    value: unknown,
    path: string,
    { allowJs }: ParseJsOptions,
): StoreDefinition => {
    const obj = expectPlainObject(value, path)

    if (obj.impl !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.impl is only valid in JS config (not JSON); implement RowStore and pass the instance from a module`,
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
        if (obj.itemCodec !== undefined) {
            return configError(
                'CONFLICTING_FIELDS',
                `${path} cannot set itemCodec with custom "impl" (configure the store itself)`,
                path,
            )
        }
        if (!isRowStoreLike(obj.impl)) {
            return configError(
                'INVALID_IMPL',
                `${path}.impl must be a RowStore (loadAll + put + remove + clear)`,
                `${path}.impl`,
            )
        }
        return {
            impl: obj.impl as Extract<StoreDefinition, { impl: unknown }>['impl'],
        }
    }

    if (obj.adapter === undefined) {
        return configError(
            'MISSING_FIELD',
            `${path} requires "adapter" (or "impl" in JS config)`,
            path,
        )
    }

    // Reject legacy strategy field if present as snapshot
    if (obj.strategy === 'snapshot') {
        return configError(
            'INVALID_STRATEGY',
            `${path}.strategy "snapshot" is no longer supported`,
            `${path}.strategy`,
        )
    }

    const adapter = parseAdapter(obj.adapter, `${path}.adapter`)
    const key =
        obj.key === undefined
            ? undefined
            : expectString(obj.key, `${path}.key`)

    if (adapter !== 'memory') {
        assertWebStorageKey(adapter, key, `${path}.key`)
    }

    if (obj.itemCodec !== undefined) {
        if (!allowJs) {
            return configError(
                'JS_ONLY_FIELD',
                `${path}.itemCodec is only valid in JS config`,
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

    return {
        adapter,
        ...(key !== undefined ? { key } : {}),
        ...(obj.itemCodec !== undefined
            ? {
                  itemCodec: obj.itemCodec as Extract<
                      StoreDefinition,
                      { adapter: unknown }
                  > extends { itemCodec?: infer C }
                      ? C
                      : never,
              }
            : {}),
    }
}
