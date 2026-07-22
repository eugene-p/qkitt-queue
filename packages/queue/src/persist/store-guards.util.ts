/**
 * Runtime duck-checks for store contract discrimination.
 * Exported so `@qkitt/queue-config` can reuse them instead of local copies.
 */

import type { RowStore, SnapshotStore } from './contracts'

/** True when `value` has `load` + `save` methods (SnapshotStore shape). */
export const isSnapshotStore = <T>(
    value: object,
): value is SnapshotStore<T> =>
    typeof (value as { load?: unknown }).load === 'function' &&
    typeof (value as { save?: unknown }).save === 'function'

/** True when `value` has `loadAll` + `insert` + `remove` + `clear` methods (RowStore shape). */
export const isRowStore = <T>(
    value: object,
): value is RowStore<T> => {
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
