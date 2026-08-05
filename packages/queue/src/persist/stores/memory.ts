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
    type Node = {
        record: RowRecord<T>
        prev: number | undefined
        next: number | undefined
    }
    const nodes = new Map<number, Node>()
    let head: number | undefined
    let tail: number | undefined

    const append = (record: RowRecord<T>): void => {
        const id = record.id
        nodes.set(id, { record, prev: tail, next: undefined })
        if (tail === undefined) head = id
        else nodes.get(tail)!.next = id
        tail = id
    }

    for (const record of initial) {
        const next = cloneRecord(record)
        if (!nodes.has(record.id)) append(next)
        else nodes.get(record.id)!.record = next
    }

    const putOne = (record: RowRecord<T>): void => {
        const next = cloneRecord(record)
        const node = nodes.get(record.id)
        if (node === undefined) append(next)
        else node.record = next
    }

    const removeOne = (id: number): void => {
        const node = nodes.get(id)
        if (node === undefined) return
        nodes.delete(id)
        if (node.prev === undefined) head = node.next
        else nodes.get(node.prev)!.next = node.next
        if (node.next === undefined) tail = node.prev
        else nodes.get(node.next)!.prev = node.prev
    }

    const currentRows = (): RowRecord<T>[] => {
        const out: RowRecord<T>[] = []
        for (let id = head; id !== undefined; id = nodes.get(id)!.next) {
            out.push(nodes.get(id)!.record)
        }
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
            nodes.clear()
            head = undefined
            tail = undefined
        },
        putBatch: (records) => {
            for (const record of records) putOne(record)
        },
        removeBatch: (ids) => {
            for (const id of new Set(ids)) removeOne(id)
        },
        replaceAll: (nextRecords) => {
            nodes.clear()
            head = undefined
            tail = undefined
            for (const record of nextRecords) {
                putOne(record)
            }
        },
    }
}
