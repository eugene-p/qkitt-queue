import { describe, expect, it } from 'vitest'
import { buildQueue } from '../../queue/core/queue'
import { withPersist } from '../with-persist'
import { createMemoryRowStore, createMemorySnapshotStore } from './memory'

describe('createMemorySnapshotStore', () => {
    it('round-trips through withPersist', async () => {
        const store = createMemorySnapshotStore<string>(['a'], {
            autoSave: false,
        })
        const queue = withPersist(buildQueue<string>(), store)

        await queue.hydrate()
        expect(queue.toArray()).toEqual(['a'])

        queue.enqueue('b')
        await queue.persist()
        expect(store.data).toEqual(['a', 'b'])
    })
})

describe('createMemoryRowStore', () => {
    it('round-trips through withPersist', async () => {
        const store = createMemoryRowStore<string>(
            [{ id: '1', item: 'x' }],
            { createId: () => '2' },
        )
        const first = withPersist(buildQueue<string>(), store)

        await first.hydrate()
        first.enqueue('y')
        await first.flush()
        first.dequeue()
        await first.flush()

        const second = withPersist(buildQueue<string>(), store)
        await second.hydrate()

        expect(second.toArray()).toEqual(['y'])
        expect(second.rowIds()).toEqual(['2'])
        expect(store.rows).toEqual([{ id: '2', item: 'y' }])
    })

    it('upserts on insert with the same id', () => {
        const store = createMemoryRowStore<string>()
        store.insert({ id: 'a', item: 'one' })
        store.insert({ id: 'a', item: 'two' })
        expect(store.rows).toEqual([{ id: 'a', item: 'two' }])
    })
})
