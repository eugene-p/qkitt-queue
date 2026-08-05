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
     * Key prefix. The active manifest is stored at `${key}:manifest` and
     * generation-scoped rows at `${key}:g${generation}:row:${id}`. Older
     * `${key}:order` / `${key}:row:${id}` data is read and migrated lazily.
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

type Manifest = {
    version: 1
    generation: number
    ids: number[]
}

type StoreState = {
    generation: number
    ids: number[]
    legacy: boolean
}

const normalizeIds = (values: unknown[]): number[] => {
    const ids: number[] = []
    for (const value of values) {
        if (
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 1
        ) {
            ids.push(value)
        }
    }
    return ids
}

const orderCodec: OrderCodec = {
    serialize: (ids) => JSON.stringify(ids),
    deserialize: (raw) => {
        const ids = JSON.parse(raw) as unknown
        if (!Array.isArray(ids)) return []
        return normalizeIds(ids)
    },
}

const defaultRecordCodec = <T>(): JsonCodec<StoredRecord<T>> => ({
    serialize: (record) => JSON.stringify(record),
    deserialize: (raw) => JSON.parse(raw) as StoredRecord<T>,
})

/**
 * Web Storage backend with full record state (claim/delay fields).
 *
 * **Limits (not multi-tab safe):** concurrent tabs still race without merge.
 * Each mutation publishes one manifest key after its row writes, so a reload
 * sees either the previous generation or the newly published generation.
 *
 */
export const createWebRowStore = <T>(
    options: WebRowStoreOptions<T>,
): RowStore<T> => {
    const storage = () => resolveStorage(options.storage)
    const itemCodec = options.itemCodec ?? defaultJsonCodec<T>()
    const recordCodec = defaultRecordCodec<T>()
    const orderKey = `${options.key}:order`
    const manifestKey = `${options.key}:manifest`
    const legacyRecordKey = (id: number) => `${options.key}:row:${id}`
    const generationRecordKey = (generation: number, id: number) =>
        `${options.key}:g${generation}:row:${id}`
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

    const loadManifest = (): Manifest | undefined => {
        const raw = storage().getItem(manifestKey)
        if (raw === null || raw === '') return undefined
        return decodeWithCodec(`manifest "${manifestKey}"`, raw, (value) => {
            const parsed = JSON.parse(value) as Partial<Manifest>
            const generation = parsed.generation
            if (
                parsed.version !== 1 ||
                typeof generation !== 'number' ||
                !Number.isSafeInteger(generation) ||
                generation < 1 ||
                !Array.isArray(parsed.ids)
            ) {
                return { version: 1, generation: 1, ids: [] }
            }
            return {
                version: 1,
                generation,
                ids: normalizeIds(parsed.ids),
            }
        })
    }

    const loadState = (): StoreState => {
        const manifest = loadManifest()
        if (manifest !== undefined) {
            return {
                generation: manifest.generation,
                ids: manifest.ids,
                legacy: false,
            }
        }
        return { generation: 0, ids: loadOrderFromStorage(), legacy: true }
    }

    const persistManifest = (generation: number, ids: number[]): void => {
        storage().setItem(
            manifestKey,
            JSON.stringify({ version: 1, generation, ids }),
        )
    }

    const cleanupKeys = (state: StoreState): void => {
        const store = storage()
        for (const id of state.ids) {
            try {
                store.removeItem(
                    state.legacy
                        ? legacyRecordKey(id)
                        : generationRecordKey(state.generation, id),
                )
            } catch {
                // Manifest publication already committed the new state.
            }
        }
        if (state.legacy) {
            try {
                store.removeItem(orderKey)
            } catch {
                // Legacy cleanup is best effort after migration/commit.
            }
        }
    }

    /** Remove generation rows no longer reachable from the active manifest. */
    const cleanupOrphanGenerations = (activeGeneration: number): void => {
        const store = storage()
        if (store.length === undefined || typeof store.key !== 'function') return
        const rowPrefix = `${options.key}:g`
        const keys: string[] = []
        for (let index = 0; index < store.length; index += 1) {
            const key = store.key(index)
            if (key !== null && key.startsWith(rowPrefix)) keys.push(key)
        }
        const activePrefix = `${options.key}:g${activeGeneration}:row:`
        for (const key of keys) {
            if (!key.startsWith(activePrefix)) {
                try {
                    store.removeItem(key)
                } catch {
                    // Cleanup is best effort; the manifest remains authoritative.
                }
            }
        }
    }

    const ensureActiveState = (state: StoreState): StoreState => {
        if (!state.legacy) return state
        const migrated: StoreState = {
            generation: 1,
            ids: [...state.ids],
            legacy: false,
        }
        const records = state.ids
            .map((id) => readRecord(id, state))
            .filter((record): record is RowRecord<T> => record !== undefined)
        for (const record of records) writeRecord(record, migrated.generation)
        persistManifest(migrated.generation, migrated.ids)
        cleanupKeys(state)
        return migrated
    }

    const writeRecord = (record: RowRecord<T>, generation: number): void => {
        const store = storage()
        const key = generation === 0
            ? legacyRecordKey(record.id)
            : generationRecordKey(generation, record.id)
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

    const readRecord = (
        id: number,
        state: StoreState,
    ): RowRecord<T> | undefined => {
        const key = state.legacy
            ? legacyRecordKey(id)
            : generationRecordKey(state.generation, id)
        const raw = storage().getItem(key)
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
            `record "${key}"`,
            raw,
            recordCodec.deserialize,
        )
        stored.availableAt ??= 0
        stored.leaseGeneration ??= null
        stored.leaseExpiresAt ??= null
        return stored
    }

    const putOne = (record: RowRecord<T>): void => {
        const state = ensureActiveState(loadState())
        writeRecord(record, state.generation)
        if (state.ids.includes(record.id)) {
            cleanupOrphanGenerations(state.generation)
            return
        }
        persistManifest(state.generation, [...state.ids, record.id])
        cleanupOrphanGenerations(state.generation)
    }

    const removeOne = (id: number): void => {
        const state = ensureActiveState(loadState())
        const index = state.ids.indexOf(id)
        if (index < 0) return
        const nextIds = [...state.ids]
        nextIds.splice(index, 1)
        // Publish the removal before deleting the row. A crash leaves only
        // an unreachable orphan, never a manifest pointing at missing data.
        persistManifest(state.generation, nextIds)
        try {
            storage().removeItem(
                state.legacy
                    ? legacyRecordKey(id)
                    : generationRecordKey(state.generation, id),
            )
        } catch {
            // The committed manifest is authoritative; cleanup can retry
            // later without exposing the row after a reload.
        }
        cleanupOrphanGenerations(state.generation)
    }

    return {
        loadAll: () => {
            const state = loadState()
            const out: RowRecord<T>[] = []
            for (let i = 0; i < state.ids.length; i += 1) {
                const record = readRecord(state.ids[i]!, state)
                if (record) out.push(record)
            }
            cleanupOrphanGenerations(state.generation)
            return out
        },
        put: putOne,
        remove: removeOne,
        clear: () => {
            const state = ensureActiveState(loadState())
            persistManifest(state.generation, [])
            cleanupKeys(state)
            cleanupOrphanGenerations(state.generation)
        },
        putBatch: (batch) => {
            if (batch.length === 0) return
            const state = ensureActiveState(loadState())
            const ids = [...state.ids]
            const seen = new Set(ids)
            for (const record of batch) {
                writeRecord(record, state.generation)
                if (!seen.has(record.id)) {
                    seen.add(record.id)
                    ids.push(record.id)
                }
            }
            if (ids.length !== state.ids.length) {
                persistManifest(state.generation, ids)
            }
            cleanupOrphanGenerations(state.generation)
        },
        removeBatch: (batchIds) => {
            if (batchIds.length === 0) return
            const state = ensureActiveState(loadState())
            const ids = new Set(batchIds)
            const remaining = state.ids.filter((id) => !ids.has(id))
            if (remaining.length === state.ids.length) return
            persistManifest(state.generation, remaining)
            const store = storage()
            for (const id of state.ids) {
                if (!ids.has(id)) continue
                try {
                    store.removeItem(
                        state.legacy
                            ? legacyRecordKey(id)
                            : generationRecordKey(state.generation, id),
                    )
                } catch {
                    // The manifest is already committed; leave an orphan.
                }
            }
            cleanupOrphanGenerations(state.generation)
        },
        replaceAll: (batch) => {
            const previous = loadState()
            const generation = previous.legacy
                ? 1
                : previous.generation + 1
            const nextIds: number[] = []
            const seen = new Set<number>()
            for (const record of batch) {
                writeRecord(record, generation)
                if (!seen.has(record.id)) {
                    seen.add(record.id)
                    nextIds.push(record.id)
                }
            }
            // Publish one pointer only after every new row is present.
            persistManifest(generation, nextIds)
            cleanupKeys(previous)
            cleanupOrphanGenerations(generation)
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
