import {
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { forwardQueue } from '../core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../core/layers.util'
import type { Queue, QueueEvents } from '../core/queue'
import {
    assertNotHydrating,
    createHydrateGate,
} from './hydrate-gate.util'
import { assertBareQueueForPersist, notifyQueueRestored } from './persist.support'
import type { SnapshotStore } from './persist.types'
import { createWriteChain } from './write-chain.util'

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
    /** Replace in-memory queue contents from the store. */
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
 * Concurrent mutations during `hydrate` throw.
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
    const inner = queue.expand<SnapshotPersistEvents>()
    const emitPersist = createTypedEmit<SnapshotPersistEvents>(
        inner.emit as (eventName: string, data: unknown) => void,
    )
    const gate = createHydrateGate()
    const writes = createWriteChain()

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
        if (gate.isSuppressing() || !autoSave) return
        void persist().catch(() => {
            // Error already emitted as persist:error.
        })
    }

    const enqueue = (item: T): void => {
        assertNotHydrating(gate)
        inner.enqueue(item)
        scheduleSave()
    }

    const dequeue = (): T | undefined => {
        assertNotHydrating(gate)
        const item = inner.dequeue()
        if (item !== undefined) {
            scheduleSave()
        }
        return item
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

    const hydrate = async (): Promise<void> => {
        await gate.run(async () => {
            try {
                // Finish pending auto-saves before replacing memory from store.
                await writes.flush()
                const items = await store.load()
                // Silent rebuild — no queue events / auto-save during gate.
                inner.replaceAll(items)
                emitPersist('persist:loaded', { size: inner.size() })
            } catch (error) {
                emitPersist('persist:error', { operation: 'load', error })
                throw error
            }
        })

        // Kick stacked workers after the gate so dequeues schedule saves.
        notifyQueueRestored({
            size: inner.size,
            peek: inner.peek,
            emit: inner.emit as (eventName: string, data: unknown) => void,
        })
    }

    // `expand` must return this wrapper so stacked decorators keep overrides.
    const api: QueueWithSnapshotPersist<T, SnapshotQueueEvents<T, TEvents>> =
        markQueueLayer(
            forwardQueue(inner, {
                enqueue,
                dequeue,
                clear,
                replaceAll,
                expand: <TExtra extends EventMap>() =>
                    api as QueueWithSnapshotPersist<
                        T,
                        MergeEventMaps<SnapshotQueueEvents<T, TEvents>, TExtra>
                    >,
                hydrate,
                persist,
                flush: writes.flush,
            }),
            PERSIST_LAYER,
        )

    return api
}
