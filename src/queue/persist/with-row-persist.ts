import {
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { forwardQueue } from '../core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents } from '../core/queue'
import { createId } from './create-id.util'
import {
    assertNotHydrating,
    createHydrateGate,
} from './hydrate-gate.util'
import { assertBareQueueForPersist, notifyQueueRestored } from './persist.support'
import type { RowStore } from './persist.types'
import { createRowIdList } from './row-ids.util'
import { createWriteChain } from './write-chain.util'

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
     * Custom id factory for new rows (enqueue).
     * Defaults to {@link createId} (nanoid-style URL-safe alphabet).
     * Must return unique ids under concurrent enqueue.
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
 * **Composition (required):** wrap the bare queue, then the worker:
 * `withWorker(withRowPersist(buildQueue(), store), worker)`.
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
 * - Concurrent mutations during `hydrate` throw.
 * - Call {@link QueueWithRowPersist.flush} to await pending writes.
 */
export const withRowPersist = <
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: RowStore<T>,
    options: RowPersistOptions = {},
): QueueWithRowPersist<T, RowQueueEvents<T, TEvents>> => {
    assertBareQueueForPersist(queue, 'withRowPersist')

    const nextId = options.createId ?? createId
    const inner = queue.expand<RowPersistEvents<T>>()
    const emitPersist = createTypedEmit<RowPersistEvents<T>>(
        inner.emit as (eventName: string, data: unknown) => void,
    )
    const gate = createHydrateGate()
    const writes = createWriteChain()
    const rowIdsList = createRowIdList()
    /** Suppress store scheduling while rebuilding after a failed insert. */
    let localSuppress = false

    const isSuppressing = (): boolean =>
        gate.isSuppressing() || localSuppress

    const trackError = (
        operation: RowPersistEvents<T>['persist:error']['operation'],
        error: unknown,
        id?: string,
    ): void => {
        emitPersist('persist:error', { operation, error, id })
    }

    /**
     * Remove one optimistic row from memory without store ops or queue events
     * (avoids false drain/refill for listeners during insert rollback).
     */
    const rollbackLocalById = (id: string): void => {
        const liveIds = rowIdsList.live()
        const liveIndex = liveIds.indexOf(id)
        if (liveIndex < 0) return

        const remainingItems = inner.toArray()
        remainingItems.splice(liveIndex, 1)
        liveIds.splice(liveIndex, 1)

        localSuppress = true
        try {
            rowIdsList.reset(liveIds)
            inner.replaceAll(remainingItems)
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

    const enqueue = (item: T): void => {
        assertNotHydrating(gate)

        const id = nextId()
        rowIdsList.push(id)

        // Schedule insert *before* the in-memory enqueue so stacked workers
        // (which dequeue on `queue:enqueued`) cannot put remove ahead of insert
        // on the write chain.
        if (!isSuppressing()) {
            scheduleStore(async () => {
                try {
                    await store.insert({ id, item })
                    emitPersist('persist:inserted', { id, item })
                } catch (error) {
                    rollbackLocalById(id)
                    trackError('insert', error, id)
                }
            })
        }

        inner.enqueue(item)
    }

    const dequeue = (): T | undefined => {
        assertNotHydrating(gate)

        const item = inner.dequeue()
        if (item === undefined) return undefined

        const id = rowIdsList.shift()
        if (id === undefined) return item

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

        const removed = rowIdsList.liveCount()
        if (removed === 0 && inner.isEmpty()) return

        rowIdsList.reset([])
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

    /**
     * Not supported on durable row queues: a full in-memory replace would
     * desync ids/store rows. Use {@link QueueWithRowPersist.hydrate} or
     * enqueue / dequeue / clear. Hydrate/rollback use the inner queue only.
     */
    const replaceAll = (_items: readonly T[]): void => {
        throw new Error(
            'replaceAll is not supported on row-persisted queues; ' +
                'use hydrate() to restore from the store, or enqueue/dequeue/clear',
        )
    }

    const hydrate = async (): Promise<void> => {
        await gate.run(async () => {
            try {
                // Finish in-flight writes before replacing memory from store.
                await writes.flush()
                const rows = await store.loadAll()

                // Silent rebuild: no queue:enqueued during gate (workers must
                // not dequeue while store removes are suppressed).
                rowIdsList.reset(rows.map((row) => row.id))
                inner.replaceAll(rows.map((row) => row.item))

                emitPersist('persist:loaded', { size: inner.size() })
            } catch (error) {
                trackError('load', error)
                throw error
            }
        })

        // Gate is open: kick workers so they dequeue with store removes enabled.
        notifyQueueRestored({
            size: inner.size,
            peek: inner.peek,
            emit: inner.emit as (eventName: string, data: unknown) => void,
        })
    }

    // `expand` must return this wrapper so stacked decorators keep overrides.
    const api: QueueWithRowPersist<T, RowQueueEvents<T, TEvents>> =
        markQueueLayer(
            forwardQueue(inner, {
                enqueue,
                dequeue,
                clear,
                replaceAll,
                expand: <TExtra extends EventMap>() =>
                    api as QueueWithRowPersist<
                        T,
                        MergeEventMaps<RowQueueEvents<T, TEvents>, TExtra>
                    >,
                hydrate,
                rowIds: () => rowIdsList.live(),
                flush: writes.flush,
            }),
            PERSIST_LAYER,
        )

    return api
}
