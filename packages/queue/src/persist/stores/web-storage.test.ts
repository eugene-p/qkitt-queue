import { describe, expect, it } from 'vitest'
import { buildQueue } from '../../queue/core/queue'
import { withPersist } from '../with-persist'
import {
    createWebRowStore,
    createWebSnapshotStore,
    StorageCodecError,
    type WebStorageLike,
} from './web-storage'

const createMemoryWebStorage = (): WebStorageLike & {
    map: Map<string, string>
} => {
    const map = new Map<string, string>()
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value)
        },
        removeItem: (key) => {
            map.delete(key)
        },
    }
}

describe('createWebSnapshotStore', () => {
    it('persists the full queue under one key', async () => {
        const storage = createMemoryWebStorage()
        const store = createWebSnapshotStore<number>({
            key: 'q',
            storage,
        })
        const queue = withPersist(buildQueue<number>(), store)

        queue.enqueue(1)
        queue.enqueue(2)
        await queue.persist()

        expect(storage.map.get('q')).toBe('[1,2]')

        const restored = withPersist(
            buildQueue<number>(),
            createWebSnapshotStore<number>({
                key: 'q',
                storage,
                autoSave: false,
            }),
        )
        await restored.hydrate()
        expect(restored.toArray()).toEqual([1, 2])
    })

    it('loads empty when key is missing', () => {
        const store = createWebSnapshotStore<string>({
            key: 'missing',
            storage: createMemoryWebStorage(),
        })
        expect(store.load()).toEqual([])
    })

    it('throws StorageCodecError for corrupt snapshot JSON', () => {
        const storage = createMemoryWebStorage()
        storage.setItem('q', '{not-json')
        const store = createWebSnapshotStore<number>({ key: 'q', storage })
        expect(() => store.load()).toThrow(StorageCodecError)
    })
})

describe('createWebRowStore', () => {
    it('stores each row under its own key plus an order list', async () => {
        const storage = createMemoryWebStorage()
        let n = 0
        const store = createWebRowStore<string>({
            key: 'jobs',
            storage,
            createId: () => `id-${++n}`,
        })
        const queue = withPersist(buildQueue<string>(), store)

        queue.enqueue('a')
        queue.enqueue('b')
        await queue.flush()

        expect(storage.map.get('jobs:order')).toBe('["id-1","id-2"]')
        expect(storage.map.get('jobs:row:id-1')).toBe('"a"')
        expect(storage.map.get('jobs:row:id-2')).toBe('"b"')

        queue.dequeue()
        await queue.flush()

        expect(storage.map.get('jobs:order')).toBe('["id-2"]')
        expect(storage.map.has('jobs:row:id-1')).toBe(false)

        const restored = withPersist(
            buildQueue<string>(),
            createWebRowStore<string>({ key: 'jobs', storage }),
        )
        await restored.hydrate()
        expect(restored.toArray()).toEqual(['b'])
        expect(restored.rowIds()).toEqual(['id-2'])
    })

    it('clear removes order and all row keys', async () => {
        const storage = createMemoryWebStorage()
        let n = 0
        const store = createWebRowStore<{ n: number }>({
            key: 't',
            storage,
            createId: () => `r${++n}`,
        })
        const queue = withPersist(buildQueue<{ n: number }>(), store)

        queue.enqueue({ n: 1 })
        queue.enqueue({ n: 2 })
        await queue.flush()

        queue.clear()
        await queue.flush()

        expect(storage.map.size).toBe(0)
    })

    it('throws StorageCodecError for corrupt row payload', () => {
        const storage = createMemoryWebStorage()
        storage.setItem('jobs:order', '["id-1"]')
        storage.setItem('jobs:row:id-1', '{bad')
        const store = createWebRowStore<string>({ key: 'jobs', storage })
        expect(() => store.loadAll()).toThrow(StorageCodecError)
    })
})
