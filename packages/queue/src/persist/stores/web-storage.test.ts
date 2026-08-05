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

const faultStorage = () => {
    const base = memoryStorage()
    let mutationCount = 0
    let failAt: number | undefined
    return {
        ...base,
        get mutationCount() {
            return mutationCount
        },
        failMutation(offset: number) {
            failAt = mutationCount + offset
        },
        setItem: (k: string, v: string) => {
            mutationCount += 1
            if (mutationCount === failAt) {
                failAt = undefined
                throw new Error('injected storage failure')
            }
            base.setItem(k, v)
        },
        removeItem: (k: string) => {
            mutationCount += 1
            if (mutationCount === failAt) {
                failAt = undefined
                throw new Error('injected storage failure')
            }
            base.removeItem(k)
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

    it('keeps loadAll safe when put fails at either key mutation', () => {
        for (let failure = 0; failure < 2; failure += 1) {
            const storage = faultStorage()
            const store = createWebRowStore<string>({ key: 'q', storage })
            if (failure === 1) {
                store.put({
                    id: 1,
                    item: 'existing',
                    availableAt: 0,
                    leaseGeneration: null,
                    leaseExpiresAt: null,
                })
            }
            storage.failMutation(failure + 1)
            expect(() =>
                store.put({
                    id: 2,
                    item: 'new',
                    availableAt: 0,
                    leaseGeneration: null,
                    leaseExpiresAt: null,
                }),
            ).toThrow('injected storage failure')
            expect(store.loadAll()).toEqual(
                failure === 1
                    ? [
                          {
                              id: 1,
                              item: 'existing',
                              availableAt: 0,
                              leaseGeneration: null,
                              leaseExpiresAt: null,
                          },
                      ]
                    : [],
            )
        }
    })

    it('keeps loadAll safe when remove fails at either key mutation', () => {
        for (let failure = 0; failure < 2; failure += 1) {
            const storage = faultStorage()
            const store = createWebRowStore<string>({ key: 'q', storage })
            store.put({
                id: 1,
                item: 'existing',
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            })
            storage.failMutation(failure + 1)
            if (failure === 0) {
                expect(() => store.remove(1)).toThrow('injected storage failure')
                expect(store.loadAll()).toHaveLength(1)
            } else {
                expect(() => store.remove(1)).not.toThrow()
                expect(store.loadAll()).toEqual([])
            }
        }
    })

    it('keeps loadAll safe when replaceAll fails during cleanup or publish', () => {
        for (let failure = 0; failure < 3; failure += 1) {
            const storage = faultStorage()
            const store = createWebRowStore<string>({ key: 'q', storage })
            store.put({
                id: 1,
                item: 'old',
                availableAt: 0,
                leaseGeneration: null,
                leaseExpiresAt: null,
            })
            storage.failMutation(failure + 1)
            const replace = () =>
                store.replaceAll?.([
                    {
                        id: 10,
                        item: 'new',
                        availableAt: 0,
                        leaseGeneration: null,
                        leaseExpiresAt: null,
                    },
                ])
            if (failure < 2) {
                expect(replace).toThrow('injected storage failure')
                expect(store.loadAll()).toHaveLength(1)
            } else {
                expect(replace).not.toThrow()
                expect(store.loadAll()).toEqual([
                    {
                        id: 10,
                        item: 'new',
                        availableAt: 0,
                        leaseGeneration: null,
                        leaseExpiresAt: null,
                    },
                ])
            }
        }
    })

    it('handles large batch writes and removals', () => {
        const storage = memoryStorage()
        const store = createWebRowStore<number>({ key: 'large', storage })
        const records = Array.from({ length: 2_000 }, (_, i) => ({
            id: i + 1,
            item: i + 1,
            availableAt: 0,
            leaseGeneration: null,
            leaseExpiresAt: null,
        }))
        store.putBatch?.(records)
        expect(store.loadAll()).toHaveLength(2_000)
        store.removeBatch?.(records.slice(0, 1_000).map((record) => record.id))
        expect(store.loadAll()).toHaveLength(1_000)
        store.replaceAll?.(records.slice(0, 1_500))
        expect(store.loadAll()).toHaveLength(1_500)
    })
})
