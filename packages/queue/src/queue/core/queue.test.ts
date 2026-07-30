import { describe, expect, it, vi } from 'vitest'
import { createMemoryRowStore } from '../../persist/stores/memory'
import { HydrateWhileActiveError, LeaseMismatchError } from '../../persist/errors'
import { buildQueue, InvalidQueueOptionError, QueueFullError } from './queue'
import { getQueueName } from './queue-name.util'

describe('buildQueue', () => {
    it('enqueues and dequeues in FIFO order', async () => {
        const queue = buildQueue<number>()

        await queue.enqueue(1)
        await queue.enqueue(2)
        await queue.enqueue(3)

        expect(queue.size()).toBe(3)
        expect(await queue.dequeue()).toBe(1)
        expect(await queue.dequeue()).toBe(2)
        expect(await queue.dequeue()).toBe(3)
        expect(await queue.dequeue()).toBeUndefined()
        expect(queue.isEmpty()).toBe(true)
    })

    it('peek returns the head without removing it', async () => {
        const queue = buildQueue<string>()

        expect(queue.peek()).toBeUndefined()

        await queue.enqueue('a')
        await queue.enqueue('b')

        expect(queue.peek()).toBe('a')
        expect(queue.size()).toBe(2)
        expect(await queue.dequeue()).toBe('a')
        expect(queue.peek()).toBe('b')
    })

    it('toArray returns a snapshot from head to tail', async () => {
        const queue = buildQueue<number>()

        await queue.enqueue(1)
        await queue.enqueue(2)

        const snapshot = queue.toArray()
        expect(snapshot).toEqual([1, 2])

        snapshot.push(3)
        expect(queue.toArray()).toEqual([1, 2])
    })

    it('toArray preserves order after mixed enqueue/dequeue', async () => {
        const queue = buildQueue<number>()
        await queue.enqueue(1)
        await queue.enqueue(2)
        await queue.enqueue(3)
        expect(await queue.dequeue()).toBe(1)
        await queue.enqueue(4)
        expect(queue.toArray()).toEqual([2, 3, 4])
    })

    it('emits queue:enqueued with item and size', async () => {
        const queue = buildQueue<string>()
        const handler = vi.fn()

        queue.on('queue:enqueued', handler)
        await queue.enqueue('x')
        await queue.enqueue('y')

        expect(handler).toHaveBeenCalledTimes(2)
        expect(handler).toHaveBeenNthCalledWith(1, { item: 'x', size: 1 })
        expect(handler).toHaveBeenNthCalledWith(2, { item: 'y', size: 2 })
    })

    it('keeps event delivery active after an unsubscribe is called twice', async () => {
        const queue = buildQueue<number>()
        const first = vi.fn()
        const second = vi.fn()
        const off = queue.on('queue:enqueued', first)
        queue.on('queue:enqueued', second)

        off()
        off()
        await queue.enqueue(1)

        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledWith({ item: 1, size: 1 })
    })

    it('emits queue:dequeued and queue:emptied on admin drop', async () => {
        const queue = buildQueue<number>()
        const dequeued = vi.fn()
        const emptied = vi.fn()

        queue.on('queue:dequeued', dequeued)
        queue.on('queue:emptied', emptied)

        await queue.enqueue(10)
        await queue.enqueue(20)

        expect(await queue.dequeue()).toBe(10)
        expect(dequeued).toHaveBeenLastCalledWith({ item: 10, size: 1 })
        expect(emptied).not.toHaveBeenCalled()

        expect(await queue.dequeue()).toBe(20)
        expect(dequeued).toHaveBeenLastCalledWith({ item: 20, size: 0 })
        expect(emptied).toHaveBeenCalledOnce()
    })

    it('claim/ack removes work; late ack mismatches', async () => {
        const queue = buildQueue<string>()
        await queue.enqueue('job')
        const lease = await queue.claim()
        expect(lease?.item).toBe('job')
        expect(queue.stats().leased).toBe(1)
        expect(queue.readyCount()).toBe(0)
        await queue.ack(lease!)
        expect(queue.size()).toBe(0)
        await expect(queue.ack(lease!)).rejects.toBeInstanceOf(
            LeaseMismatchError,
        )
    })

    it('reschedule with delay keeps size and not ready', async () => {
        const queue = buildQueue<string>()
        await queue.enqueue('a')
        const lease = await queue.claim()
        await queue.reschedule(lease!, { item: 'a', delayMs: 60_000 })
        expect(queue.size()).toBe(1)
        expect(queue.readyCount()).toBe(0)
        expect(queue.stats().delayed).toBe(1)
    })

    it('size counts delayed and leased; readyCount only available', async () => {
        const queue = buildQueue<number>()
        await queue.enqueue(1)
        await queue.enqueue(2, { delayMs: 60_000 })
        const lease = await queue.claim()
        expect(queue.size()).toBe(2)
        expect(queue.readyCount()).toBe(0)
        expect(queue.stats()).toEqual({
            available: 0,
            delayed: 1,
            leased: 1,
        })
        await queue.ack(lease!)
    })

    it('durable claim survives hydrate reclaim', async () => {
        const store = createMemoryRowStore<string>()
        const q1 = buildQueue<string>({ store })
        await q1.enqueue('work')
        const lease = await q1.claim()
        expect(lease?.item).toBe('work')
        // Simulate crash: new queue + hydrate without ack
        const q2 = buildQueue<string>({ store })
        await q2.hydrate()
        expect(q2.readyCount()).toBe(1)
        const again = await q2.claim()
        expect(again?.item).toBe('work')
        await q2.ack(again!)
        expect(q2.size()).toBe(0)
    })

    it('durable success path gone after hydrate', async () => {
        const store = createMemoryRowStore<number>()
        const q = buildQueue<number>({ store })
        await q.enqueue(1)
        const lease = await q.claim()
        await q.ack(lease!)
        const q2 = buildQueue<number>({ store })
        await q2.hydrate()
        expect(q2.size()).toBe(0)
    })

    it('reclaims expired leases without a durable store', async () => {
        vi.useFakeTimers()
        try {
            const queue = buildQueue<number>({ leaseTtlMs: 100 })
            await queue.enqueue(1)
            const lease = await queue.claim()

            expect(lease?.item).toBe(1)
            await vi.advanceTimersByTimeAsync(100)

            expect(queue.readyCount()).toBe(1)
            expect(queue.stats()).toEqual({
                available: 1,
                delayed: 0,
                leased: 0,
            })
        } finally {
            vi.useRealTimers()
        }
    })

    it('throws QueueFullError at maxSize', async () => {
        const queue = buildQueue<number>({ maxSize: 1 })
        await queue.enqueue(1)
        await expect(queue.enqueue(2)).rejects.toBeInstanceOf(QueueFullError)
    })

    it('rejects invalid maxSize', () => {
        expect(() => buildQueue({ maxSize: 0 })).toThrow(
            InvalidQueueOptionError,
        )
    })

    it('stores and returns name', () => {
        const queue = buildQueue({ name: ' jobs ' })
        expect(getQueueName(queue)).toBe('jobs')
    })

    it('tryDequeue returns slot for nullish payloads', async () => {
        const queue = buildQueue<null | undefined>()
        await queue.enqueue(null)
        await queue.enqueue(undefined)
        expect(await queue.tryDequeue()).toEqual({ value: null })
        expect(await queue.tryDequeue()).toEqual({ value: undefined })
        expect(await queue.tryDequeue()).toBeUndefined()
    })

    it('clear empties all states', async () => {
        const queue = buildQueue<number>()
        await queue.enqueue(1)
        await queue.enqueue(2, { delayMs: 60_000 })
        await queue.claim()
        await queue.clear()
        expect(queue.size()).toBe(0)
        expect(queue.stats()).toEqual({
            available: 0,
            delayed: 0,
            leased: 0,
        })
    })

    it('replaceAll replaces available set when idle', async () => {
        const queue = buildQueue<string>()
        await queue.enqueue('a')
        await queue.replaceAll(['x', 'y'])
        expect(queue.toArray()).toEqual(['x', 'y'])
    })

    it('rejects every mutation while hydrate is loading', async () => {
        let beginLoad!: () => void
        let resolveLoad!: (rows: never[]) => void
        const loadStarted = new Promise<void>((resolve) => {
            beginLoad = resolve
        })
        const store = {
            loadAll: () => {
                beginLoad()
                return new Promise<never[]>((resolve) => {
                    resolveLoad = resolve
                })
            },
            put: () => {},
            remove: () => {},
            clear: () => {},
        }
        const queue = buildQueue<number>({ store })
        const hydrating = queue.hydrate()
        await loadStarted

        await expect(queue.clear()).rejects.toBeInstanceOf(
            HydrateWhileActiveError,
        )
        await expect(queue.replaceAll([1])).rejects.toBeInstanceOf(
            HydrateWhileActiveError,
        )
        await expect(queue.hydrate()).rejects.toBeInstanceOf(
            HydrateWhileActiveError,
        )

        resolveLoad([])
        await hydrating
    })
})
