import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import { InvalidWorkerOptionError } from './invalid-worker-option-error'
import { LifecycleTimeoutError, whenIdle } from './when-idle'
import { withWorker } from './with-worker'

afterEach(() => {
    vi.useRealTimers()
})

describe('whenIdle', () => {
    it('resolves immediately when already idle', async () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n)
        await expect(whenIdle(queue)).resolves.toBeUndefined()
    })

    it('resolves after work drains', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const queue = withWorker(buildQueue<number>(), async (n) => {
            await gate
            return n
        })

        queue.enqueue(1)
        queue.enqueue(2)
        await Promise.resolve()
        expect(queue.isProcessing()).toBe(true)

        const idle = whenIdle(queue)
        let done = false
        void idle.then(() => {
            done = true
        })
        await Promise.resolve()
        expect(done).toBe(false)

        release()
        await idle
        expect(queue.isEmpty()).toBe(true)
        expect(queue.isProcessing()).toBe(false)
    })

    it('resolves once when concurrent work finishes', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const queue = withWorker(
            buildQueue<number>(),
            async (n) => {
                await gate
                return n
            },
            { concurrency: 2 },
        )

        const idle = whenIdle(queue)
        queue.enqueue(1)
        queue.enqueue(2)
        release()
        await idle
        expect(queue.isEmpty()).toBe(true)
    })

    it('rejects with LifecycleTimeoutError when timeout elapses', async () => {
        vi.useFakeTimers()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const queue = withWorker(buildQueue<number>(), async (n) => {
            await gate
            return n
        })

        queue.enqueue(1)
        const idle = whenIdle(queue, { timeoutMs: 50 })
        const expectation = expect(idle).rejects.toMatchObject({
            name: 'LifecycleTimeoutError',
            timeoutMs: 50,
        })
        await vi.advanceTimersByTimeAsync(50)
        await expectation
        release()
    })

    it('throws InvalidWorkerOptionError for invalid timeoutMs', () => {
        const queue = withWorker(buildQueue<number>(), async (n) => n)
        expect(() => whenIdle(queue, { timeoutMs: -1 })).toThrow(
            InvalidWorkerOptionError,
        )
        expect(() => whenIdle(queue, { timeoutMs: Number.NaN })).toThrow(
            InvalidWorkerOptionError,
        )
    })

    it('does not resolve when stopped with items still queued', async () => {
        vi.useFakeTimers()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const queue = withWorker(buildQueue<number>(), async (n) => {
            await gate
            return n
        })

        queue.enqueue(1)
        queue.enqueue(2)
        // Let first item start
        await Promise.resolve()
        queue.stop()
        release()
        // First in-flight finishes; second remains queued → not idle
        await Promise.resolve()
        await Promise.resolve()

        const idle = whenIdle(queue, { timeoutMs: 30 })
        const expectation = expect(idle).rejects.toBeInstanceOf(
            LifecycleTimeoutError,
        )
        await vi.advanceTimersByTimeAsync(30)
        await expectation
        expect(queue.size()).toBe(1)
    })
})
