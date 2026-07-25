import { describe, expect, it, vi } from 'vitest'
import { InvalidQueueCompositionError } from '../../persist/errors'
import { buildQueue, QueueFullError } from '../core/queue'
import { withWorker } from '../worker/with-worker'
import {
    DeadLetterEnqueueError,
    InvalidDeadLetterOptionError,
    withDeadLetter,
    withDlq,
} from './with-dead-letter'

const waitForIdle = (queue: {
    on: (event: 'worker:idle', cb: () => void) => () => void
}) =>
    new Promise<void>((resolve) => {
        const off = queue.on('worker:idle', () => {
            off()
            resolve()
        })
    })

describe('withDeadLetter', () => {
    it('is the same function as withDlq', () => {
        expect(withDlq).toBe(withDeadLetter)
    })

    it('forwards worker failures to a distinct destination', async () => {
        const error = new Error('boom')
        const dlq = buildQueue<number>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw error
            }),
            dlq,
        )

        const enqueued = vi.fn()
        queue.on('dlq:enqueued', enqueued)

        const idle = waitForIdle(queue)
        queue.enqueue(42)
        await idle

        expect(dlq.toArray()).toEqual([42])
        expect(enqueued).toHaveBeenCalledWith({
            item: 42,
            error,
            deadLetterItem: 42,
        })
    })

    it('applies map before enqueue', async () => {
        const error = new Error('boom')
        const dlq = buildQueue<{ item: number; reason: string }>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw error
            }),
            dlq,
            {
                map: (item, err) => ({
                    item,
                    reason: err instanceof Error ? err.message : 'unknown',
                }),
            },
        )

        const idle = waitForIdle(queue)
        queue.enqueue(7)
        await idle

        expect(dlq.toArray()).toEqual([{ item: 7, reason: 'boom' }])
    })

    it('skips enqueue when filter returns false', async () => {
        const dlq = buildQueue<number>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw new Error('boom')
            }),
            dlq,
            { filter: (item) => item > 10 },
        )

        const idle = waitForIdle(queue)
        queue.enqueue(3)
        await idle

        expect(dlq.isEmpty()).toBe(true)
    })

    it('emits dlq:error when filter throws', async () => {
        const workerErr = new Error('worker')
        const filterErr = new Error('filter-fail')
        const dlq = buildQueue<number>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw workerErr
            }),
            dlq,
            {
                filter: () => {
                    throw filterErr
                },
            },
        )

        const onError = vi.fn()
        queue.on('dlq:error', onError)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        expect(dlq.isEmpty()).toBe(true)
        const cause = onError.mock.calls[0]?.[0].cause as DeadLetterEnqueueError
        expect(cause).toBeInstanceOf(DeadLetterEnqueueError)
        expect(cause.cause).toBe(filterErr)
    })

    it('throws when source has no worker layer', () => {
        expect(() =>
            withDeadLetter(
                // @ts-expect-error bare queue lacks worker controls
                buildQueue<number>(),
                buildQueue<number>(),
            ),
        ).toThrow(InvalidQueueCompositionError)
    })

    it('throws when destination is the same queue reference', () => {
        const q = withWorker(buildQueue<{ id: string }>(), async () => {
            throw new Error('x')
        })
        expect(() => withDeadLetter(q, q)).toThrow(InvalidDeadLetterOptionError)
        expect(() => withDeadLetter(q, q, { map: (item) => item })).toThrow(
            InvalidDeadLetterOptionError,
        )
    })

    it('emits dlq:error with DeadLetterEnqueueError when destination is full', async () => {
        const error = new Error('boom')
        const dlq = buildQueue<number>({ maxSize: 1 })
        dlq.enqueue(0)

        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw error
            }),
            dlq,
        )

        const onError = vi.fn()
        queue.on('dlq:error', onError)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        expect(onError).toHaveBeenCalledOnce()
        const payload = onError.mock.calls[0]?.[0] as {
            item: number
            error: unknown
            cause: DeadLetterEnqueueError
        }
        expect(payload.item).toBe(1)
        expect(payload.error).toBe(error)
        expect(payload.cause).toBeInstanceOf(DeadLetterEnqueueError)
        expect(payload.cause.cause).toBeInstanceOf(QueueFullError)
        expect(dlq.toArray()).toEqual([0])
    })

    it('emits dlq:error when map throws', async () => {
        const workerErr = new Error('worker')
        const mapErr = new Error('map-fail')
        const dlq = buildQueue<number>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw workerErr
            }),
            dlq,
            {
                map: () => {
                    throw mapErr
                },
            },
        )

        const onError = vi.fn()
        queue.on('dlq:error', onError)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        expect(dlq.isEmpty()).toBe(true)
        const cause = onError.mock.calls[0]?.[0].cause as DeadLetterEnqueueError
        expect(cause).toBeInstanceOf(DeadLetterEnqueueError)
        expect(cause.cause).toBe(mapErr)
    })

    it('still emits worker:failed', async () => {
        const error = new Error('boom')
        const dlq = buildQueue<number>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw error
            }),
            dlq,
        )

        const failed = vi.fn()
        queue.on('worker:failed', failed)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        expect(failed).toHaveBeenCalledWith({ item: 1, error })
        expect(dlq.toArray()).toEqual([1])
    })

    it('preserves worker controls', () => {
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async (n) => n, {
                autoStart: false,
            }),
            buildQueue<number>(),
        )
        expect(queue.isRunning()).toBe(false)
        queue.start()
        expect(queue.isRunning()).toBe(true)
        queue.stop()
        expect(queue.isRunning()).toBe(false)
    })

    it('forwards sync worker throws', async () => {
        const error = new Error('sync')
        const dlq = buildQueue<number>()
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), () => {
                throw error
            }),
            dlq,
        )

        const idle = waitForIdle(queue)
        queue.enqueue(5)
        await idle

        expect(dlq.toArray()).toEqual([5])
    })
})
