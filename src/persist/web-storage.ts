import type {
    RowRecord,
    RowStore,
    SnapshotStore,
} from '../queue/persist/persist.types'
import {
    decodeWithCodec,
    defaultJsonCodec,
    type JsonCodec,
} from './json-codec.util'
import {
    lazyGlobalStorage,
    resolveStorage,
    type WebStorageLike,
} from './web-storage-access.util'

export { StorageCodecError, type JsonCodec } from './json-codec.util'
export type { WebStorageLike } from './web-storage-access.util'

export type WebSnapshotStoreOptions<T> = {
    /** Storage key for the full JSON array snapshot. */
    key: string
    /** Defaults to `globalThis.localStorage`. */
    storage?: WebStorageLike
    codec?: JsonCodec<T[]>
}

/**
 * Snapshot store backed by Web Storage (localStorage / sessionStorage).
 * Entire queue is one JSON value under `key`.
 *
 * Corrupt data throws {@link StorageCodecError}. Supply a validating `codec`
 * when storage may contain untrusted or versioned payloads.
 *
 * **Limits (not multi-tab safe):**
 * - Reads/writes are not transactional; a failed `setItem` can leave a partial
 *   or stale snapshot (e.g. quota exceeded).
 * - Concurrent tabs race on the same key — last write wins; no locking.
 * - Prefer a single tab owner, or a server-side store for shared durability.
 */
export const createWebSnapshotStore = <T>(
    options: WebSnapshotStoreOptions<T>,
): SnapshotStore<T> => {
    const storage = () => resolveStorage(options.storage)
    const codec = options.codec ?? defaultJsonCodec<T[]>()

    return {
        load: () => {
            const raw = storage().getItem(options.key)
            if (raw === null || raw === '') return []
            const items = decodeWithCodec(
                `snapshot "${options.key}"`,
                raw,
                codec.deserialize,
            )
            return Array.isArray(items) ? items : []
        },
        save: (items) => {
            storage().setItem(options.key, codec.serialize([...items]))
        },
    }
}

export type WebRowStoreOptions<T> = {
    /**
     * Key prefix. Uses:
     * - `${key}:order` → id list head → tail
     * - `${key}:row:${id}` → serialized item
     */
    key: string
    storage?: WebStorageLike
    itemCodec?: JsonCodec<T>
}

type OrderCodec = JsonCodec<string[]>

const orderCodec: OrderCodec = {
    serialize: (ids) => JSON.stringify(ids),
    deserialize: (raw) => {
        const ids = JSON.parse(raw) as unknown
        if (!Array.isArray(ids)) return []
        return ids.filter((id): id is string => typeof id === 'string')
    },
}

/**
 * Row-level store on Web Storage.
 * Each job is its own key; order is a separate id list (true row ops).
 *
 * Corrupt order/row payloads throw {@link StorageCodecError}.
 * Prefer a validating `itemCodec` for untrusted storage.
 *
 * **Limits (not multi-tab safe):**
 * - `insert` / `remove` / `clear` are multi-key and not atomic — a crash or
 *   quota error mid-op can leave order list and row keys inconsistent.
 * - Concurrent tabs race on the same prefix; last writer wins without merge.
 * - Use one owning tab, or a real DB/backend when durability must be shared.
 */
export const createWebRowStore = <T>(
    options: WebRowStoreOptions<T>,
): RowStore<T> => {
    const storage = () => resolveStorage(options.storage)
    const itemCodec = options.itemCodec ?? defaultJsonCodec<T>()
    const orderKey = `${options.key}:order`
    const rowKey = (id: string) => `${options.key}:row:${id}`

    const readOrder = (): string[] => {
        const raw = storage().getItem(orderKey)
        if (raw === null || raw === '') return []
        return decodeWithCodec(
            `row order "${orderKey}"`,
            raw,
            orderCodec.deserialize,
        )
    }

    const writeOrder = (ids: string[]): void => {
        if (ids.length === 0) {
            storage().removeItem(orderKey)
            return
        }
        storage().setItem(orderKey, orderCodec.serialize(ids))
    }

    return {
        loadAll: () => {
            const ids = readOrder()
            const rows: RowRecord<T>[] = []

            for (const id of ids) {
                const raw = storage().getItem(rowKey(id))
                if (raw === null) continue
                rows.push({
                    id,
                    item: decodeWithCodec(
                        `row "${rowKey(id)}"`,
                        raw,
                        itemCodec.deserialize,
                    ),
                })
            }

            return rows
        },
        insert: (record) => {
            const store = storage()
            store.setItem(rowKey(record.id), itemCodec.serialize(record.item))
            const ids = readOrder()
            if (!ids.includes(record.id)) {
                ids.push(record.id)
                writeOrder(ids)
            }
        },
        remove: (id) => {
            const store = storage()
            store.removeItem(rowKey(id))
            writeOrder(readOrder().filter((entry) => entry !== id))
        },
        clear: () => {
            const store = storage()
            for (const id of readOrder()) {
                store.removeItem(rowKey(id))
            }
            store.removeItem(orderKey)
        },
    }
}

/** Convenience: snapshot store on `localStorage` (resolved lazily on use). */
export const createLocalStorageSnapshotStore = <T>(
    key: string,
    options: Omit<WebSnapshotStoreOptions<T>, 'key' | 'storage'> = {},
): SnapshotStore<T> =>
    createWebSnapshotStore({
        ...options,
        key,
        storage: lazyGlobalStorage('localStorage'),
    })

/** Convenience: row store on `localStorage` (resolved lazily on use). */
export const createLocalStorageRowStore = <T>(
    key: string,
    options: Omit<WebRowStoreOptions<T>, 'key' | 'storage'> = {},
): RowStore<T> =>
    createWebRowStore({
        ...options,
        key,
        storage: lazyGlobalStorage('localStorage'),
    })

/** Convenience: snapshot store on `sessionStorage` (resolved lazily on use). */
export const createSessionStorageSnapshotStore = <T>(
    key: string,
    options: Omit<WebSnapshotStoreOptions<T>, 'key' | 'storage'> = {},
): SnapshotStore<T> =>
    createWebSnapshotStore({
        ...options,
        key,
        storage: lazyGlobalStorage('sessionStorage'),
    })

/** Convenience: row store on `sessionStorage` (resolved lazily on use). */
export const createSessionStorageRowStore = <T>(
    key: string,
    options: Omit<WebRowStoreOptions<T>, 'key' | 'storage'> = {},
): RowStore<T> =>
    createWebRowStore({
        ...options,
        key,
        storage: lazyGlobalStorage('sessionStorage'),
    })
