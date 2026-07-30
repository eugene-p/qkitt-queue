import type { RowRecord, RowStore } from '../contracts'
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
export {
    StorageUnavailableError,
    type WebStorageLike,
} from './web-storage-access.util'

export type WebRowStoreOptions<T> = {
    /**
     * Key prefix. Uses:
     * - `${key}:order` → numeric id list head → tail
     * - `${key}:row:${id}` → serialized full {@link RowRecord}
     */
    key: string
    storage?: WebStorageLike
    itemCodec?: JsonCodec<T>
}

type StoredRecord<T> = {
    id: number
    item: T
    availableAt: number
    leaseGeneration: number | null
    leaseExpiresAt: number | null
}

type OrderCodec = JsonCodec<number[]>

const orderCodec: OrderCodec = {
    serialize: (ids) => JSON.stringify(ids),
    deserialize: (raw) => {
        const ids = JSON.parse(raw) as unknown
        if (!Array.isArray(ids)) return []
        let count = 0
        for (let i = 0; i < ids.length; i += 1) {
            const id = ids[i]
            if (
                typeof id === 'number' &&
                Number.isSafeInteger(id) &&
                id >= 1
            ) {
                ids[count] = id
                count += 1
            }
        }
        ids.length = count
        return ids as number[]
    },
}

const defaultRecordCodec = <T>(): JsonCodec<StoredRecord<T>> => ({
    serialize: (record) => JSON.stringify(record),
    deserialize: (raw) => JSON.parse(raw) as StoredRecord<T>,
})

/**
 * Web Storage backend with full record state (claim/delay fields).
 *
 * **Limits (not multi-tab safe):** multi-key ops are not atomic; concurrent tabs
 * race without merge. Prefer one owning tab or a real DB when durability is shared.
 *
 * **Hot path:** an in-memory order cache (array + Set) avoids re-reading and
 * re-writing the order key on every claim/ack update — only membership changes
 * touch `${key}:order`. Record bodies still go through `setItem` per put.
 */
export const createWebRowStore = <T>(
    options: WebRowStoreOptions<T>,
): RowStore<T> => {
    const storage = () => resolveStorage(options.storage)
    const itemCodec = options.itemCodec ?? defaultJsonCodec<T>()
    const recordCodec = defaultRecordCodec<T>()
    const orderKey = `${options.key}:order`
    const recordKey = (id: number) => `${options.key}:row:${id}`
    const hasCustomItemCodec = options.itemCodec !== undefined

    /** Lazy process-local order cache (single-owner assumption). */
    let orderIds: number[] | undefined
    let orderSet: Set<number> | undefined

    const loadOrderFromStorage = (): number[] => {
        const raw = storage().getItem(orderKey)
        if (raw === null || raw === '') return []
        return decodeWithCodec(
            `order "${orderKey}"`,
            raw,
            orderCodec.deserialize,
        )
    }

    const ensureOrder = (): { ids: number[]; set: Set<number> } => {
        if (orderIds === undefined || orderSet === undefined) {
            orderIds = loadOrderFromStorage()
            orderSet = new Set(orderIds)
        }
        return { ids: orderIds, set: orderSet }
    }

    const persistOrder = (ids: number[]): void => {
        if (ids.length === 0) {
            storage().removeItem(orderKey)
            return
        }
        storage().setItem(orderKey, orderCodec.serialize(ids))
    }

    const writeRecord = (record: RowRecord<T>): void => {
        const store = storage()
        const key = recordKey(record.id)
        if (hasCustomItemCodec) {
            store.setItem(
                key,
                JSON.stringify({
                    id: record.id,
                    availableAt: record.availableAt,
                    leaseGeneration: record.leaseGeneration,
                    leaseExpiresAt: record.leaseExpiresAt,
                    itemRaw: itemCodec.serialize(record.item),
                }),
            )
            return
        }
        // RowRecord shape matches StoredRecord — serialize without a copy object.
        store.setItem(key, recordCodec.serialize(record as StoredRecord<T>))
    }

    const readRecord = (id: number): RowRecord<T> | undefined => {
        const raw = storage().getItem(recordKey(id))
        if (raw === null) return undefined
        if (hasCustomItemCodec) {
            const parsed = JSON.parse(raw) as StoredRecord<T> & {
                itemRaw?: string
            }
            const item =
                typeof parsed.itemRaw === 'string'
                    ? itemCodec.deserialize(parsed.itemRaw)
                    : (parsed.item as T)
            return {
                id: parsed.id,
                item,
                availableAt: parsed.availableAt ?? 0,
                leaseGeneration: parsed.leaseGeneration ?? null,
                leaseExpiresAt: parsed.leaseExpiresAt ?? null,
            }
        }
        const stored = decodeWithCodec(
            `record "${recordKey(id)}"`,
            raw,
            recordCodec.deserialize,
        )
        stored.availableAt ??= 0
        stored.leaseGeneration ??= null
        stored.leaseExpiresAt ??= null
        return stored
    }

    const putOne = (record: RowRecord<T>): void => {
        writeRecord(record)
        const { ids, set } = ensureOrder()
        if (set.has(record.id)) return
        // Membership change only — claim/lease updates skip order rewrite.
        set.add(record.id)
        ids.push(record.id)
        persistOrder(ids)
    }

    const removeOne = (id: number): void => {
        storage().removeItem(recordKey(id))
        const { ids, set } = ensureOrder()
        if (!set.has(id)) return
        set.delete(id)
        let count = 0
        for (let i = 0; i < ids.length; i += 1) {
            const entry = ids[i]!
            if (entry !== id) {
                ids[count] = entry
                count += 1
            }
        }
        ids.length = count
        persistOrder(ids)
    }

    return {
        loadAll: () => {
            const { ids } = ensureOrder()
            const out: RowRecord<T>[] = []
            for (let i = 0; i < ids.length; i += 1) {
                const record = readRecord(ids[i]!)
                if (record) out.push(record)
            }
            return out
        },
        put: putOne,
        remove: removeOne,
        clear: () => {
            const store = storage()
            const { ids } = ensureOrder()
            for (let i = 0; i < ids.length; i += 1) {
                store.removeItem(recordKey(ids[i]!))
            }
            store.removeItem(orderKey)
            orderIds = []
            orderSet = new Set()
        },
        putBatch: (batch) => {
            if (batch.length === 0) return
            const { ids, set } = ensureOrder()
            let orderChanged = false
            for (let i = 0; i < batch.length; i += 1) {
                const record = batch[i]!
                writeRecord(record)
                if (!set.has(record.id)) {
                    set.add(record.id)
                    ids.push(record.id)
                    orderChanged = true
                }
            }
            if (orderChanged) persistOrder(ids)
        },
        removeBatch: (batchIds) => {
            if (batchIds.length === 0) return
            const store = storage()
            const { ids, set } = ensureOrder()
            let orderChanged = false
            for (let i = 0; i < batchIds.length; i += 1) {
                const id = batchIds[i]!
                store.removeItem(recordKey(id))
                if (set.has(id)) {
                    set.delete(id)
                    orderChanged = true
                }
            }
            if (!orderChanged) return
            let count = 0
            for (let i = 0; i < ids.length; i += 1) {
                const id = ids[i]!
                if (set.has(id)) {
                    ids[count] = id
                    count += 1
                }
            }
            ids.length = count
            persistOrder(ids)
        },
        replaceAll: (batch) => {
            const store = storage()
            const { ids: prev } = ensureOrder()
            for (let i = 0; i < prev.length; i += 1) {
                store.removeItem(recordKey(prev[i]!))
            }
            const nextIds: number[] = []
            const nextSet = new Set<number>()
            for (let i = 0; i < batch.length; i += 1) {
                const record = batch[i]!
                writeRecord(record)
                if (!nextSet.has(record.id)) {
                    nextSet.add(record.id)
                    nextIds.push(record.id)
                }
            }
            orderIds = nextIds
            orderSet = nextSet
            persistOrder(nextIds)
        },
    }
}

export const createLocalStorageRowStore = <T>(
    key: string,
    options: Omit<WebRowStoreOptions<T>, 'key' | 'storage'> = {},
): RowStore<T> =>
    createWebRowStore({
        ...options,
        key,
        storage: lazyGlobalStorage('localStorage'),
    })

export const createSessionStorageRowStore = <T>(
    key: string,
    options: Omit<WebRowStoreOptions<T>, 'key' | 'storage'> = {},
): RowStore<T> =>
    createWebRowStore({
        ...options,
        key,
        storage: lazyGlobalStorage('sessionStorage'),
    })
