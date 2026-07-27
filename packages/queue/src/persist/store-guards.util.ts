/**
 * Runtime duck-checks for store contract discrimination.
 */

import type { RowStore } from './contracts'

/** True when `value` has `loadAll` + `put` + `remove` + `clear` ({@link RowStore}). */
export const isRowStore = <T>(value: object): value is RowStore<T> => {
    const store = value as {
        loadAll?: unknown
        put?: unknown
        remove?: unknown
        clear?: unknown
    }
    return (
        typeof store.loadAll === 'function' &&
        typeof store.put === 'function' &&
        typeof store.remove === 'function' &&
        typeof store.clear === 'function'
    )
}
