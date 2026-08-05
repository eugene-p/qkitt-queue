import { describe, expect, it } from 'vitest'
import { createMemoryRowStore } from './memory'

describe('createMemoryRowStore', () => {
    it('put upserts and loadAll returns clones', () => {
        const store = createMemoryRowStore<string>()
        store.put({
            id: 1,
            item: 'a',
            availableAt: 0,
            leaseGeneration: null,
            leaseExpiresAt: null,
        })
        store.put({
            id: 1,
            item: 'b',
            availableAt: 0,
            leaseGeneration: 1,
            leaseExpiresAt: null,
        })
        const loaded = store.loadAll() as ReadonlyArray<{
            id: number
            item: string
            availableAt: number
            leaseGeneration: number | null
            leaseExpiresAt: number | null
        }>
        expect(loaded).toEqual([
            {
                id: 1,
                item: 'b',
                availableAt: 0,
                leaseGeneration: 1,
                leaseExpiresAt: null,
            },
        ])
        // loadAll returns clones — store.rows is independent of the snapshot
        expect(store.rows[0]!.item).toBe('b')
        expect(loaded[0]).not.toBe(store.rows[0])
    })

    it('remove and clear', () => {
        const store = createMemoryRowStore<number>()
        store.put({
            id: 1,
            item: 1,
            availableAt: 0,
            leaseGeneration: null,
            leaseExpiresAt: null,
        })
        store.put({
            id: 2,
            item: 2,
            availableAt: 0,
            leaseGeneration: null,
            leaseExpiresAt: null,
        })
        store.remove(1)
        const remaining = store.loadAll() as readonly { id: number }[]
        expect(remaining.map((r) => r.id)).toEqual([2])
        store.clear()
        expect(store.loadAll() as readonly unknown[]).toEqual([])
    })

    it('remove keeps the remaining rows', () => {
        const store = createMemoryRowStore<number>()
        for (let id = 1; id <= 5; id += 1) {
            store.put({
                id,
                item: id,
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            })
        }
        store.remove(3)
        store.remove(1)
        const ids = (store.loadAll() as readonly { id: number }[])
            .map((r) => r.id)
            .sort((a, b) => a - b)
        expect(ids).toEqual([2, 4, 5])
        expect(store.rows).toHaveLength(3)
    })

    it('putBatch and removeBatch match single ops', () => {
        const store = createMemoryRowStore<string>()
        store.putBatch?.([
            {
                id: 1,
                item: 'a',
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            },
            {
                id: 2,
                item: 'b',
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            },
        ])
        store.removeBatch?.([1])
        expect(
            (store.loadAll() as readonly { id: number; item: string }[]).map(
                (r) => [r.id, r.item],
            ),
        ).toEqual([[2, 'b']])
    })

    it('handles a growing backlog and batch mutations', () => {
        const store = createMemoryRowStore<number>()
        for (let id = 1; id <= 2_000; id += 1) {
            store.put({
                id,
                item: id,
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            })
        }
        expect(store.rows).toHaveLength(2_000)

        store.removeBatch?.(Array.from({ length: 1_000 }, (_, i) => i + 1))
        expect(store.rows).toHaveLength(1_000)
        store.putBatch?.(
            Array.from({ length: 1_000 }, (_, i) => ({
                id: i + 2_001,
                item: i + 2_001,
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            })),
        )
        expect(store.rows).toHaveLength(2_000)
    })
})

