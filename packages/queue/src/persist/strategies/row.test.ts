import { describe, expect, it, vi } from 'vitest'
import { buildQueue, QueueFullError } from '../../queue/core/queue'
import type { RowRecord, RowStore } from '../contracts'
import { withPersist } from '../with-persist'

const memoryRows = <T>(
    initial: RowRecord<T>[] = [],
    persistOptions?: { createId?: () => string },
): RowStore<T> & { rows: RowRecord<T>[] } & { persistOptions?: typeof persistOptions } => {
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
        ...(persistOptions !== undefined ? { persistOptions } : {}),
    }
    return store
}

describe('withPersist (row)', () => {
    it('hydrates from ordered rows and keeps ids', async () => {
        const store = memoryRows(
            [
                { id: '1', item: 'a' },
                { id: '2', item: 'b' },
            ],
            { createId: () => 'should-not-run' },
        )
        const queue = withPersist(buildQueue<string>(), store)

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
        const store = memoryRows<string>([], {
            createId: () => `id-${++n}`,
        })
        const queue = withPersist(buildQueue<string>(), store)
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
        const store = memoryRows<string>([], {
            createId: () => `id-${++n}`,
        })
        const queue = withPersist(buildQueue<string>(), store)
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

    it('tryDequeue/tryPeek preserve undefined payloads and still remove rows', async () => {
        let n = 0
        const store = memoryRows<string | undefined>([], {
            createId: () => `id-${++n}`,
        })
        const queue = withPersist(buildQueue<string | undefined>(), store)

        queue.enqueue(undefined)
        queue.enqueue('tail')
        await queue.flush()

        expect(queue.tryPeek()).toEqual({ value: undefined })
        expect(queue.tryDequeue()).toEqual({ value: undefined })
        await queue.flush()

        expect(store.rows).toEqual([{ id: 'id-2', item: 'tail' }])
        expect(queue.toArray()).toEqual(['tail'])
    })

    it('clears all rows', async () => {
        let n = 0
        const store = memoryRows<number>([], {
            createId: () => `id-${++n}`,
        })
        const queue = withPersist(buildQueue<number>(), store)
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
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert: async () => {
                throw new Error('constraint')
            },
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => 'fixed' },
        }
        const queue = withPersist(buildQueue<string>(), store)
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
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert: async (record) => {
                if (record.item === 'bad') throw new Error('nope')
            },
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => `id-${++n}` },
        }
        const queue = withPersist(buildQueue<string>(), store)

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
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert: async (record) => {
                await gate
                void record
            },
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => 'id-1' },
        }
        const queue = withPersist(buildQueue<string>(), store)
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
        let n = 0
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert: async (record) => {
                if (record.item === 'a') await firstGate
                order.push(`insert:${record.item}`)
            },
            remove: async (id) => {
                order.push(`remove:${id}`)
            },
            clear: async () => {},
            persistOptions: { createId: () => `id-${++n}` },
        }
        const queue = withPersist(buildQueue<string>(), store)

        queue.enqueue('a')
        queue.enqueue('b')
        queue.dequeue()
        releaseFirst()
        await queue.flush()

        expect(order).toEqual(['insert:a', 'insert:b', 'remove:id-1'])
    })

    it('survives restart via hydrate after row ops', async () => {
        let n = 0
        const store = memoryRows<string>([], {
            createId: () => `id-${++n}`,
        })
        const first = withPersist(buildQueue<string>(), store)

        first.enqueue('keep')
        first.enqueue('drop')
        await first.flush()
        first.dequeue()
        await first.flush()

        const second = withPersist(buildQueue<string>(), store)
        await second.hydrate()

        expect(second.toArray()).toEqual(['drop'])
        expect(second.rowIds()).toEqual(['id-2'])
    })

    it('stacked withWorker uses row dequeue (store stays in sync)', async () => {
        const { withWorker } = await import('../../queue/worker/with-worker')
        let n = 0
        const store = memoryRows<string>([], {
            createId: () => `id-${++n}`,
        })
        const base = withPersist(buildQueue<string>(), store)
        const queue = withWorker(base, async (item) => item.toUpperCase())

        const idle = new Promise<void>((resolve) => {
            const off = queue.on('worker:idle', () => {
                off()
                resolve()
            })
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
        const { withWorker } = await import('../../queue/worker/with-worker')
        const store = memoryRows([
            { id: '1', item: 'a' },
            { id: '2', item: 'b' },
        ])
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

        expect(store.rows).toEqual([])
        expect(queue.isEmpty()).toBe(true)

        // Second hydrate must not reprocess completed work.
        const again = withWorker(
            withPersist(buildQueue<string>(), store),
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
        const queue = withPersist(buildQueue<string>(), store)
        const pending = queue.hydrate()

        await Promise.resolve()
        expect(() => queue.enqueue('x')).toThrow(/hydrate/)
        expect(() => queue.dequeue()).toThrow(/hydrate/)
        expect(() => queue.clear()).toThrow(/hydrate/)

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
        const store: RowStore<string> = {
            loadAll: async () => {
                loadCount += 1
                await loadGate
                return [{ id: '1', item: 'from-store' }]
            },
            insert: async () => {},
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withPersist(buildQueue<string>(), store)
        const first = queue.hydrate()

        await Promise.resolve()
        await expect(queue.hydrate()).rejects.toThrow(
            /hydrate already in progress/,
        )
        // Gate still owned by first hydrate — mutations remain blocked.
        expect(() => queue.enqueue('x')).toThrow(/hydrate/)
        expect(loadCount).toBe(1)

        releaseLoad()
        await first
        expect(queue.toArray()).toEqual(['from-store'])
        // Second hydrate can run after the first finishes.
        await queue.hydrate()
        expect(loadCount).toBe(2)
    })

    it('rejects duplicate generated ids on enqueue before store ops', async () => {
        const insert = vi.fn(async () => {})
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert,
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => 'same' },
        }
        const queue = withPersist(buildQueue<string>(), store)

        queue.enqueue('a')
        await queue.flush()
        expect(insert).toHaveBeenCalledTimes(1)

        expect(() => queue.enqueue('b')).toThrow(/duplicate row id/)
        expect(queue.toArray()).toEqual(['a'])
        await queue.flush()
        expect(insert).toHaveBeenCalledTimes(1)
    })

    it('does not leak idSet or schedule insert when enqueue hits maxSize', async () => {
        const insert = vi.fn(async () => {})
        let n = 0
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert,
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => `id-${++n}` },
        }
        const queue = withPersist(
            buildQueue<string>({ maxSize: 1 }),
            store,
        )

        queue.enqueue('a')
        expect(() => queue.enqueue('b')).toThrow(QueueFullError)
        expect(queue.toArray()).toEqual(['a'])
        expect(queue.rowIds()).toEqual(['id-1'])

        // createId already advanced for the failed attempt (id-2); idSet must
        // not retain it or the next sequential id would falsely duplicate.
        queue.dequeue()
        queue.enqueue('c')
        expect(queue.toArray()).toEqual(['c'])
        expect(queue.rowIds()).toEqual(['id-3'])

        await queue.flush()
        // Only successful enqueues insert (a then c); full enqueue is skipped.
        expect(insert).toHaveBeenCalledTimes(2)
        expect(insert).toHaveBeenNthCalledWith(1, { id: 'id-1', item: 'a' })
        expect(insert).toHaveBeenNthCalledWith(2, { id: 'id-3', item: 'c' })
    })

    it('rejects empty or whitespace-only generated ids on enqueue before store ops', async () => {
        const insert = vi.fn(async () => {})

        for (const badId of ['', '   ', '\t\n']) {
            insert.mockClear()
            const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
                loadAll: async () => [],
                insert,
                remove: async () => {},
                clear: async () => {},
                persistOptions: { createId: () => badId },
            }
            const queue = withPersist(buildQueue<string>(), store)
            expect(() => queue.enqueue('a')).toThrow(/non-empty/)
            expect(queue.isEmpty()).toBe(true)
            await queue.flush()
            expect(insert).not.toHaveBeenCalled()
        }
    })

    it('rejects duplicate ids from loadAll before replaceAll', async () => {
        const store: RowStore<string> = {
            loadAll: async () => [
                { id: '1', item: 'a' },
                { id: '1', item: 'b' },
            ],
            insert: async () => {},
            remove: async () => {},
            clear: async () => {},
        }
        const queue = withPersist(buildQueue<string>(), store)
        queue.enqueue('keep')
        await queue.flush()

        const onError = vi.fn()
        queue.on('persist:error', onError)

        await expect(queue.hydrate()).rejects.toThrow(/duplicate row id/)
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ operation: 'load' }),
        )
        // Prevalidation failed — memory unchanged.
        expect(queue.toArray()).toEqual(['keep'])
    })

    it('rejects empty or whitespace-only ids from loadAll', async () => {
        for (const badId of ['', '  ']) {
            const store: RowStore<string> = {
                loadAll: async () => [{ id: badId, item: 'a' }],
                insert: async () => {},
                remove: async () => {},
                clear: async () => {},
            }
            const queue = withPersist(buildQueue<string>(), store)

            await expect(queue.hydrate()).rejects.toThrow(/non-empty/)
            expect(queue.isEmpty()).toBe(true)
        }
    })

    it('rejects replaceAll when generated ids collide before store ops', async () => {
        let n = 0
        const insert = vi.fn(async () => {})
        const clear = vi.fn(async () => {})
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert,
            remove: async () => {},
            clear,
            persistOptions: {
                createId: () => {
                    n += 1
                    // First id unique, second collides with first.
                    return n === 1 ? 'a' : 'a'
                },
            },
        }
        const queue = withPersist(buildQueue<string>(), store)

        expect(() => queue.replaceAll(['x', 'y'])).toThrow(/duplicate row id/)
        expect(queue.isEmpty()).toBe(true)
        await queue.flush()
        expect(clear).not.toHaveBeenCalled()
        expect(insert).not.toHaveBeenCalled()
    })

    it('throws when persist is stacked outside a worker', async () => {
        const { withWorker } = await import('../../queue/worker/with-worker')
        const workerQueue = withWorker(buildQueue<string>(), async (s) => s)
        expect(() =>
            withPersist(workerQueue as never, memoryRows()),
        ).toThrow(/before withWorker/)
    })

    it('throws when persist is stacked on an already-persisted queue', async () => {
        const { createMemorySnapshotStore } = await import('../stores/memory')
        const snap = withPersist(
            buildQueue<string>(),
            createMemorySnapshotStore(),
        )
        expect(() => withPersist(snap as never, memoryRows())).toThrow(
            /already-persisted/,
        )
    })

    it('throws when store matches both SnapshotStore and RowStore', () => {
        const ambiguous = {
            load: async () => [],
            save: async () => {},
            loadAll: async () => [],
            insert: async () => {},
            remove: async () => {},
            clear: async () => {},
        }
        expect(() =>
            withPersist(buildQueue<string>(), ambiguous as never),
        ).toThrow(/matches both/)
    })

    it('replaceAll clears store and inserts new rows with fresh ids', async () => {
        let n = 0
        const store = memoryRows<string>([], {
            createId: () => `new-${++n}`,
        })
        const queue = withPersist(buildQueue<string>(), store)
        const cleared = vi.fn()
        const inserted = vi.fn()
        queue.on('persist:cleared', cleared)
        queue.on('persist:inserted', inserted)

        queue.enqueue('a')
        queue.enqueue('b')
        await queue.flush()
        cleared.mockClear()
        inserted.mockClear()

        queue.replaceAll(['x', 'y'])
        await queue.flush()

        expect(queue.toArray()).toEqual(['x', 'y'])
        expect(queue.rowIds()).toEqual(['new-3', 'new-4'])
        expect(store.rows).toEqual([
            { id: 'new-3', item: 'x' },
            { id: 'new-4', item: 'y' },
        ])
        expect(cleared).toHaveBeenCalledWith({ removed: 2 })
        expect(inserted).toHaveBeenCalledTimes(2)
    })

    it('replaceAll labels insert failures as insert with id, not clear', async () => {
        let n = 0
        const insert = vi.fn(async (record: RowRecord<string>) => {
            if (record.item === 'y') {
                throw new Error('insert failed')
            }
        })
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert,
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => `id-${++n}` },
        }
        const queue = withPersist(buildQueue<string>(), store)
        const onError = vi.fn()
        queue.on('persist:error', onError)

        queue.replaceAll(['x', 'y', 'z'])
        await queue.flush()

        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: 'insert',
                id: 'id-2',
                error: expect.objectContaining({ message: 'insert failed' }),
            }),
        )
        // First insert succeeded; third never attempted after failure.
        expect(insert).toHaveBeenCalledTimes(2)
        expect(insert.mock.calls.map((c) => c[0].item)).toEqual(['x', 'y'])
    })

    it('insert rollback does not emit clear/enqueue events', async () => {
        const store: RowStore<string> & { persistOptions: { createId: () => string } } = {
            loadAll: async () => [],
            insert: async () => {
                throw new Error('constraint')
            },
            remove: async () => {},
            clear: async () => {},
            persistOptions: { createId: () => 'fixed' },
        }
        const queue = withPersist(buildQueue<string>(), store)
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
