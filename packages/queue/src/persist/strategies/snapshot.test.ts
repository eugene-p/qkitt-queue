import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../../queue/core/queue'
import type { SnapshotStore } from '../contracts'
import { withPersist } from '../with-persist'

const memorySnapshot = <T>(
    initial: T[] = [],
    persistOptions?: { autoSave?: boolean; autoSaveDebounceMs?: number },
): SnapshotStore<T> & { data: T[] } & { persistOptions?: typeof persistOptions } => {
    const store = {
        data: [...initial],
        load: async () => [...store.data],
        save: async (items: readonly T[]) => {
            store.data = [...items]
        },
        ...(persistOptions !== undefined ? { persistOptions } : {}),
    }
    return store
}

describe('withPersist (snapshot)', () => {
    it('hydrates the whole queue from the store', async () => {
        const store = memorySnapshot(['a', 'b', 'c'], { autoSave: false })
        const queue = withPersist(buildQueue<string>(), store)

        const loaded = vi.fn()
        queue.on('persist:loaded', loaded)

        await queue.hydrate()

        expect(queue.toArray()).toEqual(['a', 'b', 'c'])
        expect(loaded).toHaveBeenCalledWith({ size: 3 })
    })

    it('persist dumps the current queue', async () => {
        const store = memorySnapshot<string>([], { autoSave: false })
        const queue = withPersist(buildQueue<string>(), store)

        queue.enqueue('x')
        queue.enqueue('y')
        await queue.persist()

        expect(store.data).toEqual(['x', 'y'])
    })

    it('auto-saves after mutations', async () => {
        const store = memorySnapshot<number>()
        const saved = vi.fn()
        const queue = withPersist(buildQueue<number>(), store)

        queue.on('persist:saved', saved)
        queue.enqueue(1)
        queue.enqueue(2)
        await queue.flush()

        expect(store.data).toEqual([1, 2])
        expect(saved).toHaveBeenCalled()

        queue.dequeue()
        await queue.flush()
        expect(store.data).toEqual([2])

        queue.clear()
        await queue.flush()
        expect(store.data).toEqual([])
    })

    it('coalesces a burst of auto-saves into one save (microtask default)', async () => {
        const save = vi.fn(async (items: readonly number[]) => {
            void items
        })
        const store: SnapshotStore<number> = {
            load: async () => [],
            save,
        }
        const queue = withPersist(buildQueue<number>(), store)

        for (let i = 0; i < 50; i += 1) {
            queue.enqueue(i)
        }
        await queue.flush()

        expect(save).toHaveBeenCalledTimes(1)
        expect(save).toHaveBeenCalledWith(
            Array.from({ length: 50 }, (_, i) => i),
        )
    })

    it('debounces auto-save when autoSaveDebounceMs > 0', async () => {
        vi.useFakeTimers()
        try {
            const save = vi.fn(async (items: readonly number[]) => {
                void items
            })
            const store: SnapshotStore<number> & { persistOptions: { autoSaveDebounceMs: number } } = {
                load: async () => [],
                save,
                persistOptions: { autoSaveDebounceMs: 25 },
            }
            const queue = withPersist(buildQueue<number>(), store)

            queue.enqueue(1)
            queue.enqueue(2)
            expect(save).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(24)
            expect(save).not.toHaveBeenCalled()

            queue.enqueue(3)
            await vi.advanceTimersByTimeAsync(24)
            expect(save).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(1)
            // Timer fired; write chain may still be settling.
            await queue.flush()

            expect(save).toHaveBeenCalledTimes(1)
            expect(save).toHaveBeenCalledWith([1, 2, 3])
        } finally {
            vi.useRealTimers()
        }
    })

    it('flush promotes a pending debounced auto-save immediately', async () => {
        vi.useFakeTimers()
        try {
            const store = memorySnapshot<string>([], {
                autoSaveDebounceMs: 10_000,
            })
            const queue = withPersist(buildQueue<string>(), store)

            queue.enqueue('a')
            queue.enqueue('b')
            expect(store.data).toEqual([])

            await queue.flush()
            expect(store.data).toEqual(['a', 'b'])
        } finally {
            vi.useRealTimers()
        }
    })

    it('rejects invalid autoSaveDebounceMs', () => {
        const store = memorySnapshot<string>([], {
            autoSaveDebounceMs: -1,
        })
        expect(() =>
            withPersist(buildQueue<string>(), store),
        ).toThrow(/autoSaveDebounceMs/)

        const store2 = memorySnapshot<string>([], {
            autoSaveDebounceMs: 1.5,
        })
        expect(() =>
            withPersist(buildQueue<string>(), store2),
        ).toThrow(/autoSaveDebounceMs/)
    })

    it('auto-saves after dequeuing an undefined payload', async () => {
        const store = memorySnapshot<string | undefined>()
        const queue = withPersist(buildQueue<string | undefined>(), store)

        queue.enqueue(undefined)
        queue.enqueue('keep')
        await queue.flush()
        expect(store.data).toEqual([undefined, 'keep'])

        expect(queue.tryDequeue()).toEqual({ value: undefined })
        await queue.flush()
        expect(store.data).toEqual(['keep'])
        expect(queue.toArray()).toEqual(['keep'])
    })

    it('does not auto-save while hydrating', async () => {
        const save = vi.fn(async (items: readonly string[]) => {
            void items
        })
        const store: SnapshotStore<string> = {
            load: async () => ['a', 'b'],
            save,
        }
        const queue = withPersist(buildQueue<string>(), store)

        await queue.hydrate()
        await queue.flush()

        // hydrate should not trigger auto-save for the enqueues it performs
        expect(save).not.toHaveBeenCalled()
        expect(queue.toArray()).toEqual(['a', 'b'])
    })

    it('emits persist:error when save fails', async () => {
        const store: SnapshotStore<number> & { persistOptions: { autoSave: boolean } } = {
            load: async () => [],
            save: async () => {
                throw new Error('disk full')
            },
            persistOptions: { autoSave: false },
        }
        const queue = withPersist(buildQueue<number>(), store)
        const onError = vi.fn()
        queue.on('persist:error', onError)

        queue.enqueue(1)
        await expect(queue.persist()).rejects.toThrow('disk full')
        expect(onError).toHaveBeenCalledWith({
            operation: 'save',
            error: expect.objectContaining({ message: 'disk full' }),
        })
    })

    it('flushes pending saves before hydrate load', async () => {
        const order: string[] = []
        let releaseSave!: () => void
        const saveGate = new Promise<void>((resolve) => {
            releaseSave = resolve
        })
        const store: SnapshotStore<string> = {
            load: async () => {
                order.push('load')
                return ['from-store']
            },
            save: async (items) => {
                order.push(`save:${items.join(',')}`)
                await saveGate
            },
        }
        const queue = withPersist(buildQueue<string>(), store)
        queue.enqueue('pending')

        const hydratePromise = queue.hydrate()
        // hydrate must wait for the in-flight auto-save before load
        await Promise.resolve()
        expect(order).toContain('save:pending')
        expect(order).not.toContain('load')

        releaseSave()
        await hydratePromise
        expect(order.indexOf('save:pending')).toBeLessThan(order.indexOf('load'))
        expect(queue.toArray()).toEqual(['from-store'])
    })

    it('hydrate + withWorker drains store via auto-save', async () => {
        const { withWorker } = await import('../../queue/worker/with-worker')
        const store = memorySnapshot(['a', 'b'])
        const base = withPersist(buildQueue<string>(), store)
        const queue = withWorker(base, async (item) => item)

        const idle = new Promise<void>((resolve) => {
            const off = queue.on('worker:idle', () => {
                off()
                resolve()
            })
        })
        await queue.hydrate()
        await idle
        await queue.flush()

        expect(store.data).toEqual([])
        expect(queue.isEmpty()).toBe(true)
    })

    it('rejects mutations while hydrate is in progress', async () => {
        let releaseLoad!: () => void
        const loadGate = new Promise<void>((resolve) => {
            releaseLoad = resolve
        })
        const store: SnapshotStore<string> & { persistOptions: { autoSave: boolean } } = {
            load: async () => {
                await loadGate
                return ['a']
            },
            save: async () => {},
            persistOptions: { autoSave: false },
        }
        const queue = withPersist(buildQueue<string>(), store)
        const pending = queue.hydrate()

        await Promise.resolve()
        expect(() => queue.enqueue('x')).toThrow(/hydrate/)

        releaseLoad()
        await pending
        expect(queue.toArray()).toEqual(['a'])
    })

    it('rejects a second concurrent hydrate without opening the mutation gate early', async () => {
        let releaseLoad!: () => void
        const loadGate = new Promise<void>((resolve) => {
            releaseLoad = resolve
        })
        let loadCount = 0
        const store: SnapshotStore<string> & { persistOptions: { autoSave: boolean } } = {
            load: async () => {
                loadCount += 1
                await loadGate
                return ['from-store']
            },
            save: async () => {},
            persistOptions: { autoSave: false },
        }
        const queue = withPersist(buildQueue<string>(), store)
        const first = queue.hydrate()

        await Promise.resolve()
        await expect(queue.hydrate()).rejects.toThrow(
            /hydrate already in progress/,
        )
        expect(() => queue.enqueue('x')).toThrow(/hydrate/)
        expect(loadCount).toBe(1)

        releaseLoad()
        await first
        expect(queue.toArray()).toEqual(['from-store'])
        await queue.hydrate()
        expect(loadCount).toBe(2)
    })
})
