/** One durable row, stable id + payload, ordered head → tail when loaded. */
export type RowRecord<T> = {
    id: string
    item: T
}

/**
 * Row-level backend (SQL table, KV with per-job keys, etc.).
 * `loadAll` must return rows in FIFO order (head first).
 */
export type RowStore<T> = {
    loadAll: () => readonly RowRecord<T>[] | Promise<readonly RowRecord<T>[]>
    insert: (record: RowRecord<T>) => void | Promise<void>
    remove: (id: string) => void | Promise<void>
    clear: () => void | Promise<void>
}

/** Whole-queue dump/restore backend (file, redis key, etc.). */
export type SnapshotStore<T> = {
    /** Load items head → tail. */
    load: () => readonly T[] | Promise<readonly T[]>
    /** Replace the stored snapshot with the full queue. */
    save: (items: readonly T[]) => void | Promise<void>
}
