import type { StoreDefinition } from '../types'
import { configError } from '../errors'
import {
    assertWebStorageKey,
    expectString,
    isJsonCodecLike,
    isRowStoreLike,
    isSnapshotStoreLike,
    parseAdapter,
    parseStrategy,
} from '../parse.util'
import type { ParseJsOptions } from './ctx'
import { expectPlainObject } from './expect'

/**
 * Parse one `config.stores.<name>` entry.
 * Built-in: `{ adapter, strategy, key? }`. Custom: `{ strategy, impl }` (JS only).
 */
export const parseStoreDefinition = (
    value: unknown,
    path: string,
    { allowJs }: ParseJsOptions,
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
