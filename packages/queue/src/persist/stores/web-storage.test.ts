import { describe, expect, it } from 'vitest'
import { createWebRowStore } from './web-storage'

const memoryStorage = () => {
    const map = new Map<string, string>()
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
            map.set(k, v)
        },
        removeItem: (k: string) => {
            map.delete(k)
        },
    }
}

describe('createWebRowStore', () => {
    it('round-trips full row records', () => {
        const storage = memoryStorage()
        const store = createWebRowStore<string>({ key: 'q', storage })
        store.put({
            id: 1,
            item: 'job',
            availableAt: 0,
            leaseGeneration: 2,
            leaseExpiresAt: 100,
        })
        const rows = store.loadAll()
        expect(rows).toEqual([
            {
                id: 1,
                item: 'job',
                availableAt: 0,
                leaseGeneration: 2,
                leaseExpiresAt: 100,
            },
        ])
        store.remove(1)
        expect(store.loadAll()).toEqual([])
    })

    it('putBatch and removeBatch round-trip', () => {
        const storage = memoryStorage()
        const store = createWebRowStore<number>({ key: 'q', storage })
        store.putBatch?.([
            {
                id: 1,
                item: 1,
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            },
            {
                id: 2,
                item: 2,
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            },
        ])
        const afterPut = store.loadAll() as ReadonlyArray<{ id: number }>
        expect(afterPut.map((r) => r.id)).toEqual([1, 2])
        store.removeBatch?.([1])
        const afterRemove = store.loadAll() as ReadonlyArray<{ id: number }>
        expect(afterRemove.map((r) => r.id)).toEqual([2])
    })

    it('replaceAll replaces the full set', () => {
        const storage = memoryStorage()
        const store = createWebRowStore<string>({ key: 'q', storage })
        store.put({
            id: 1,
            item: 'old',
            availableAt: 0,
            leaseGeneration: null,
            leaseExpiresAt: null,
        })
        store.replaceAll?.([
            {
                id: 10,
                item: 'new',
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            },
        ])
        expect(store.loadAll()).toEqual([
            {
                id: 10,
                item: 'new',
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            },
        ])
    })
})
