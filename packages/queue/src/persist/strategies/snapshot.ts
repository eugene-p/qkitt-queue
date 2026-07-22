/**
 * Snapshot persist strategy (private — consume via `withPersist`).
 */

import {
    createTypedEmit,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { isIntegerInRange } from '../../util/number.util'
import { decorateQueue } from '../../queue/core/forward.util'
import { markQueueLayer, PERSIST_LAYER } from '../../queue/core/layers.util'
import type { Queue, QueueEvents, QueueSlot } from '../../queue/core/queue'
import type {
    QueueWithPersist,
    SnapshotPersistEvents,
    SnapshotPersistOptions,
    SnapshotStore,
} from '../contracts'
import { assertNotHydrating } from '../hydrate-gate.util'
import { createPersistenceLifecycle } from './lifecycle.util'

type SnapshotQueueEvents<T, TEvents extends EventMap> = MergeEventMaps<
    TEvents,
    SnapshotPersistEvents
>

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

const resolveAutoSaveDebounceMs = (value: number | undefined): number => {
    const ms = value ?? 0
    if (!isIntegerInRange(ms, 0)) {
        throw new Error('autoSaveDebounceMs must be a safe integer >= 0')
    }
    return ms
}

/**
 * Attach snapshot persistence to a bare queue (private strategy implementation).
 *
 * Uses silent hydrate rebuild + a post-gate `queue:enqueued` kick so stacked
 * workers process restored items only after auto-save is allowed again.
 * Concurrent mutations during `hydrate` throw {@link QueueHydratingError}.
 * A second concurrent `hydrate()` rejects with "hydrate already in progress".
 *
 * Auto-save coalesces burst mutations (microtask by default, or
 * {@link SnapshotPersistOptions.autoSaveDebounceMs}). Prefer `flush()` before
 * process exit when durability matters.
 */
export const attachSnapshotPersist = <
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: SnapshotStore<T>,
    options: SnapshotPersistOptions = {},
): QueueWithPersist<T, 'snapshot', TEvents> => {
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

    return api as unknown as QueueWithPersist<T, 'snapshot', TEvents>
}
