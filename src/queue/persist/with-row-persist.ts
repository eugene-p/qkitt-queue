import {
    buildEventEmitter,
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { decorateQueue } from '../core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents } from '../core/queue'
import { createId } from './create-id.util'
import { assertNotHydrating } from './hydrate-gate.util'
import { createPersistenceLifecycle } from './persistence-lifecycle.util'
import { assertBareQueueForPersist } from './persist.support'
import type { RowRecord, RowStore } from './persist.types'
import { assertUniqueRowId, assertUniqueRowIds } from './row-id.util'

export { createId } from './create-id.util'
export type { RowRecord, RowStore } from './persist.types'

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

export type RowPersistOptions = {
    /**
     * Custom id factory for new rows (enqueue / replaceAll).
     * Defaults to {@link createId} (nanoid-style URL-safe alphabet).
     * Must return unique, non-empty ids (not whitespace-only); collisions throw
     * before memory or store mutation.
     *
     * @example
     * withRowPersist(queue, store, { createId: () => crypto.randomUUID() })
     */
    createId?: () => string
}

type RowQueueEvents<T, TEvents extends EventMap> = MergeEventMaps<
    TEvents,
    RowPersistEvents<T>
>

export type QueueWithRowPersist<
    T,
    TEvents extends EventMap = RowQueueEvents<T, QueueEvents<T>>,
> = Queue<T, TEvents> & {
    /** Replace in-memory queue from store rows (head → tail). */
    hydrate: () => Promise<void>
    /** Ids currently in the queue, head → tail (aligned with `toArray()`). */
    rowIds: () => string[]
    /**
     * Wait for pending store mutations to settle.
     * Store writes are async (enqueue/dequeue stay sync); use this when you
     * need durability before continuing (e.g. before process exit).
     */
    flush: () => Promise<void>
}

/**
 * Persist each queue mutation as a row operation.
 * Good for DB-style backends where enqueue/dequeue map to insert/delete.
 *
 * **Composition (required):** wrap a bare `RowRecord` queue, then the worker:
 * `withWorker(withRowPersist(buildQueue<RowRecord<T>>(), store), worker)`.
 * Reverse order silently skips store removes — this helper throws if it
 * detects a worker already on the queue.
 *
 * Durability:
 * - Memory updates are optimistic and synchronous (API stays sync).
 * - Store ops are serialized on a write chain.
 * - Failed **insert** rolls back that row from memory if it is still present.
 * - Failed **remove** / **clear** emit `persist:error` (memory already changed;
 *   call `hydrate` to resync if needed).
 * - `hydrate` uses a silent rebuild (no mid-hydrate worker drain of the store),
 *   then emits one `queue:enqueued` so stacked workers pump after the gate opens.
 * - Concurrent mutations during `hydrate` throw {@link QueueHydratingError}.
 * - A second concurrent `hydrate()` rejects with “hydrate already in progress”.
 * - Row ids from `createId` / `loadAll` must be unique and non-empty (not whitespace-only).
 * - Call {@link QueueWithRowPersist.flush} to await pending writes.
 */
export const withRowPersist = <
    T,
    TInnerEvents extends QueueEvents<RowRecord<T>> = QueueEvents<RowRecord<T>>,
>(
    queue: Queue<RowRecord<T>, TInnerEvents>,
    store: RowStore<T>,
    options: RowPersistOptions = {},
): QueueWithRowPersist<T, RowQueueEvents<T, QueueEvents<T>>> => {
    assertBareQueueForPersist(queue, 'withRowPersist')

    const nextId = options.createId ?? createId
    const inner = queue
    const emitter = buildEventEmitter<RowQueueEvents<T, QueueEvents<T>>>()
    const emitPersist = createTypedEmit<RowPersistEvents<T>>(
        emitter.emit as (eventName: string, data: unknown) => void,
    )
    /** Suppress store scheduling while rebuilding after a failed insert. */
    let localSuppress = false

    const mapRowPayload = (payload: {
        item: RowRecord<T>
        size: number
    }): { item: T; size: number } => ({
        item: payload.item.item,
        size: payload.size,
    })

    inner.on('queue:enqueued', (payload) => {
        emitter.emit('queue:enqueued', mapRowPayload(payload))
    })
    inner.on('queue:dequeued', (payload) => {
        emitter.emit('queue:dequeued', mapRowPayload(payload))
    })
    inner.on('queue:emptied', () => {
        emitter.emit('queue:emptied', undefined)
    })
    inner.on('queue:cleared', (payload) => {
        emitter.emit('queue:cleared', payload)
    })

    const trackError = (
        operation: RowPersistEvents<T>['persist:error']['operation'],
        error: unknown,
        id?: string,
    ): void => {
        emitPersist('persist:error', { operation, error, id })
    }

    const lifecycle = createPersistenceLifecycle({
        loadAndReplace: async () => {
            const rows = await store.loadAll()
            assertUniqueRowIds(rows)
            // Silent rebuild: no queue:enqueued during gate (workers must
            // not dequeue while store removes are suppressed).
            inner.replaceAll(rows)
            emitPersist('persist:loaded', { size: inner.size() })
        },
        onLoadError: (error) => {
            trackError('load', error)
        },
        notify: {
            size: inner.size,
            peek: () => inner.peek()?.item,
            emit: emitter.emit as (eventName: string, data: unknown) => void,
        },
    })

    const { gate, writes, hydrate, flush } = lifecycle

    const isSuppressing = (): boolean =>
        gate.isSuppressing() || localSuppress

    /**
     * Remove one optimistic row from memory without store ops or queue events
     * (avoids false drain/refill for listeners during insert rollback).
     */
    const rollbackLocalById = (id: string): void => {
        const remaining = inner.toArray().filter((row) => row.id !== id)
        if (remaining.length === inner.size()) return

        localSuppress = true
        try {
            inner.replaceAll(remaining)
        } finally {
            localSuppress = false
        }
    }

    const scheduleStore = (op: () => Promise<void>): void => {
        if (isSuppressing()) return
        void writes.push(op).catch(() => {
            // Errors are emitted inside each op.
        })
    }

    const currentIds = (): Set<string> =>
        new Set(inner.toArray().map((row) => row.id))

    const enqueue = (item: T): void => {
        assertNotHydrating(gate)

        const id = assertUniqueRowId(nextId(), currentIds())
        const record = { id, item }

        // Schedule insert *before* the in-memory enqueue so stacked workers
        // (which dequeue on `queue:enqueued`) cannot put remove ahead of insert
        // on the write chain.
        if (!isSuppressing()) {
            scheduleStore(async () => {
                try {
                    await store.insert(record)
                    emitPersist('persist:inserted', { id, item })
                } catch (error) {
                    rollbackLocalById(id)
                    trackError('insert', error, id)
                }
            })
        }

        inner.enqueue(record)
    }

    const dequeue = (): T | undefined => {
        assertNotHydrating(gate)

        const record = inner.dequeue()
        if (record === undefined) return undefined

        const { id, item } = record

        if (isSuppressing()) return item

        scheduleStore(async () => {
            try {
                await store.remove(id)
                emitPersist('persist:removed', { id, item })
            } catch (error) {
                trackError('remove', error, id)
            }
        })

        return item
    }

    const clear = (): void => {
        assertNotHydrating(gate)

        const removed = inner.size()
        if (removed === 0 && inner.isEmpty()) return

        inner.clear()

        if (isSuppressing()) return

        scheduleStore(async () => {
            try {
                await store.clear()
                emitPersist('persist:cleared', { removed })
            } catch (error) {
                trackError('clear', error)
            }
        })
    }

    const replaceAll = (items: readonly T[]): void => {
        assertNotHydrating(gate)

        const removed = inner.size()
        const seen = new Set<string>()
        const records: RowRecord<T>[] = items.map((item) => {
            const id = assertUniqueRowId(nextId(), seen)
            seen.add(id)
            return { id, item }
        })

        inner.replaceAll(records)

        if (isSuppressing()) return

        scheduleStore(async () => {
            try {
                await store.clear()
                if (removed > 0) {
                    emitPersist('persist:cleared', { removed })
                }
                for (const record of records) {
                    await store.insert(record)
                    emitPersist('persist:inserted', {
                        id: record.id,
                        item: record.item,
                    })
                }
            } catch (error) {
                trackError('clear', error)
            }
        })
    }

    const api = markQueueLayer(
        decorateQueue(inner, {
            enqueue,
            dequeue,
            peek: () => inner.peek()?.item,
            toArray: () => inner.toArray().map((row) => row.item),
            clear,
            replaceAll,
            on: emitter.on,
            once: emitter.once,
            off: emitter.off,
            emit: emitter.emit,
            hydrate,
            rowIds: () => inner.toArray().map((row) => row.id),
            flush,
        }),
        PERSIST_LAYER,
    )

    return api as unknown as QueueWithRowPersist<
        T,
        RowQueueEvents<T, QueueEvents<T>>
    >
}
