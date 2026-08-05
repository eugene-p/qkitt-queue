import type { RowRecord, RowStore } from '../contracts'

export type MemoryRowStore<T> = RowStore<T> & {
    /** Current rows in insertion order (materialized when read). */
    readonly rows: RowRecord<T>[]
}

const cloneRecord = <T>(row: RowRecord<T>): RowRecord<T> => ({
    id: row.id,
    item: row.item,
    availableAt: row.availableAt,
    leaseGeneration: row.leaseGeneration,
    leaseExpiresAt: row.leaseExpiresAt,
    ...(row.attempt !== undefined ? { attempt: row.attempt } : {}),
    ...(row.dlqHandoffAttempt !== undefined
        ? { dlqHandoffAttempt: row.dlqHandoffAttempt }
        : {}),
})

/** In-process row store with numeric ids and full row state. */
export const createMemoryRowStore = <T>(
    initial: readonly RowRecord<T>[] = [],
): MemoryRowStore<T> => {
    // Map preserves insertion order while delete remains O(1), so no linked
    // nodes or tombstone/order arrays are needed for the in-process backend.
    const rowsById = new Map<number, RowRecord<T>>()

    for (const record of initial) {
        const next = cloneRecord(record)
        rowsById.set(record.id, next)
    }

    const putOne = (record: RowRecord<T>): void => {
        rowsById.set(record.id, cloneRecord(record))
    }

    const removeOne = (id: number): void => {
        rowsById.delete(id)
    }

    const currentRows = (): RowRecord<T>[] => {
        const out: RowRecord<T>[] = []
        for (const record of rowsById.values()) out.push(record)
        return out
    }

    return {
        get rows() {
            return currentRows()
        },
        loadAll: () =>
            currentRows().map(cloneRecord),
        put: putOne,
        remove: removeOne,
        clear: () => {
            rowsById.clear()
        },
        putBatch: (records) => {
            for (const record of records) putOne(record)
        },
        removeBatch: (ids) => {
            for (const id of new Set(ids)) removeOne(id)
        },
        replaceAll: (nextRecords) => {
            rowsById.clear()
            for (const record of nextRecords) {
                putOne(record)
            }
        },
    }
}
