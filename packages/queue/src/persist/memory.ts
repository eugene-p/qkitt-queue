import type {
    RowRecord,
    RowStore,
    SnapshotStore,
} from '../queue/persist/persist.types'

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
): MemorySnapshotStore<T> => {
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
    }
}

/** In-process row store with stable ids. */
export const createMemoryRowStore = <T>(
    initial: readonly RowRecord<T>[] = [],
): MemoryRowStore<T> => {
    const rows: RowRecord<T>[] = initial.map((row) => ({
        id: row.id,
        item: row.item,
    }))

    return {
        get rows() {
            return rows
        },
        loadAll: () => rows.map((row) => ({ id: row.id, item: row.item })),
        insert: (record) => {
            // Upsert by id so re-insert matches web-storage row store semantics
            // (order list stays unique; payload is replaced).
            const index = rows.findIndex((row) => row.id === record.id)
            const next = { id: record.id, item: record.item }
            if (index >= 0) {
                rows[index] = next
            } else {
                rows.push(next)
            }
        },
        remove: (id) => {
            const index = rows.findIndex((row) => row.id === id)
            if (index >= 0) {
                rows.splice(index, 1)
            }
        },
        clear: () => {
            rows.length = 0
        },
    }
}
