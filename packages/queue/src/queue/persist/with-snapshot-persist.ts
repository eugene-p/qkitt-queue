import {
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { isIntegerInRange } from '../../util/number.util'
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
     * Explicit {@link QueueWithSnapshotPersist.persist} is never debounced.
     * Call {@link QueueWithSnapshotPersist.flush} (or `hydrate`) to force a
     * pending auto-save onto the write chain before continuing or exiting.
     *
     * Must be a safe integer ≥ 0.
     */
    autoSaveDebounceMs?: number
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

const resolveAutoSaveDebounceMs = (value: number | undefined): number => {
    const ms = value ?? 0
    if (!isIntegerInRange(ms, 0)) {
        throw new Error('autoSaveDebounceMs must be a safe integer >= 0')
    }
    return ms
}

type TimerHandle = unknown

const scheduleTimeout = (fn: () => void, delay: number): TimerHandle => {
    const schedule = (
        globalThis as unknown as {
            setTimeout: (cb: () => void, ms: number) => unknown
        }
    ).setTimeout
    return schedule(fn, delay)
}

const cancelTimeout = (handle: TimerHandle): void => {
    const clear = (
        globalThis as unknown as {
            clearTimeout: (id: unknown) => void
        }
    ).clearTimeout
    clear(handle)
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
 *
 * Auto-save coalesces burst mutations (microtask by default, or
 * {@link SnapshotPersistOptions.autoSaveDebounceMs}). Prefer `flush()` before
 * process exit when durability matters. `flush()` waits for pending auto-saves;
 * `persist()` writes a full snapshot immediately (never debounced).
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
    const autoSaveDebounceMs = resolveAutoSaveDebounceMs(
        options.autoSaveDebounceMs,
    )
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

    const { gate, writes, hydrate: hydrateCore, flush: flushWrites } =
        lifecycle

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

    // Coalesce / debounce auto-saves. Explicit persist() is immediate.
    // flush/hydrate promote a pending save onto the write chain first.
    let saveScheduled = false
    let debounceTimer: TimerHandle | undefined

    const clearDebounceTimer = (): void => {
        if (debounceTimer === undefined) return
        cancelTimeout(debounceTimer)
        debounceTimer = undefined
    }

    const promoteScheduledSave = (): void => {
        if (!saveScheduled) return
        saveScheduled = false
        clearDebounceTimer()
        void persist().catch(() => {
            // Error already emitted as persist:error.
        })
    }

    const scheduleMicrotask = (fn: () => void): void => {
        const schedule = (
            globalThis as { queueMicrotask?: (cb: () => void) => void }
        ).queueMicrotask
        if (typeof schedule === 'function') {
            schedule(fn)
            return
        }
        // Fallback when queueMicrotask is unavailable (very old runtimes).
        void Promise.resolve().then(fn)
    }

    const scheduleSave = (): void => {
        // Mutators already assertNotHydrating(gate); hydrate uses inner only.
        if (!autoSave) return

        if (autoSaveDebounceMs === 0) {
            if (saveScheduled) return
            saveScheduled = true
            scheduleMicrotask(() => {
                promoteScheduledSave()
            })
            return
        }

        // Debounce: reset the timer on every mutation.
        saveScheduled = true
        clearDebounceTimer()
        debounceTimer = scheduleTimeout(() => {
            debounceTimer = undefined
            promoteScheduledSave()
        }, autoSaveDebounceMs)
    }

    const flush = async (): Promise<void> => {
        promoteScheduledSave()
        await flushWrites()
    }
    const hydrate = async (): Promise<void> => {
        promoteScheduledSave()
        await hydrateCore()
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
