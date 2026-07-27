import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../core/queue'
import { withDeadLetter } from '../dlq/with-dead-letter'
import { getLoopHops, withLoop } from '../loop/with-loop'
import { withWorker } from './with-worker'

const waitForIdle = (queue: {
    on: (event: 'worker:idle', cb: () => void) => () => void
}) =>
    new Promise<void>((resolve) => {
        const off = queue.on('worker:idle', () => {
            off()
            resolve()
        })
    })

const flush = async (n = 20) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve()
}

describe('withLoop + withDeadLetter', () => {
    it('falls through to DLQ when loop filter returns false', async () => {
        const failed = buildQueue<{ id: string }>({ name: 'failed' })
        const MAX = 2
        const dlqEnqueued = vi.fn()
        const dropped = vi.fn()

        const queue = withDeadLetter(
            withLoop(
                withWorker(
                    buildQueue<{ id: string }>({ name: 'jobs' }),
                    async () => {
                        throw new Error('fail')
                    },
                    { concurrency: 1 },
                ),
                {
                    filter: (_item, _error, ctx) =>
                        (ctx.previousHops ?? 0) < MAX,
                },
            ),
            failed,
            {
                filter: (item) => (getLoopHops(item, 'jobs') ?? 0) >= MAX,
            },
        )

        queue.on('dlq:enqueued', dlqEnqueued)
        queue.on('worker:dropped', dropped)

        const idle = waitForIdle(queue)
        await queue.enqueue({ id: 'a' })
        await idle
        await flush()

        expect(dropped).not.toHaveBeenCalled()
        expect(dlqEnqueued).toHaveBeenCalledTimes(1)
        expect(failed.size()).toBe(1)
        expect(getLoopHops(failed.peek(), 'jobs')).toBe(MAX)
    })
})
