/**
 * Public persist contracts: store interfaces, row records, strategy options,
 * and event types. No queue-implementation imports — types only.
 */

import type { EventMap, MergeEventMaps } from '../events'
import type { Queue, QueueEvents } from '../queue/core/queue'

/**
 * One durable row, stable id + payload, ordered head → tail when loaded.
 * `id` must be a non-empty string (not whitespace-only) and unique among rows
 * in the same store/queue.
 */
export type RowRecord<T> = {
    id: string
    item: T
}

/**
 * Row-level backend (SQL table, KV with per-job keys, etc.).
 * `loadAll` must return rows in FIFO order (head first) with unique, non-empty
 * (not whitespace-only) ids. `withPersist` hydrate rejects empty,
 * whitespace-only, or duplicate ids before applying the snapshot to memory.
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

export type SnapshotPersistOptions = {
    /**
     * Automatically `save` after enqueue / dequeue / clear / replaceAll.
     * Defaults to `true`.
     */
    autoSave?: boolean
    /**
     * Delay before writing after a mutation when {@link autoSave} is true.
     *
     * - `0` or omitted: coalesce synchronous bursts into **one save per
     *   microtask** (default).
     * - `> 0`: wait this many milliseconds after the **last** mutation
     *   (timer resets on each enqueue/dequeue/clear/replaceAll).
     *
     * Explicit `persist()` is never debounced.
     * Call `flush()` (or `hydrate`) to force a pending auto-save onto the
     * write chain before continuing or exiting.
     *
     * Must be a safe integer ≥ 0.
     */
    autoSaveDebounceMs?: number
}

export type RowPersistOptions = {
    /**
     * Custom id factory for new rows (enqueue / replaceAll).
     * Defaults to {@link createId} (nanoid-style URL-safe alphabet).
     * Must return unique, non-empty ids (not whitespace-only); collisions throw
     * before memory or store mutation.
     */
    createId?: () => string
}

export type SnapshotStoreHandle<T> = SnapshotStore<T> & {
    readonly persistOptions?: SnapshotPersistOptions
}

export type RowStoreHandle<T> = RowStore<T> & {
    readonly persistOptions?: RowPersistOptions
}

export type SnapshotPersistEvents = {
    'persist:loaded': { size: number }
    'persist:saved': { size: number }
    'persist:error': {
        operation: 'load' | 'save'
        error: unknown
    }
}

export type RowPersistEvents<T> = {
    'persist:loaded': { size: number }
    'persist:inserted': { id: string; item: T }
    'persist:removed': { id: string; item: T }
    'persist:cleared': { removed: number }
    'persist:error': {
        operation: 'load' | 'insert' | 'remove' | 'clear'
        error: unknown
        id?: string
    }
}

export type QueueWithPersist<
    T,
    S extends 'snapshot' | 'row',
    TEvents extends EventMap = QueueEvents<T>,
> = Queue<
    T,
    MergeEventMaps<
        TEvents,
        S extends 'snapshot' ? SnapshotPersistEvents : RowPersistEvents<T>
    >
> & {
    hydrate: () => Promise<void>
    flush: () => Promise<void>
} & (S extends 'snapshot'
        ? { persist: () => Promise<void> }
        : { rowIds: () => string[] })
