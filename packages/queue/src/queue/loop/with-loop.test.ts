import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import { withWorker } from '../worker/with-worker'
import { InvalidLoopOptionError, withLoop, getLoopHops } from './with-loop'
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

const flush = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve()
}

describe('withLoop', () => {
    it('requires worker and name', () => {
        expect(() =>
            withLoop(
                withWorker(buildQueue<number>(), async () => {
                    /* */
                }),
            ),
        ).toThrow(InvalidLoopOptionError)

        expect(() => withLoop(buildQueue({ name: 'x' }) as never)).toThrow(
            InvalidQueueCompositionError,
        )
    })

    it('requeues failed items with hop meta', async () => {
        let attempts = 0
        const requeued = vi.fn()
        const queue = withLoop(
            withWorker(
                buildQueue<Record<string, unknown>>({ name: 'jobs' }),
                async (item) => {
                    attempts += 1
                    if (attempts < 2) throw new Error('retry')
                    return item
                },
            ),
        )
        queue.on('worker:requeued', requeued)

        const idle = waitForIdle(queue)
        queue.enqueue({ n: 1 })
        await idle
        await flush(10)

        expect(attempts).toBe(2)
        expect(requeued).toHaveBeenCalled()
        expect(queue.isEmpty()).toBe(true)
    })

    it('filter false settles via fail path (drop when no DLQ)', async () => {
        const dropped = vi.fn()
        const queue = withLoop(
            withWorker(
                buildQueue<{ n: number }>({ name: 'jobs' }),
                async () => {
                    throw new Error('fail')
                },
            ),
            { filter: () => false },
        )
        queue.on('worker:dropped', dropped)
        const idle = waitForIdle(queue)
        queue.enqueue({ n: 1 })
        await idle
        await flush(5)
        expect(queue.isEmpty()).toBe(true)
        expect(dropped).toHaveBeenCalled()
    })

    it('conflicts with explicit onFailure fail', () => {
        expect(() =>
            withLoop(
                withWorker(
                    buildQueue({ name: 'jobs' }),
                    async () => {
                        /* */
                    },
                    { onFailure: 'fail' },
                ),
            ),
        ).toThrow()
    })

    it('getLoopHops reads stamped hops', () => {
        const item = {
            __qkittQueue: { loop: { jobs: { hops: 3 } } },
        }
        expect(getLoopHops(item, 'jobs')).toBe(3)
    })
})
