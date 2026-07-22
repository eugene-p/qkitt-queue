import type {
    RowPersistOptions,
    RowRecord,
    RowStore,
    RowStoreHandle,
    SnapshotPersistOptions,
    SnapshotStore,
    SnapshotStoreHandle,
} from '../contracts'

export type MemorySnapshotStore<T> = SnapshotStore<T> & {
    /** Live in-memory snapshot (mutated by `save`). */
    readonly data: T[]
}

export type MemoryRowStore<T> = RowStore<T> & {
    /** Live rows head → tail (mutated by insert/remove/clear). */
    readonly rows: RowRecord<T>[]
}

/** In-process snapshot store. Useful for tests and non-durable queues. */
export const createMemorySnapshotStore = <T>(
    initial: readonly T[] = [],
    options?: SnapshotPersistOptions,
): MemorySnapshotStore<T> & SnapshotStoreHandle<T> => {
    const data: T[] = [...initial]

    return {
        get data() {
            return data
        },
        load: () => data.slice(),
        save: (items) => {
            data.length = 0
            data.push(...items)
        },
        ...(options !== undefined ? { persistOptions: options } : {}),
    }
}

/** In-process row store with stable ids. */
export const createMemoryRowStore = <T>(
    initial: readonly RowRecord<T>[] = [],
    options?: RowPersistOptions,
): MemoryRowStore<T> & RowStoreHandle<T> => {
    const rows: RowRecord<T>[] = initial.map((row) => ({
        id: row.id,
        item: row.item,
    }))
    // id → index for O(1) upsert/remove lookup (splice still shifts the array).
    const indexById = new Map<string, number>()
    for (let i = 0; i < rows.length; i += 1) {
        indexById.set(rows[i]!.id, i)
    }

    const reindexFrom = (start: number): void => {
        for (let i = start; i < rows.length; i += 1) {
            indexById.set(rows[i]!.id, i)
        }
    }

    return {
        get rows() {
            return rows
        },
        loadAll: () => rows.map((row) => ({ id: row.id, item: row.item })),
        insert: (record) => {
            // Upsert by id so re-insert matches web-storage row store semantics
            // (order list stays unique; payload is replaced).
            const index = indexById.get(record.id)
            const next = { id: record.id, item: record.item }
            if (index !== undefined) {
                rows[index] = next
            } else {
                indexById.set(record.id, rows.length)
                rows.push(next)
            }
        },
        remove: (id) => {
            const index = indexById.get(id)
            if (index === undefined) return
            rows.splice(index, 1)
            indexById.delete(id)
            reindexFrom(index)
        },
        clear: () => {
            rows.length = 0
            indexById.clear()
        },
        ...(options !== undefined ? { persistOptions: options } : {}),
    }
}
