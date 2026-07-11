import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import {
    withRowPersist,
    type RowRecord,
    type RowStore,
} from './with-row-persist'

const memoryRows = <T>(
    initial: RowRecord<T>[] = [],
): RowStore<T> & { rows: RowRecord<T>[] } => {
    const store = {
        rows: [...initial],
        loadAll: async () => [...store.rows],
        insert: async (record: RowRecord<T>) => {
            store.rows.push(record)
        },
        remove: async (id: string) => {
            store.rows = store.rows.filter((row) => row.id !== id)
        },
        clear: async () => {
            store.rows = []
        },
    }
    return store
}

describe('withRowPersist', () => {
    it('hydrates from ordered rows and keeps ids', async () => {
        const store = memoryRows([
            { id: '1', item: 'a' },
            { id: '2', item: 'b' },
        ])
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => 'should-not-run',
        })

        const loaded = vi.fn()
        queue.on('persist:loaded', loaded)

        await queue.hydrate()

        expect(queue.toArray()).toEqual(['a', 'b'])
        expect(queue.rowIds()).toEqual(['1', '2'])
        expect(loaded).toHaveBeenCalledWith({ size: 2 })
        // hydrate must not re-insert
        expect(store.rows).toEqual([
            { id: '1', item: 'a' },
            { id: '2', item: 'b' },
        ])
    })

    it('inserts a row on enqueue', async () => {
        let n = 0
        const store = memoryRows<string>()
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => `id-${++n}`,
        })
        const inserted = vi.fn()
        queue.on('persist:inserted', inserted)

        queue.enqueue('x')
        await queue.flush()

        expect(queue.rowIds()).toEqual(['id-1'])
        expect(store.rows).toEqual([{ id: 'id-1', item: 'x' }])
        expect(inserted).toHaveBeenCalledWith({ id: 'id-1', item: 'x' })
    })

    it('removes the head row on dequeue', async () => {
        let n = 0
        const store = memoryRows<string>()
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => `id-${++n}`,
        })
        const removed = vi.fn()
        queue.on('persist:removed', removed)

        queue.enqueue('a')
        queue.enqueue('b')
        await queue.flush()

        expect(queue.dequeue()).toBe('a')
        await queue.flush()

        expect(queue.toArray()).toEqual(['b'])
        expect(queue.rowIds()).toEqual(['id-2'])
        expect(store.rows).toEqual([{ id: 'id-2', item: 'b' }])
        expect(removed).toHaveBeenCalledWith({ id: 'id-1', item: 'a' })
    })

    it('clears all rows', async () => {
        let n = 0
        const store = memoryRows<number>()
        const queue = withRowPersist(buildQueue<number>(), store, {
            createId: () => `id-${++n}`,
        })
        const cleared = vi.fn()
        queue.on('persist:cleared', cleared)

        queue.enqueue(1)
        queue.enqueue(2)
        await queue.flush()

        queue.clear()
        await queue.flush()

        expect(queue.isEmpty()).toBe(true)
        expect(queue.rowIds()).toEqual([])
        expect(store.rows).toEqual([])
        expect(cleared).toHaveBeenCalledWith({ removed: 2 })
    })

    it('rolls back memory and emits persist:error when insert fails', async () => {
        const store: RowStore<string> = {
            loadAll: async () => [],
            insert: async () => {
                throw new Error('constraint')
            },
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => 'fixed',
        })
        const onError = vi.fn()
        queue.on('persist:error', onError)

        queue.enqueue('z')
        await queue.flush()

        expect(onError).toHaveBeenCalledWith({
            operation: 'insert',
            error: expect.objectContaining({ message: 'constraint' }),
            id: 'fixed',
        })
        // optimistic enqueue is rolled back when the store rejects
        expect(queue.toArray()).toEqual([])
        expect(queue.rowIds()).toEqual([])
    })

    it('keeps other rows when one insert fails', async () => {
        let n = 0
        const store: RowStore<string> = {
            loadAll: async () => [],
            insert: async (record) => {
                if (record.item === 'bad') throw new Error('nope')
            },
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => `id-${++n}`,
        })

        queue.enqueue('good')
        queue.enqueue('bad')
        await queue.flush()

        expect(queue.toArray()).toEqual(['good'])
        expect(queue.rowIds()).toEqual(['id-1'])
    })

    it('flush waits for pending store mutations', async () => {
        let resolveInsert!: () => void
        const gate = new Promise<void>((resolve) => {
            resolveInsert = resolve
        })
        const store: RowStore<string> = {
            loadAll: async () => [],
            insert: async (record) => {
                await gate
                void record
            },
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => 'id-1',
        })
        const inserted = vi.fn()
        queue.on('persist:inserted', inserted)

        queue.enqueue('x')
        const flushed = queue.flush()
        expect(inserted).not.toHaveBeenCalled()

        resolveInsert()
        await flushed
        expect(inserted).toHaveBeenCalledWith({ id: 'id-1', item: 'x' })
    })

    it('serializes store ops so order is preserved', async () => {
        const order: string[] = []
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })
        const store: RowStore<string> = {
            loadAll: async () => [],
            insert: async (record) => {
                if (record.item === 'a') await firstGate
                order.push(`insert:${record.item}`)
            },
            remove: async (id) => {
                order.push(`remove:${id}`)
            },
            clear: async () => {},
        }
        let n = 0
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => `id-${++n}`,
        })

        queue.enqueue('a')
        queue.enqueue('b')
        queue.dequeue()
        releaseFirst()
        await queue.flush()

        expect(order).toEqual(['insert:a', 'insert:b', 'remove:id-1'])
    })

    it('survives restart via hydrate after row ops', async () => {
        let n = 0
        const store = memoryRows<string>()
        const first = withRowPersist(buildQueue<string>(), store, {
            createId: () => `id-${++n}`,
        })

        first.enqueue('keep')
        first.enqueue('drop')
        await first.flush()
        first.dequeue()
        await first.flush()

        const second = withRowPersist(buildQueue<string>(), store)
        await second.hydrate()

        expect(second.toArray()).toEqual(['drop'])
        expect(second.rowIds()).toEqual(['id-2'])
    })

    it('stacked withWorker uses row dequeue (store stays in sync)', async () => {
        const { withWorker } = await import('../worker/with-worker')
        let n = 0
        const store = memoryRows<string>()
        const base = withRowPersist(buildQueue<string>(), store, {
            createId: () => `id-${++n}`,
        })
        const queue = withWorker(base, async (item) => item.toUpperCase())

        const idle = new Promise<void>((resolve) => {
            queue.once('worker:idle', () => resolve())
        })
        queue.enqueue('a')
        queue.enqueue('b')
        await idle
        // flush is preserved from the inner row-persist wrapper
        await queue.flush()

        expect(store.rows).toEqual([])
        expect(queue.isEmpty()).toBe(true)
        expect(queue.rowIds()).toEqual([])
    })

    it('hydrate + withWorker removes processed rows from the store', async () => {
        const { withWorker } = await import('../worker/with-worker')
        const store = memoryRows([
            { id: '1', item: 'a' },
            { id: '2', item: 'b' },
        ])
        const base = withRowPersist(buildQueue<string>(), store)
        const queue = withWorker(base, async (item) => item)

        const idle = new Promise<void>((resolve) => {
            queue.once('worker:idle', () => resolve())
        })
        await queue.hydrate()
        await idle
        await queue.flush()

        expect(store.rows).toEqual([])
        expect(queue.isEmpty()).toBe(true)

        // Second hydrate must not reprocess completed work.
        const again = withWorker(
            withRowPersist(buildQueue<string>(), store),
            async (item) => item,
        )
        const started = vi.fn()
        again.on('worker:started', started)
        await again.hydrate()
        await again.flush()
        expect(started).not.toHaveBeenCalled()
        expect(store.rows).toEqual([])
    })

    it('rejects mutations while hydrate is in progress', async () => {
        let releaseLoad!: () => void
        const loadGate = new Promise<void>((resolve) => {
            releaseLoad = resolve
        })
        const store: RowStore<string> = {
            loadAll: async () => {
                await loadGate
                return [{ id: '1', item: 'a' }]
            },
            insert: async () => {},
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withRowPersist(buildQueue<string>(), store)
        const pending = queue.hydrate()

        await Promise.resolve()
        expect(() => queue.enqueue('x')).toThrow(/hydrate/)
        expect(() => queue.dequeue()).toThrow(/hydrate/)
        expect(() => queue.clear()).toThrow(/hydrate/)

        releaseLoad()
        await pending
        expect(queue.toArray()).toEqual(['a'])
    })

    it('throws when persist is stacked outside a worker', async () => {
        const { withWorker } = await import('../worker/with-worker')
        const workerQueue = withWorker(buildQueue<string>(), async (s) => s)
        expect(() => withRowPersist(workerQueue, memoryRows())).toThrow(
            /before withWorker/,
        )
    })

    it('throws when persist is stacked on an already-persisted queue', async () => {
        const { withSnapshotPersist } = await import('./with-snapshot-persist')
        const { createMemorySnapshotStore } = await import('../../persist/memory')
        const snap = withSnapshotPersist(
            buildQueue<string>(),
            createMemorySnapshotStore(),
        )
        expect(() => withRowPersist(snap, memoryRows())).toThrow(
            /already-persisted/,
        )
    })

    it('rejects public replaceAll to avoid store desync', () => {
        const queue = withRowPersist(buildQueue<string>(), memoryRows())
        expect(() => queue.replaceAll(['x'])).toThrow(/not supported/)
    })

    it('insert rollback does not emit clear/enqueue events', async () => {
        const store: RowStore<string> = {
            loadAll: async () => [],
            insert: async () => {
                throw new Error('constraint')
            },
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withRowPersist(buildQueue<string>(), store, {
            createId: () => 'fixed',
        })
        const cleared = vi.fn()
        const enqueued = vi.fn()
        queue.on('queue:cleared', cleared)
        queue.on('queue:enqueued', enqueued)

        queue.enqueue('z')
        enqueued.mockClear()
        await queue.flush()

        expect(cleared).not.toHaveBeenCalled()
        expect(enqueued).not.toHaveBeenCalled()
        expect(queue.toArray()).toEqual([])
    })
})
