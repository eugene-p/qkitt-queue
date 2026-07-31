import type { RowRecord, RowStore } from '../contracts'

export type MemoryRowStore<T> = RowStore<T> & {
    /** Live rows, kept in insertion order. */
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
    const rows: RowRecord<T>[] = initial.map(cloneRecord)

    const putOne = (record: RowRecord<T>): void => {
        const index = rows.findIndex((row) => row.id === record.id)
        const next = cloneRecord(record)
        if (index >= 0) rows[index] = next
        else rows.push(next)
    }

    const removeOne = (id: number): void => {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
    }

    return {
        get rows() {
            return rows
        },
        loadAll: () => rows.map(cloneRecord),
        put: putOne,
        remove: removeOne,
        clear: () => {
            rows.length = 0
        },
        putBatch: (records) => {
            for (const record of records) putOne(record)
        },
        removeBatch: (ids) => {
            for (const id of ids) removeOne(id)
        },
        replaceAll: (records) => {
            rows.length = 0
            for (const record of records) rows.push(cloneRecord(record))
        },
    }
}
