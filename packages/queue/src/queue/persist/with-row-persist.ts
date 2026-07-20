import {
    buildEventEmitter,
    createTypedEmit,
    type EventCallback,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { decorateQueue } from '../core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents, QueueSlot } from '../core/queue'
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
    /**
     * Replace in-memory queue from store rows (head → tail).
     * If the store backend may hang, wrap in `Promise.race` with a timeout;
     * the hydrate gate has no built-in deadline.
     */
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
 * - The hydrate gate has no built-in deadline: if the store may hang, wrap
 *   `hydrate()` in `Promise.race` with a timeout.
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

    // Incremental id set: O(1) uniqueness checks (avoids toArray+Set per enqueue).
    const idSet = new Set<string>()

    const rebuildIdSet = (rows: readonly RowRecord<T>[]): void => {
        idSet.clear()
        for (let i = 0; i < rows.length; i += 1) {
            idSet.add(rows[i]!.id)
        }
    }

    // Integer sub counts: skip mapRowPayload + outer emit when nobody listens.
    let enqueuedSubs = 0
    let dequeuedSubs = 0

    const bumpQueueSubs = (
        eventName: keyof QueueEvents<T>,
        delta: number,
    ): void => {
        if (eventName === 'queue:enqueued') enqueuedSubs += delta
        else if (eventName === 'queue:dequeued') dequeuedSubs += delta
    }

    const mapRowPayload = (payload: {
        item: RowRecord<T>
        size: number
    }): { item: T; size: number } => ({
        item: payload.item.item,
        size: payload.size,
    })

    inner.on('queue:enqueued', (payload) => {
        if (enqueuedSubs === 0) return
        emitter.emit('queue:enqueued', mapRowPayload(payload))
    })
    inner.on('queue:dequeued', (payload) => {
        if (dequeuedSubs === 0) return
        emitter.emit('queue:dequeued', mapRowPayload(payload))
    })
    inner.on('queue:emptied', () => {
        emitter.emit('queue:emptied', undefined)
    })
    inner.on('queue:cleared', (payload) => {
        emitter.emit('queue:cleared', payload)
    })

    const on: QueueWithRowPersist<T>['on'] = (eventName, callback) => {
        const unsubscribe = emitter.on(eventName, callback)
        if (
            eventName === 'queue:enqueued' ||
            eventName === 'queue:dequeued'
        ) {
            bumpQueueSubs(eventName, 1)
            return () => {
                unsubscribe()
                bumpQueueSubs(eventName, -1)
            }
        }
        return unsubscribe
    }

    const once: QueueWithRowPersist<T>['once'] = (eventName, callback) => {
        if (
            eventName !== 'queue:enqueued' &&
            eventName !== 'queue:dequeued'
        ) {
            return emitter.once(eventName, callback)
        }

        bumpQueueSubs(eventName, 1)
        let settled = false
        const release = (): void => {
            if (settled) return
            settled = true
            bumpQueueSubs(eventName, -1)
        }
        const unsubscribe = emitter.once(
            eventName,
            (data) => {
                release()
                ;(callback as EventCallback<typeof data>)(data)
            },
        )
        return () => {
            unsubscribe()
            release()
        }
    }

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
            rebuildIdSet(rows)
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

    /**
     * Remove one optimistic row from memory without store ops or queue events
     * (avoids false drain/refill for listeners during insert rollback).
     * Uses `inner.replaceAll` (silent bare queue), not the decorated public API.
     */
    const rollbackLocalById = (id: string): void => {
        if (!idSet.has(id)) return
        const remaining = inner.toArray().filter((row) => row.id !== id)
        if (remaining.length === inner.size()) return
        inner.replaceAll(remaining)
        idSet.delete(id)
    }

    const scheduleStore = (op: () => Promise<void>): void => {
        void writes.push(op).catch(() => {
            // Errors are emitted inside each op.
        })
    }

    const enqueue = (item: T): void => {
        assertNotHydrating(gate)

        const id = assertUniqueRowId(nextId(), idSet)
        const record = { id, item }

        // Reserve id before enqueue so nested enqueue (from queue:enqueued
        // handlers) still sees it for uniqueness. Roll back if enqueue throws
        // (e.g. QueueFullError) so the set cannot leak.
        //
        // Schedule insert *before* the in-memory enqueue so stacked workers
        // (which dequeue on `queue:enqueued`) cannot put remove ahead of insert
        // on the write chain. If enqueue throws, the op no-ops via `accepted`.
        idSet.add(id)
        let accepted = false
        scheduleStore(async () => {
            if (!accepted) return
            try {
                await store.insert(record)
                emitPersist('persist:inserted', { id, item })
            } catch (error) {
                rollbackLocalById(id)
                trackError('insert', error, id)
            }
        })

        try {
            inner.enqueue(record)
            accepted = true
        } catch (error) {
            idSet.delete(id)
            throw error
        }
    }

    const tryDequeue = (): QueueSlot<T> | undefined => {
        assertNotHydrating(gate)

        // Inner holds RowRecord wrappers; empty = no slot, not nullish payload.
        const held = inner.tryDequeue()
        if (held === undefined) return undefined

        const { id, item } = held.value
        idSet.delete(id)

        scheduleStore(async () => {
            try {
                await store.remove(id)
                emitPersist('persist:removed', { id, item })
            } catch (error) {
                trackError('remove', error, id)
            }
        })

        return { value: item }
    }

    const dequeue = (): T | undefined => {
        const slot = tryDequeue()
        return slot === undefined ? undefined : slot.value
    }

    const tryPeek = (): QueueSlot<T> | undefined => {
        const held = inner.tryPeek()
        if (held === undefined) return undefined
        return { value: held.value.item }
    }

    const peek = (): T | undefined => {
        const slot = tryPeek()
        return slot === undefined ? undefined : slot.value
    }

    const clear = (): void => {
        assertNotHydrating(gate)

        const removed = inner.size()
        if (removed === 0) return

        inner.clear()
        idSet.clear()

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
        rebuildIdSet(records)

        scheduleStore(async () => {
            try {
                await store.clear()
            } catch (error) {
                trackError('clear', error)
                return
            }
            if (removed > 0) {
                emitPersist('persist:cleared', { removed })
            }
            for (const record of records) {
                try {
                    await store.insert(record)
                    emitPersist('persist:inserted', {
                        id: record.id,
                        item: record.item,
                    })
                } catch (error) {
                    trackError('insert', error, record.id)
                    return
                }
            }
        })
    }

    const toArray = (): T[] => {
        const rows = inner.toArray()
        const items = new Array<T>(rows.length)
        for (let i = 0; i < rows.length; i += 1) {
            items[i] = rows[i]!.item
        }
        return items
    }

    const rowIds = (): string[] => {
        const rows = inner.toArray()
        const ids = new Array<string>(rows.length)
        for (let i = 0; i < rows.length; i += 1) {
            ids[i] = rows[i]!.id
        }
        return ids
    }

    const api = markQueueLayer(
        decorateQueue(inner, {
            enqueue,
            dequeue,
            tryDequeue,
            peek,
            tryPeek,
            toArray,
            clear,
            replaceAll,
            on,
            once,
            emit: emitter.emit,
            hydrate,
            rowIds,
            flush,
        }),
        PERSIST_LAYER,
    )

    return api as unknown as QueueWithRowPersist<
        T,
        RowQueueEvents<T, QueueEvents<T>>
    >
}
