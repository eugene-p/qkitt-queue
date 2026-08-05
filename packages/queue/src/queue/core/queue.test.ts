import { describe, expect, it, vi } from 'vitest'
import { createMemoryRowStore } from '../../persist/stores/memory'
import { HydrateWhileActiveError, LeaseMismatchError } from '../../persist/errors'
import { buildQueue, InvalidQueueOptionError, QueueFullError } from './queue'
import { getQueueName } from './queue-name.util'
import { MAX_TIMER_DELAY_MS } from '../../util/schedule-timeout.util'

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (error?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

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

    it('preserves order after head compaction and appended work', async () => {
        const queue = buildQueue<number>()
        for (let i = 0; i < 2_048; i += 1) await queue.enqueue(i)
        for (let i = 0; i < 1_536; i += 1) {
            expect(await queue.dequeue()).toBe(i)
        }
        await queue.enqueue(2_048)
        await queue.enqueue(2_049)
        await queue.enqueue(2_050)

        expect(queue.toArray()).toEqual([
            ...Array.from({ length: 512 }, (_, i) => i + 1_536),
            2_048,
            2_049,
            2_050,
        ])
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

    it('coalesces queue:enqueued when multiple delayed items become available', async () => {
        vi.useFakeTimers()
        try {
            const queue = buildQueue<number>()
            const handler = vi.fn()
            queue.on('queue:enqueued', handler)
            await queue.enqueue(1, { delayMs: 10 })
            await queue.enqueue(2, { delayMs: 10 })
            handler.mockClear()

            await vi.advanceTimersByTimeAsync(10)

            expect(handler).toHaveBeenCalledTimes(1)
            expect(handler).toHaveBeenCalledWith({ item: 1, size: 2 })
        } finally {
            vi.useRealTimers()
        }
    })

    it('handles delays larger than the platform timer maximum', async () => {
        vi.useFakeTimers({ now: 0 })
        try {
            const queue = buildQueue<string>()
            await queue.enqueue('far away', {
                delayMs: MAX_TIMER_DELAY_MS + 1,
            })

            await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS)
            expect(queue.readyCount()).toBe(0)

            await vi.advanceTimersByTimeAsync(1)
            expect(queue.readyCount()).toBe(1)
            expect(await queue.dequeue()).toBe('far away')
        } finally {
            vi.useRealTimers()
        }
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

    it('preserves pending DLQ handoff state across a delay', async () => {
        vi.useFakeTimers()
        try {
            const queue = buildQueue<string>()
            await queue.enqueue('a')
            const first = await queue.claim()
            await queue.reschedule(first!, {
                item: 'a',
                delayMs: 10,
                dlqHandoffAttempt: 1,
            })
            await vi.advanceTimersByTimeAsync(10)
            const next = await queue.claim()
            expect(next?.dlqHandoffAttempt).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps lazy retry attempts aligned through an admin dequeue', async () => {
        const queue = buildQueue<string>()
        await queue.enqueue('first')
        await queue.enqueue('second')
        const first = await queue.claim()
        await queue.reschedule(first!, {
            item: 'first',
            attempt: 2,
        })

        expect(await queue.tryDequeue()).toEqual({ value: 'second' })
        const retried = await queue.claim()
        expect(retried).toMatchObject({
            item: 'first',
            attempt: 2,
        })
    })

    it('persists pending DLQ handoff state through hydrate', async () => {
        const store = createMemoryRowStore<string>()
        const source = buildQueue<string>({ store })
        await source.enqueue('a')
        const lease = await source.claim()
        await source.reschedule(lease!, {
            item: 'a',
            dlqHandoffAttempt: 1,
        })

        const recovered = buildQueue<string>({ store })
        await recovered.hydrate()
        expect((await recovered.claim())?.dlqHandoffAttempt).toBe(1)
    })

    it('preserves durable retry metadata after head compaction and hydrate', async () => {
        const store = createMemoryRowStore<number | string>()
        const source = buildQueue<number | string>({ store })
        for (let i = 0; i < 2_048; i += 1) await source.enqueue(i)

        for (let i = 0; i < 1_024; i += 1) {
            const lease = await source.claim()
            expect(lease?.item).toBe(i)
            await source.ack(lease!)
        }

        const retried = await source.claim()
        expect(retried?.item).toBe(1_024)
        await source.reschedule(retried!, {
            item: 'retry',
            attempt: 7,
            dlqHandoffAttempt: 3,
        })

        const recovered = buildQueue<number | string>({ store })
        await recovered.hydrate()

        const retryLease = await recovered.claim()
        expect(retryLease).toMatchObject({
            item: 'retry',
            attempt: 7,
            dlqHandoffAttempt: 3,
        })
        await recovered.ack(retryLease!)

        const remaining: Array<number | string> = []
        for (;;) {
            const lease = await recovered.claim()
            if (lease === undefined) break
            remaining.push(lease.item)
            await recovered.ack(lease)
        }
        expect(remaining).toEqual(
            Array.from({ length: 1_023 }, (_, i) => i + 1_025),
        )
    })

    it('keeps durable rows recoverable when dequeue persistence fails', async () => {
        const store = createMemoryRowStore<number>()
        const remove = store.remove
        let failOnce = true
        store.remove = (id) => {
            if (failOnce) {
                failOnce = false
                throw new Error('transient remove failure')
            }
            return remove(id)
        }

        const source = buildQueue<number>({ store })
        await source.enqueue(1)
        await source.enqueue(2)
        await expect(source.dequeue()).rejects.toThrow('transient remove failure')

        const recovered = buildQueue<number>({ store })
        await recovered.hydrate()
        expect(recovered.toArray()).toEqual([1, 2])
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

    it('serializes durable maxSize admission behind pending puts', async () => {
        const store = createMemoryRowStore<string>()
        const putStarted = deferred<void>()
        const releasePut = deferred<void>()
        const put = store.put
        store.put = async (record) => {
            if (record.item === 'one') {
                putStarted.resolve()
                await releasePut.promise
            }
            put(record)
        }
        const queue = buildQueue<string>({ store, maxSize: 1 })

        const first = queue.enqueue('one')
        await putStarted.promise
        const second = queue.enqueue('two')
        releasePut.resolve()

        const settled = await Promise.allSettled([first, second])
        expect(settled[0]!.status).toBe('fulfilled')
        expect(settled[1]!.status).toBe('rejected')
        expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(
            QueueFullError,
        )
        expect(queue.size()).toBe(1)
        expect(queue.toArray()).toEqual(['one'])
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

    it('does not replace a queue while a durable claim is queued', async () => {
        const store = createMemoryRowStore<string>()
        const claimPutStarted = deferred<void>()
        const releaseClaimPut = deferred<void>()
        const put = store.put
        store.put = async (record) => {
            if (record.leaseGeneration !== null) {
                claimPutStarted.resolve()
                await releaseClaimPut.promise
            }
            put(record)
        }
        const queue = buildQueue<string>({ store })
        await queue.enqueue('original')

        const claiming = queue.claim()
        await claimPutStarted.promise
        const replacing = queue.replaceAll(['replacement'])
        releaseClaimPut.resolve()

        const lease = await claiming
        expect(lease?.item).toBe('original')
        await expect(replacing).rejects.toBeInstanceOf(HydrateWhileActiveError)
        await queue.ack(lease!)
        expect(queue.size()).toBe(0)
        expect(store.rows).toEqual([])
    })

    it('does not hydrate over a durable claim that was already queued', async () => {
        const store = createMemoryRowStore<string>()
        const claimPutStarted = deferred<void>()
        const releaseClaimPut = deferred<void>()
        const put = store.put
        store.put = async (record) => {
            if (record.leaseGeneration !== null) {
                claimPutStarted.resolve()
                await releaseClaimPut.promise
            }
            put(record)
        }
        const queue = buildQueue<string>({ store })
        await queue.enqueue('original')

        const claiming = queue.claim()
        await claimPutStarted.promise
        const hydrating = queue.hydrate()
        releaseClaimPut.resolve()

        const lease = await claiming
        expect(lease?.item).toBe('original')
        await expect(hydrating).rejects.toBeInstanceOf(HydrateWhileActiveError)
        expect(queue.stats()).toEqual({ available: 0, delayed: 0, leased: 1 })
        await queue.ack(lease!)
        expect(queue.size()).toBe(0)
    })

    it.each(['load', 'put', 'remove', 'clear', 'replace'] as const)(
        'emits persist:error when %s fails',
        async (operation) => {
            const error = new Error(`${operation} failed`)
            const store = createMemoryRowStore<number>()
            const queue = buildQueue<number>({ store })
            const onError = vi.fn()
            queue.on('persist:error', onError)

            if (operation === 'load') {
                store.loadAll = () => {
                    throw error
                }
                await expect(queue.hydrate()).rejects.toBe(error)
            } else if (operation === 'put') {
                store.put = () => {
                    throw error
                }
                await expect(queue.enqueue(1)).rejects.toBe(error)
            } else if (operation === 'remove') {
                await queue.enqueue(1)
                store.remove = () => {
                    throw error
                }
                await expect(queue.dequeue()).rejects.toBe(error)
            } else if (operation === 'clear') {
                await queue.enqueue(1)
                store.clear = () => {
                    throw error
                }
                await expect(queue.clear()).rejects.toBe(error)
            } else {
                store.replaceAll = () => {
                    throw error
                }
                await expect(queue.replaceAll([1])).rejects.toBe(error)
            }

            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({ operation, error }),
            )
        },
    )

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
