import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import {
    withSnapshotPersist,
    type SnapshotStore,
} from './with-snapshot-persist'

const memorySnapshot = <T>(initial: T[] = []): SnapshotStore<T> & { data: T[] } => {
    const store = {
        data: [...initial],
        load: async () => [...store.data],
        save: async (items: readonly T[]) => {
            store.data = [...items]
        },
    }
    return store
}

describe('withSnapshotPersist', () => {
    it('hydrates the whole queue from the store', async () => {
        const store = memorySnapshot(['a', 'b', 'c'])
        const queue = withSnapshotPersist(buildQueue<string>(), store, {
            autoSave: false,
        })

        const loaded = vi.fn()
        queue.on('persist:loaded', loaded)

        await queue.hydrate()

        expect(queue.toArray()).toEqual(['a', 'b', 'c'])
        expect(loaded).toHaveBeenCalledWith({ size: 3 })
    })

    it('persist dumps the current queue', async () => {
        const store = memorySnapshot<string>()
        const queue = withSnapshotPersist(buildQueue<string>(), store, {
            autoSave: false,
        })

        queue.enqueue('x')
        queue.enqueue('y')
        await queue.persist()

        expect(store.data).toEqual(['x', 'y'])
    })

    it('auto-saves after mutations', async () => {
        const store = memorySnapshot<number>()
        const saved = vi.fn()
        const queue = withSnapshotPersist(buildQueue<number>(), store)

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

    it('does not auto-save while hydrating', async () => {
        const save = vi.fn(async (items: readonly string[]) => {
            void items
        })
        const store: SnapshotStore<string> = {
            load: async () => ['a', 'b'],
            save,
        }
        const queue = withSnapshotPersist(buildQueue<string>(), store)

        await queue.hydrate()
        await queue.flush()

        // hydrate should not trigger auto-save for the enqueues it performs
        expect(save).not.toHaveBeenCalled()
        expect(queue.toArray()).toEqual(['a', 'b'])
    })

    it('emits persist:error when save fails', async () => {
        const store: SnapshotStore<number> = {
            load: async () => [],
            save: async () => {
                throw new Error('disk full')
            },
        }
        const queue = withSnapshotPersist(buildQueue<number>(), store, {
            autoSave: false,
        })
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
        const queue = withSnapshotPersist(buildQueue<string>(), store)
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
        const { withWorker } = await import('../worker/with-worker')
        const store = memorySnapshot(['a', 'b'])
        const base = withSnapshotPersist(buildQueue<string>(), store)
        const queue = withWorker(base, async (item) => item)

        const idle = new Promise<void>((resolve) => {
            queue.once('worker:idle', () => resolve())
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
        const store: SnapshotStore<string> = {
            load: async () => {
                await loadGate
                return ['a']
            },
            save: async () => {},
        }
        const queue = withSnapshotPersist(buildQueue<string>(), store, {
            autoSave: false,
        })
        const pending = queue.hydrate()

        await Promise.resolve()
        expect(() => queue.enqueue('x')).toThrow(/hydrate/)

        releaseLoad()
        await pending
        expect(queue.toArray()).toEqual(['a'])
    })
})
