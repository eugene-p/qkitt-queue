import { describe, expect, it } from 'vitest'
import { buildQueue } from '../queue/core/queue'
import {
    withRowPersist,
    type RowRecord,
} from '../queue/persist/with-row-persist'
import { withSnapshotPersist } from '../queue/persist/with-snapshot-persist'
import { createMemoryRowStore, createMemorySnapshotStore } from './memory'

describe('createMemorySnapshotStore', () => {
    it('round-trips through withSnapshotPersist', async () => {
        const store = createMemorySnapshotStore<string>(['a'])
        const queue = withSnapshotPersist(buildQueue<string>(), store, {
            autoSave: false,
        })

        await queue.hydrate()
        expect(queue.toArray()).toEqual(['a'])

        queue.enqueue('b')
        await queue.persist()
        expect(store.data).toEqual(['a', 'b'])
    })
})

describe('createMemoryRowStore', () => {
    it('round-trips through withRowPersist', async () => {
        const store = createMemoryRowStore<string>([
            { id: '1', item: 'x' },
        ])
        const first = withRowPersist(buildQueue<RowRecord<string>>(), store, {
            createId: () => '2',
        })

        await first.hydrate()
        first.enqueue('y')
        await first.flush()
        first.dequeue()
        await first.flush()

        const second = withRowPersist(buildQueue<RowRecord<string>>(), store)
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
