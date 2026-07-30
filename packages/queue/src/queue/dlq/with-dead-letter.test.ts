import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import { withWorker } from '../worker/with-worker'
import {
    DeadLetterEnqueueError,
    InvalidDeadLetterOptionError,
    withDeadLetter,
} from './with-dead-letter'
import { InvalidQueueCompositionError } from '../../persist/errors'

const waitForIdle = (queue: {
    on: (event: 'worker:idle', cb: () => void) => () => void
}) =>
    new Promise<void>((resolve) => {
        const off = queue.on('worker:idle', () => {
            off()
            resolve()
        })
    })

const flush = async (n = 3) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve()
}

describe('withDeadLetter', () => {
    it('requires a worker layer', () => {
        expect(() =>
            withDeadLetter(buildQueue<number>() as never, buildQueue()),
        ).toThrow(InvalidQueueCompositionError)
    })

    it('rejects same destination as source', () => {
        const q = withWorker(buildQueue<number>(), async () => {
            /* */
        })
        expect(() => withDeadLetter(q, q as never)).toThrow(
            InvalidDeadLetterOptionError,
        )
    })

    it('rejects a second dead-letter destination', () => {
        const queue = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                /* */
            }),
            buildQueue(),
        )
        expect(() => withDeadLetter(queue, buildQueue())).toThrow(
            InvalidDeadLetterOptionError,
        )
    })

    it('on fail policy enqueues to DLQ then drops source', async () => {
        const dlq = buildQueue<number>()
        const enqueued = vi.fn()
        const dropped = vi.fn()
        const source = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw new Error('boom')
            }),
            dlq,
        )
        source.on('dlq:enqueued', enqueued)
        source.on('worker:dropped', dropped)

        const idle = waitForIdle(source)
        source.enqueue(7)
        await idle
        await flush(5)

        expect(enqueued).toHaveBeenCalled()
        expect(source.isEmpty()).toBe(true)
        expect(dlq.size()).toBe(1)
        expect(dlq.peek()).toBe(7)
    })

    it('filter false drops without DLQ enqueue', async () => {
        const dlq = buildQueue<number>()
        const source = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw new Error('boom')
            }),
            dlq,
            { filter: () => false },
        )
        const idle = waitForIdle(source)
        source.enqueue(1)
        await idle
        await flush(5)
        expect(dlq.isEmpty()).toBe(true)
        expect(source.isEmpty()).toBe(true)
    })

    it('DLQ enqueue failure loops source with backoff', async () => {
        const requeued = vi.fn()
        const dlqError = vi.fn()
        const source = withDeadLetter(
            withWorker(buildQueue<number>(), async () => {
                throw new Error('boom')
            }),
            {
                enqueue: () => {
                    throw new Error('dlq full')
                },
            },
        )
        source.on('worker:requeued', requeued)
        source.on('dlq:error', dlqError)

        source.enqueue(1)
        await flush(10)

        expect(dlqError).toHaveBeenCalledWith(
            expect.objectContaining({
                cause: expect.any(DeadLetterEnqueueError),
            }),
        )
        expect(requeued).toHaveBeenCalled()
        expect(source.stats().delayed).toBe(1)
        source.stop()
    })
})
