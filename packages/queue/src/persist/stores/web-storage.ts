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
    attempt?: number
    dlqHandoffAttempt?: number
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

    const loadOrderFromStorage = (): number[] => {
        const raw = storage().getItem(orderKey)
        if (raw === null || raw === '') return []
        return decodeWithCodec(
            `order "${orderKey}"`,
            raw,
            orderCodec.deserialize,
        )
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
                    ...(record.attempt !== undefined
                        ? { attempt: record.attempt }
                        : {}),
                    ...(record.dlqHandoffAttempt !== undefined
                        ? { dlqHandoffAttempt: record.dlqHandoffAttempt }
                        : {}),
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
                ...(parsed.attempt !== undefined ? { attempt: parsed.attempt } : {}),
                ...(parsed.dlqHandoffAttempt !== undefined
                    ? { dlqHandoffAttempt: parsed.dlqHandoffAttempt }
                    : {}),
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
        const ids = loadOrderFromStorage()
        if (ids.includes(record.id)) return
        ids.push(record.id)
        persistOrder(ids)
    }

    const removeOne = (id: number): void => {
        storage().removeItem(recordKey(id))
        const ids = loadOrderFromStorage()
        const index = ids.indexOf(id)
        if (index < 0) return
        ids.splice(index, 1)
        persistOrder(ids)
    }

    return {
        loadAll: () => {
            const ids = loadOrderFromStorage()
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
            const ids = loadOrderFromStorage()
            for (let i = 0; i < ids.length; i += 1) {
                store.removeItem(recordKey(ids[i]!))
            }
            store.removeItem(orderKey)
        },
        putBatch: (batch) => {
            if (batch.length === 0) return
            const ids = loadOrderFromStorage()
            let orderChanged = false
            for (let i = 0; i < batch.length; i += 1) {
                const record = batch[i]!
                writeRecord(record)
                if (!ids.includes(record.id)) {
                    ids.push(record.id)
                    orderChanged = true
                }
            }
            if (orderChanged) persistOrder(ids)
        },
        removeBatch: (batchIds) => {
            if (batchIds.length === 0) return
            const store = storage()
            for (let i = 0; i < batchIds.length; i += 1) {
                const id = batchIds[i]!
                store.removeItem(recordKey(id))
            }
            const ids = loadOrderFromStorage()
            const remaining = ids.filter((id) => !batchIds.includes(id))
            if (remaining.length === ids.length) return
            remaining.length === 0
                ? store.removeItem(orderKey)
                : store.setItem(orderKey, orderCodec.serialize(remaining))
        },
        replaceAll: (batch) => {
            const store = storage()
            const prev = loadOrderFromStorage()
            for (let i = 0; i < prev.length; i += 1) {
                store.removeItem(recordKey(prev[i]!))
            }
            const nextIds: number[] = []
            for (let i = 0; i < batch.length; i += 1) {
                const record = batch[i]!
                writeRecord(record)
                if (!nextIds.includes(record.id)) {
                    nextIds.push(record.id)
                }
            }
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
