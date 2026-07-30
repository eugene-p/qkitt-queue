import { describe, expect, it, vi } from 'vitest'
import { createMemoryRowStore } from '../../persist/stores/memory'
import { buildQueue } from '../core/queue'
import { withDeadLetter } from '../dlq/with-dead-letter'
import { withWorker } from '../worker/with-worker'
import {
    InvalidDurableRetryOptionError,
    withRetry,
} from './with-retry'

const waitForIdle = (queue: {
    on: (event: 'worker:idle', cb: () => void) => () => void
}) =>
    new Promise<void>((resolve) => {
        const off = queue.on('worker:idle', () => {
            off()
            resolve()
        })
    })

describe('withRetry', () => {
    it('persists the next attempt without changing the application payload', async () => {
        const store = createMemoryRowStore<{ id: string }>()
        const seen: string[] = []
        const scheduled = vi.fn()
        const queue = withRetry(
            withWorker(buildQueue({ store }), async (job) => {
                seen.push(job.id)
                if (seen.length === 1) throw new Error('temporary')
            }),
            { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        )
        queue.on('retry:scheduled', scheduled)

        const idle = waitForIdle(queue)
        await queue.enqueue({ id: 'job-1' })
        await idle

        expect(seen).toEqual(['job-1', 'job-1'])
        expect(queue.isEmpty()).toBe(true)
        expect(scheduled).toHaveBeenCalledWith({
            item: { id: 'job-1' },
            error: expect.any(Error),
            attempt: 1,
            nextAttempt: 2,
            delayMs: 0,
        })
    })

    it('writes the scheduled attempt into the durable row for a later hydrate', async () => {
        const store = createMemoryRowStore<string>()
        const queue = withRetry(
            withWorker(
                buildQueue({ store }),
                async () => {
                    throw new Error('temporary')
                },
            ),
            {
                maxAttempts: 2,
                initialDelayMs: 50,
                maxDelayMs: 50,
                jitter: 0,
            },
        )

        const scheduled = new Promise<void>((resolve) => {
            queue.on('retry:scheduled', () => {
                queue.stop()
                resolve()
            })
        })
        await queue.enqueue('job-1')
        await scheduled
        await queue.flush()

        expect(store.rows).toHaveLength(1)
        expect(store.rows[0]).toMatchObject({
            item: 'job-1',
            attempt: 2,
            leaseGeneration: null,
        })

        const recovered = buildQueue({ store })
        await recovered.hydrate()
        expect(store.rows[0]?.attempt).toBe(2)
    })

    it('hands exhausted and classified failures to the configured DLQ', async () => {
        const dead = buildQueue<string>()
        const exhausted = vi.fn()
        const queue = withDeadLetter(
            withRetry(
                withWorker(buildQueue<string>(), () => {
                    throw new Error('permanent')
                }),
                { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
            ),
            dead,
        )
        queue.on('retry:exhausted', exhausted)

        const idle = waitForIdle(queue)
        await queue.enqueue('job-1')
        await idle

        expect(dead.toArray()).toEqual(['job-1'])
        expect(exhausted).toHaveBeenCalledWith({
            item: 'job-1',
            error: expect.any(Error),
            attempt: 2,
        })

        const classifiedDead = buildQueue<string>()
        const classified = withDeadLetter(
            withRetry(
                withWorker(buildQueue<string>(), () => {
                    throw new Error('do not retry')
                }),
                { classify: () => 'fail' },
            ),
            classifiedDead,
        )
        const classifiedIdle = waitForIdle(classified)
        await classified.enqueue('job-2')
        await classifiedIdle
        expect(classifiedDead.toArray()).toEqual(['job-2'])
    })

    it('validates retry bounds', () => {
        const worker = withWorker(buildQueue<string>(), () => undefined)
        expect(() => withRetry(worker, { maxAttempts: 0 })).toThrow(
            InvalidDurableRetryOptionError,
        )
        expect(() => withRetry(worker, { maxDelayMs: 1, initialDelayMs: 2 })).toThrow(
            InvalidDurableRetryOptionError,
        )
        expect(() => withRetry(worker, { jitter: 2 })).toThrow(
            InvalidDurableRetryOptionError,
        )
    })
})
