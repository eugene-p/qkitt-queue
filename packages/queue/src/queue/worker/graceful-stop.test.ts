import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRowStore } from '../../persist/stores/memory'
import { buildQueue } from '../core/queue'
import { InvalidWorkerOptionError } from './invalid-worker-option-error'
import { LifecycleTimeoutError } from './lifecycle-timeout-error'
import { gracefulStop } from './graceful-stop'
import { withWorker } from './with-worker'

afterEach(() => {
    vi.useRealTimers()
})

const flushMicro = async (n = 3) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve()
}

describe('gracefulStop', () => {
    it('stops and waits for in-flight work; leaves remaining items queued', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const processed: number[] = []
        const queue = withWorker(
            buildQueue<number>(),
            async (n) => {
                await gate
                processed.push(n)
                return n
            },
            { concurrency: 1 },
        )

        queue.enqueue(1)
        queue.enqueue(2)
        await flushMicro(5)
        expect(queue.isProcessing()).toBe(true)

        const stopping = gracefulStop(queue)
        release()
        await stopping

        expect(queue.isRunning()).toBe(false)
        expect(queue.isProcessing()).toBe(false)
        expect(processed).toEqual([1])
        expect(queue.size()).toBe(1)
        expect(queue.peek()).toBe(2)
    })

    it('resolves promptly when nothing is in flight', async () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n, {
            autoStart: false,
        })
        queue.enqueue(1)
        await gracefulStop(queue)
        expect(queue.isRunning()).toBe(false)
        expect(queue.isProcessing()).toBe(false)
        expect(queue.size()).toBe(1)
    })

    it('method form matches standalone', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const queue = withWorker(buildQueue<string>(), async (s) => {
            await gate
            return s
        })
        queue.enqueue('a')
        await flushMicro(5)

        const stopping = queue.gracefulStop()
        release()
        await stopping
        expect(queue.isRunning()).toBe(false)
    })

    it('flush: true drains write chain on durable queue', async () => {
        const store = createMemoryRowStore<string>()
        const queue = withWorker(
            buildQueue<string>({ store }),
            async (s) => s,
            { autoStart: false },
        )
        await queue.enqueue('pending')
        await gracefulStop(queue, { flush: true })
        expect(queue.isRunning()).toBe(false)
        expect(queue.size()).toBe(1)
        expect(store.rows).toHaveLength(1)
    })

    it('flush: true is a no-op when flush resolves', async () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n)
        await expect(
            gracefulStop(queue, { flush: true }),
        ).resolves.toBeUndefined()
    })

    it('rejects with LifecycleTimeoutError when in-flight never settles', async () => {
        vi.useFakeTimers()
        const queue = withWorker(buildQueue<number>(), async (n) => {
            await new Promise(() => {})
            return n
        })
        queue.enqueue(1)
        await flushMicro(5)

        const stopping = gracefulStop(queue, { timeoutMs: 40 })
        const expectation = expect(stopping).rejects.toBeInstanceOf(
            LifecycleTimeoutError,
        )
        await vi.advanceTimersByTimeAsync(40)
        await expectation
    })

    it('calls flush only once when concurrent work finishes', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const flush = vi.fn(async () => {})
        const queue = withWorker(
            buildQueue<number>(),
            async (n) => {
                await gate
                return n
            },
            { concurrency: 2 },
        )
        const target = Object.assign(queue, { flush })

        queue.enqueue(1)
        queue.enqueue(2)
        await flushMicro(5)
        expect(queue.activeCount()).toBe(2)

        const stopping = gracefulStop(target, { flush: true })
        release()
        await stopping
        expect(flush).toHaveBeenCalledOnce()
    })

    it('settles when in-flight work fails', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const queue = withWorker(buildQueue<number>(), async () => {
            await gate
            throw new Error('boom')
        })
        queue.enqueue(1)
        await flushMicro(5)

        const stopping = gracefulStop(queue)
        release()
        await stopping
        expect(queue.isProcessing()).toBe(false)
        expect(queue.isRunning()).toBe(false)
    })

    it('propagates flush rejection', async () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n, {
            autoStart: false,
        })
        const target = Object.assign(queue, {
            flush: async () => {
                throw new Error('flush failed')
            },
        })
        await expect(gracefulStop(target, { flush: true })).rejects.toThrow(
            'flush failed',
        )
    })

    it('throws InvalidWorkerOptionError for invalid timeoutMs', () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n)
        expect(() => gracefulStop(queue, { timeoutMs: -1 })).toThrow(
            InvalidWorkerOptionError,
        )
    })
})
