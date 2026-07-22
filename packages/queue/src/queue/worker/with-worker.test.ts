import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import { withWorker } from './with-worker'

const flush = async (times = 1) => {
    for (let i = 0; i < times; i += 1) {
        await Promise.resolve()
    }
}

const waitForIdle = (queue: {
    on: (event: 'worker:idle', cb: () => void) => () => void
}) =>
    new Promise<void>((resolve) => {
        const off = queue.on('worker:idle', () => {
            off()
            resolve()
        })
    })

describe('withWorker', () => {
    it('processes items in FIFO order', async () => {
        const order: number[] = []
        const queue = withWorker(buildQueue<number>(), async (item) => {
            order.push(item)
            return item * 2
        })

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        queue.enqueue(2)
        queue.enqueue(3)
        await idle

        expect(order).toEqual([1, 2, 3])
        expect(queue.isEmpty()).toBe(true)
        expect(queue.isProcessing()).toBe(false)
    })

    it('emits started, completed, and idle events', async () => {
        const queue = withWorker(buildQueue<string>(), async (item) => item.toUpperCase())

        const started = vi.fn()
        const completed = vi.fn()
        const idle = vi.fn()

        queue.on('worker:started', started)
        queue.on('worker:completed', completed)
        queue.on('worker:idle', idle)

        const idlePromise = waitForIdle(queue)
        queue.enqueue('a')
        await idlePromise

        expect(started).toHaveBeenCalledWith({ item: 'a' })
        expect(completed).toHaveBeenCalledWith({ item: 'a', result: 'A' })
        expect(idle).toHaveBeenCalledOnce()
    })

    it('emits worker:failed when the worker throws', async () => {
        const error = new Error('boom')
        const queue = withWorker(buildQueue<number>(), async () => {
            throw error
        })

        const failed = vi.fn()
        queue.on('worker:failed', failed)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        expect(failed).toHaveBeenCalledWith({ item: 1, error })
        expect(queue.isEmpty()).toBe(true)
    })

    it('does not start when autoStart is false until start() is called', async () => {
        const worker = vi.fn(async (item: number) => item)
        const queue = withWorker(buildQueue<number>(), worker, { autoStart: false })

        queue.enqueue(1)
        await flush()

        expect(worker).not.toHaveBeenCalled()
        expect(queue.size()).toBe(1)
        expect(queue.isRunning()).toBe(false)

        const idle = waitForIdle(queue)
        queue.start()
        expect(queue.isRunning()).toBe(true)
        await idle

        expect(worker).toHaveBeenCalledWith(1)
    })

    it('autoStart false has no queue:enqueued listener until start()', () => {
        const bare = buildQueue<number>()
        const onSpy = vi.spyOn(bare, 'on')
        const worker = vi.fn(async (item: number) => item)
        const queue = withWorker(bare, worker, { autoStart: false })

        const enqueuedCalls = () =>
            onSpy.mock.calls.filter(([eventName]) => eventName === 'queue:enqueued')

        expect(enqueuedCalls()).toHaveLength(0)

        queue.start()
        expect(enqueuedCalls()).toHaveLength(1)

        // Repeated start does not double-subscribe.
        queue.start()
        expect(enqueuedCalls()).toHaveLength(1)
    })

    it('stop unsubscribes; later start restores processing', async () => {
        const bare = buildQueue<number>()
        const enqueuedUnsubs: Array<ReturnType<typeof vi.fn>> = []
        const originalOn = bare.on.bind(bare)
        bare.on = ((eventName, callback) => {
            const unsub = originalOn(eventName, callback)
            if (eventName === 'queue:enqueued') {
                const tracked = vi.fn(unsub)
                enqueuedUnsubs.push(tracked)
                return tracked
            }
            return unsub
        }) as typeof bare.on

        const worker = vi.fn(async (item: number) => item)
        const queue = withWorker(bare, worker, { autoStart: false })

        queue.start()
        expect(enqueuedUnsubs).toHaveLength(1)

        const idle1 = waitForIdle(queue)
        queue.enqueue(1)
        await idle1
        expect(worker).toHaveBeenCalledWith(1)

        queue.stop()
        expect(queue.isRunning()).toBe(false)
        expect(enqueuedUnsubs[0]).toHaveBeenCalledOnce()

        worker.mockClear()
        queue.enqueue(2)
        await flush(3)
        expect(worker).not.toHaveBeenCalled()
        expect(queue.size()).toBe(1)

        const idle2 = waitForIdle(queue)
        queue.start()
        expect(enqueuedUnsubs).toHaveLength(2)
        await idle2
        expect(worker).toHaveBeenCalledWith(2)
        expect(queue.isEmpty()).toBe(true)
    })

    it('hydrate + running worker still drains restored items', async () => {
        const { withPersist } = await import('../../persist/with-persist')
        const items: number[] = [1, 2]
        const store = {
            load: async () => [...items],
            save: async (next: readonly number[]) => {
                items.length = 0
                items.push(...next)
            },
        }
        const processed: number[] = []
        const queue = withWorker(
            withPersist(buildQueue<number>(), store),
            async (item) => {
                processed.push(item)
            },
        )

        const idle = waitForIdle(queue)
        await queue.hydrate()
        await idle
        await queue.flush()

        expect(processed).toEqual([1, 2])
        expect(queue.isEmpty()).toBe(true)
        expect(items).toEqual([])
    })

    it('hydrate kick drains when restored head is undefined', async () => {
        const { withPersist } = await import('../../persist/with-persist')
        const items: Array<string | undefined> = [undefined, 'tail']
        const store = {
            load: async () => [...items],
            save: async (next: readonly (string | undefined)[]) => {
                items.length = 0
                items.push(...next)
            },
        }
        const processed: Array<string | undefined> = []
        const queue = withWorker(
            withPersist(buildQueue<string | undefined>(), store),
            async (item) => {
                processed.push(item)
            },
        )

        const idle = waitForIdle(queue)
        await queue.hydrate()
        await idle
        await queue.flush()

        expect(processed).toEqual([undefined, 'tail'])
        expect(queue.isEmpty()).toBe(true)
    })

    it('stop prevents taking new items while in-flight work finishes', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const worker = vi.fn(async (item: number) => {
            if (item === 1) await gate
            return item
        })

        const queue = withWorker(buildQueue<number>(), worker, { concurrency: 1 })

        queue.enqueue(1)
        queue.enqueue(2)
        await flush()

        expect(worker).toHaveBeenCalledTimes(1)
        expect(queue.isProcessing()).toBe(true)
        expect(queue.activeCount()).toBe(1)

        queue.stop()
        release()
        await flush()
        await flush()

        expect(worker).toHaveBeenCalledTimes(1)
        expect(queue.size()).toBe(1)
        expect(queue.peek()).toBe(2)
        expect(queue.isRunning()).toBe(false)
    })

    it('respects concurrency', async () => {
        let current = 0
        let maxConcurrent = 0
        const releases: Array<() => void> = []

        const worker = vi.fn(async (item: number) => {
            current += 1
            maxConcurrent = Math.max(maxConcurrent, current)
            await new Promise<void>((resolve) => {
                releases.push(resolve)
            })
            current -= 1
            return item
        })

        const queue = withWorker(buildQueue<number>(), worker, { concurrency: 2 })

        queue.enqueue(1)
        queue.enqueue(2)
        queue.enqueue(3)
        await flush(3)

        expect(worker).toHaveBeenCalledTimes(2)
        expect(queue.activeCount()).toBe(2)
        expect(maxConcurrent).toBe(2)

        releases[0]!()
        await flush(5)

        expect(worker).toHaveBeenCalledTimes(3)

        releases[1]!()
        releases[2]!()
        await flush(5)

        expect(queue.isEmpty()).toBe(true)
        expect(queue.isProcessing()).toBe(false)
    })

    it('still exposes the underlying queue API', async () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n)

        const enqueued = vi.fn()
        queue.on('queue:enqueued', enqueued)

        const idle = waitForIdle(queue)
        queue.enqueue(42)
        await idle

        expect(enqueued).toHaveBeenCalledWith({ item: 42, size: 1 })
        // dequeued by the worker
        expect(queue.size()).toBe(0)
    })

    it('rejects non-integer concurrency', () => {
        expect(() =>
            withWorker(buildQueue<number>(), async (n) => n, {
                concurrency: NaN,
            }),
        ).toThrow(/concurrency/)
        expect(() =>
            withWorker(buildQueue<number>(), async (n) => n, {
                concurrency: 0,
            }),
        ).toThrow(/concurrency/)
        expect(() =>
            withWorker(buildQueue<number>(), async (n) => n, {
                concurrency: 1.5,
            }),
        ).toThrow(/concurrency/)
        expect(() =>
            withWorker(buildQueue<number>(), async (n) => n, {
                concurrency: Infinity,
            }),
        ).toThrow(/concurrency/)
        expect(() =>
            withWorker(buildQueue<number>(), async (n) => n, {
                concurrency: -1,
            }),
        ).toThrow(/concurrency/)
    })

    it('waits on QueueHydratingError without stopping or emitting pump-error', async () => {
        const { QueueHydratingError } = await import('../../persist/hydrate-gate.util')
        const queue = buildQueue<number>()
        const originalTryDequeue = queue.tryDequeue.bind(queue)
        let failNext = false
        queue.tryDequeue = () => {
            if (failNext) {
                throw new QueueHydratingError()
            }
            return originalTryDequeue()
        }

        let release!: () => void
        const hold = new Promise<void>((resolve) => {
            release = resolve
        })

        const workerQueue = withWorker(
            queue,
            async (item) => {
                if (item === 1) await hold
                return item
            },
            { concurrency: 1 },
        )
        const pumpError = vi.fn()
        workerQueue.on('worker:pump-error', pumpError)

        workerQueue.enqueue(1)
        workerQueue.enqueue(2)
        await flush()

        failNext = true
        release()
        await flush(5)

        expect(pumpError).not.toHaveBeenCalled()
        expect(workerQueue.isRunning()).toBe(true)
        expect(workerQueue.size()).toBe(1)
        expect(workerQueue.peek()).toBe(2)

        failNext = false
        workerQueue.enqueue(3)
        const idle = waitForIdle(workerQueue)
        await idle
        expect(workerQueue.isEmpty()).toBe(true)
    })

    it('emits worker:pump-error and stops on unexpected dequeue failures', async () => {
        const queue = buildQueue<number>()
        const originalTryDequeue = queue.tryDequeue.bind(queue)
        let failNext = false
        const boom = new Error('custom dequeue failure')
        queue.tryDequeue = () => {
            if (failNext) {
                throw boom
            }
            return originalTryDequeue()
        }

        let release!: () => void
        const hold = new Promise<void>((resolve) => {
            release = resolve
        })

        const workerQueue = withWorker(
            queue,
            async (item) => {
                if (item === 1) await hold
                return item
            },
            { concurrency: 1 },
        )
        const pumpError = vi.fn()
        workerQueue.on('worker:pump-error', pumpError)

        workerQueue.enqueue(1)
        workerQueue.enqueue(2)
        await flush()

        failNext = true
        release()
        await flush(5)

        expect(pumpError).toHaveBeenCalledWith({ error: boom })
        expect(workerQueue.isRunning()).toBe(false)
        expect(workerQueue.size()).toBe(1)
        expect(workerQueue.peek()).toBe(2)

        // Enqueue while stopped does not resume processing.
        failNext = false
        workerQueue.enqueue(3)
        await flush(5)
        expect(workerQueue.size()).toBe(2)

        // Explicit start recovers after the failure is fixed.
        const idle = waitForIdle(workerQueue)
        workerQueue.start()
        await idle
        expect(workerQueue.isEmpty()).toBe(true)
    })

    it('processes undefined and null payloads (not treated as empty)', async () => {
        const seen: Array<string | null | undefined> = []
        const queue = withWorker(
            buildQueue<string | null | undefined>(),
            async (item) => {
                seen.push(item)
                return item
            },
        )

        const idle = waitForIdle(queue)
        queue.enqueue(undefined)
        queue.enqueue(null)
        queue.enqueue('done')
        await idle

        expect(seen).toEqual([undefined, null, 'done'])
        expect(queue.isEmpty()).toBe(true)
    })

    it('runs sync workers without an outer async hop', async () => {
        const order: number[] = []
        const queue = withWorker(buildQueue<number>(), (item) => {
            order.push(item)
            return item * 2
        })

        const completed = vi.fn()
        queue.on('worker:completed', completed)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        queue.enqueue(2)
        await idle

        expect(order).toEqual([1, 2])
        expect(completed).toHaveBeenNthCalledWith(1, { item: 1, result: 2 })
        expect(completed).toHaveBeenNthCalledWith(2, { item: 2, result: 4 })
    })

    it('drains many sync jobs without stack overflow', async () => {
        const n = 5_000
        let count = 0
        const queue = withWorker(buildQueue<number>(), (item) => {
            count += 1
            return item
        })

        const idle = waitForIdle(queue)
        for (let i = 0; i < n; i += 1) queue.enqueue(i)
        await idle

        expect(count).toBe(n)
        expect(queue.isEmpty()).toBe(true)
    })

    it('emits worker:failed when a sync worker throws', async () => {
        const error = new Error('sync boom')
        const queue = withWorker(buildQueue<number>(), () => {
            throw error
        })

        const failed = vi.fn()
        queue.on('worker:failed', failed)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        expect(failed).toHaveBeenCalledWith({ item: 1, error })
    })
})
