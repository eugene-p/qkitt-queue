/**
 * Row persist strategy (private — consume via `withPersist`).
 *
 * Callers pass a bare `Queue<T>`; internally an inner `Queue<RowRecord<T>>`
 * is built to track row ids. The public surface remains plain `T`.
 */

import {
    buildEventEmitter,
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { decorateQueue } from '../../queue/core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../../queue/core/layers.util'
import {
    buildQueue,
    type Queue,
    type QueueEvents,
    type QueueSlot,
} from '../../queue/core/queue'
import { getQueueMaxSize } from '../../queue/core/queue-max-size.util'
import type {
    QueueWithPersist,
    RowPersistEvents,
    RowPersistOptions,
    RowRecord,
    RowStore,
} from '../contracts'
import { createId } from '../create-id.util'
import { assertNotHydrating } from '../hydrate-gate.util'
import { createPersistenceLifecycle } from './lifecycle.util'
import { assertUniqueRowId, assertUniqueRowIds } from './row-id.util'

type RowQueueEvents<T, TEvents extends EventMap> = MergeEventMaps<
    TEvents,
    RowPersistEvents<T>
>

/**
 * Attach row-level persistence to a bare queue (private strategy implementation).
 *
 * The inner queue holds `RowRecord<T>` (`{ id, item }`) so the store can key
 * by id. The decorated public surface is still `T` — you enqueue plain jobs.
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
 * - A second concurrent `hydrate()` rejects with "hydrate already in progress".
 * - Row ids from `createId` / `loadAll` must be unique and non-empty (not whitespace-only).
 * - Call `flush()` to await pending writes.
 */
export const attachRowPersist = <
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: RowStore<T>,
    options: RowPersistOptions = {},
): QueueWithPersist<T, 'row', TEvents> => {
    const nextId = options.createId ?? createId

    // Build the inner RowRecord queue, preserving maxSize from the caller's queue.
    const maxSize = getQueueMaxSize(queue)
    const inner = buildQueue<RowRecord<T>>(
        maxSize !== undefined ? { maxSize } : {},
    )

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

    const on: Queue<T, RowQueueEvents<T, QueueEvents<T>>>['on'] = (
        eventName,
        callback,
    ) => {
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
            emit: emitter.emit,
            hydrate,
            rowIds,
            flush,
        }),
        PERSIST_LAYER,
    )

    return api as unknown as QueueWithPersist<T, 'row', TEvents>
}
