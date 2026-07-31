import type { RowRecord, RowStore } from '../contracts'

export type MemoryRowStore<T> = RowStore<T> & {
    /** Live rows (mutated by put/remove/clear). Order is insertion-ish, not FIFO. */
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

const assignRecord = <T>(target: RowRecord<T>, source: RowRecord<T>): void => {
    // id is the map key and does not change on upsert.
    target.item = source.item
    target.availableAt = source.availableAt
    target.leaseGeneration = source.leaseGeneration
    target.leaseExpiresAt = source.leaseExpiresAt
    if (source.attempt === undefined) delete target.attempt
    else target.attempt = source.attempt
    if (source.dlqHandoffAttempt === undefined) delete target.dlqHandoffAttempt
    else target.dlqHandoffAttempt = source.dlqHandoffAttempt
}

/**
 * In-process row store with numeric ids and full row state.
 *
 * Hot path: O(1) put/remove via id→index map + swap-remove.
 * - Upsert of an existing id mutates the stored row in place (no alloc).
 * - Insert of a new id **takes ownership** of the passed record (no clone).
 *   Callers must not mutate the object after `put` (the queue always allocates
 *   a fresh record per write).
 * - `loadAll` still returns clones so external snapshots are isolated.
 */
export const createMemoryRowStore = <T>(
    initial: readonly RowRecord<T>[] = [],
): MemoryRowStore<T> => {
    const rows: RowRecord<T>[] = []
    /** id → index in `rows`. */
    const indexById = new Map<number, number>()

    for (let i = 0; i < initial.length; i += 1) {
        const next = cloneRecord(initial[i]!)
        indexById.set(next.id, rows.length)
        rows.push(next)
    }

    const putOne = (record: RowRecord<T>): void => {
        const index = indexById.get(record.id)
        if (index !== undefined) {
            assignRecord(rows[index]!, record)
            return
        }
        // Ownership of `record` — avoids a clone on every durable enqueue.
        indexById.set(record.id, rows.length)
        rows.push(record)
    }

    const removeOne = (id: number): void => {
        const index = indexById.get(id)
        if (index === undefined) return
        const last = rows.length - 1
        if (index !== last) {
            const moved = rows[last]!
            rows[index] = moved
            indexById.set(moved.id, index)
        }
        rows.pop()
        indexById.delete(id)
    }

    return {
        get rows() {
            return rows
        },
        loadAll: () => {
            const n = rows.length
            const out = new Array<RowRecord<T>>(n)
            for (let i = 0; i < n; i += 1) {
                out[i] = cloneRecord(rows[i]!)
            }
            return out
        },
        put: putOne,
        remove: removeOne,
        clear: () => {
            rows.length = 0
            indexById.clear()
        },
        putBatch: (records) => {
            for (let i = 0; i < records.length; i += 1) {
                putOne(records[i]!)
            }
        },
        removeBatch: (ids) => {
            for (let i = 0; i < ids.length; i += 1) {
                removeOne(ids[i]!)
            }
        },
        replaceAll: (records) => {
            rows.length = 0
            indexById.clear()
            for (let i = 0; i < records.length; i += 1) {
                // Clone on replaceAll: input may be reused / frozen by callers.
                const next = cloneRecord(records[i]!)
                indexById.set(next.id, rows.length)
                rows.push(next)
            }
        },
    }
}
