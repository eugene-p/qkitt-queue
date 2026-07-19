import {
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { decorateQueue } from '../core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents, QueueSlot } from '../core/queue'
import { assertNotHydrating } from './hydrate-gate.util'
import { createPersistenceLifecycle } from './persistence-lifecycle.util'
import { assertBareQueueForPersist } from './persist.support'
import type { SnapshotStore } from './persist.types'

export type { SnapshotStore } from './persist.types'

export type SnapshotPersistEvents = {
    'persist:loaded': { size: number }
    'persist:saved': { size: number }
    'persist:error': {
        operation: 'load' | 'save'
        error: unknown
    }
}

export type SnapshotPersistOptions = {
    /**
     * Automatically `save` after enqueue / dequeue / clear.
     * Defaults to `true`.
     */
    autoSave?: boolean
}

type SnapshotQueueEvents<T, TEvents extends EventMap> = MergeEventMaps<
    TEvents,
    SnapshotPersistEvents
>

export type QueueWithSnapshotPersist<
    T,
    TEvents extends EventMap = SnapshotQueueEvents<T, QueueEvents<T>>,
> = Queue<T, TEvents> & {
    /**
     * Replace in-memory queue contents from the store.
     * If the store backend may hang, wrap in `Promise.race` with a timeout;
     * the hydrate gate has no built-in deadline.
     */
    hydrate: () => Promise<void>
    /** Write the current queue (head → tail) to the store. */
    persist: () => Promise<void>
    /** Wait for pending auto-saves (and in-flight `persist`) to settle. */
    flush: () => Promise<void>
}

/**
 * Persist the whole queue as one snapshot.
 * Good for simple backends where you rewrite the full list each time.
 *
 * **Composition (required):** wrap the bare queue, then the worker:
 * `withWorker(withSnapshotPersist(buildQueue(), store), worker)`.
 *
 * Uses silent hydrate rebuild + a post-gate `queue:enqueued` kick so stacked
 * workers process restored items only after auto-save is allowed again.
 * Concurrent mutations during `hydrate` throw {@link QueueHydratingError}.
 * A second concurrent `hydrate()` rejects with “hydrate already in progress”.
 * The hydrate gate has no built-in deadline: if the store may hang, wrap
 * `hydrate()` in `Promise.race` with a timeout.
 */
export const withSnapshotPersist = <
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: SnapshotStore<T>,
    options: SnapshotPersistOptions = {},
): QueueWithSnapshotPersist<T, SnapshotQueueEvents<T, TEvents>> => {
    assertBareQueueForPersist(queue, 'withSnapshotPersist')

    const autoSave = options.autoSave ?? true
    const inner = queue
    const emitPersist = createTypedEmit<SnapshotPersistEvents>(
        inner.emit as (eventName: string, data: unknown) => void,
    )

    const lifecycle = createPersistenceLifecycle({
        loadAndReplace: async () => {
            const items = await store.load()
            // Silent rebuild — no queue events / auto-save during gate.
            inner.replaceAll(items)
            emitPersist('persist:loaded', { size: inner.size() })
        },
        onLoadError: (error) => {
            emitPersist('persist:error', { operation: 'load', error })
        },
        notify: {
            size: inner.size,
            peek: inner.peek,
            emit: inner.emit as (eventName: string, data: unknown) => void,
        },
    })

    const { gate, writes, hydrate, flush } = lifecycle

    const persist = (): Promise<void> =>
        writes.push(async () => {
            try {
                const items = inner.toArray()
                await store.save(items)
                emitPersist('persist:saved', { size: items.length })
            } catch (error) {
                emitPersist('persist:error', { operation: 'save', error })
                throw error
            }
        })

    const scheduleSave = (): void => {
        // Mutators already assertNotHydrating(gate); hydrate uses inner only.
        if (!autoSave) return
        void persist().catch(() => {
            // Error already emitted as persist:error.
        })
    }

    const enqueue = (item: T): void => {
        assertNotHydrating(gate)
        inner.enqueue(item)
        scheduleSave()
    }

    const tryDequeue = (): QueueSlot<T> | undefined => {
        assertNotHydrating(gate)
        const slot = inner.tryDequeue()
        if (slot !== undefined) {
            scheduleSave()
        }
        return slot
    }

    const dequeue = (): T | undefined => {
        const slot = tryDequeue()
        return slot === undefined ? undefined : slot.value
    }

    const clear = (): void => {
        assertNotHydrating(gate)
        if (inner.isEmpty()) return
        inner.clear()
        scheduleSave()
    }

    const replaceAll = (items: readonly T[]): void => {
        assertNotHydrating(gate)
        inner.replaceAll(items)
        scheduleSave()
    }

    const api = markQueueLayer(
        decorateQueue(inner, {
            enqueue,
            dequeue,
            tryDequeue,
            clear,
            replaceAll,
            hydrate,
            persist,
            flush,
        }),
        PERSIST_LAYER,
    )

    return api as unknown as QueueWithSnapshotPersist<
        T,
        SnapshotQueueEvents<T, TEvents>
    >
}
