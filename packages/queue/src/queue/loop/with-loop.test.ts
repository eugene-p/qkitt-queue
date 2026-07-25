import { describe, expect, it, vi } from 'vitest'
import { InvalidQueueCompositionError } from '../../persist/errors'
import { buildQueue } from '../core/queue'
import { withWorker } from '../worker/with-worker'
import { QKITT_QUEUE_KEY } from './hop-meta.util'
import {
    getLoopHops,
    InvalidLoopOptionError,
    LoopEnqueueError,
    withLoop,
} from './with-loop'

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

const named = <T>(name: string) => buildQueue<T>({ name })

describe('withLoop', () => {
    it('throws when source has no worker layer', () => {
        expect(() =>
            withLoop(
                // @ts-expect-error bare queue lacks worker controls
                named<number>('jobs'),
            ),
        ).toThrow(InvalidQueueCompositionError)
    })

    it('throws when queue has no name', () => {
        const q = withWorker(buildQueue<{ id: string }>(), async () => {
            throw new Error('x')
        })
        expect(() => withLoop(q)).toThrow(InvalidLoopOptionError)
    })

    it('increments __qkittQueue.loop[name].hops on each failure', async () => {
        type Job = { id: string; __qkittQueue?: unknown }
        const run = vi.fn(async (job: Job) => {
            const hops = getLoopHops(job, 'jobs')
            if (hops === undefined || hops < 2) {
                throw new Error(`fail-${hops ?? 0}`)
            }
        })

        const queue = withLoop(withWorker(named<Job>('jobs'), run))

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(6)

        expect(run.mock.calls.length).toBeGreaterThanOrEqual(3)
        const last = run.mock.calls.at(-1)?.[0]
        expect(getLoopHops(last, 'jobs')).toBe(2)
        expect(last).toMatchObject({
            id: 'a',
            [QKITT_QUEUE_KEY]: { loop: { jobs: { hops: 2 } } },
        })
        expect(queue.isEmpty()).toBe(true)
    })

    it('preserves user fields and sibling library tags', async () => {
        type Job = {
            id: string
            note?: string
            __qkittQueue?: {
                loop?: Record<string, { hops?: number; note?: string }>
                otherTag?: number
            }
        }

        let resolved: Job | undefined
        const queue = withLoop(
            withWorker(named<Job>('jobs'), async (job) => {
                if (getLoopHops(job, 'jobs') === undefined) {
                    throw new Error('fail')
                }
                resolved = job
            }),
        )

        const idle = waitForIdle(queue)
        queue.enqueue({
            id: 'a',
            note: 'user',
            [QKITT_QUEUE_KEY]: {
                otherTag: 7,
                loop: { jobs: { note: 'keep' }, billing: { hops: 3 } },
            },
        })
        await idle
        await flush(4)

        expect(resolved).toEqual({
            id: 'a',
            note: 'user',
            [QKITT_QUEUE_KEY]: {
                otherTag: 7,
                loop: {
                    jobs: { note: 'keep', hops: 1 },
                    billing: { hops: 3 },
                },
            },
        })
    })

    it('wraps primitives with value + __qkittQueue', async () => {
        let saw: unknown
        const queue = withLoop(
            withWorker(named<unknown>('n'), async (item) => {
                if (typeof item === 'number') {
                    throw new Error('fail')
                }
                saw = item
            }),
        )

        const idle = waitForIdle(queue)
        queue.enqueue(9)
        await idle
        await flush(4)

        expect(saw).toEqual({
            value: 9,
            [QKITT_QUEUE_KEY]: { loop: { n: { hops: 1 } } },
        })
    })

    it('wraps Date instead of spreading', async () => {
        let saw: unknown
        const when = new Date('2020-01-01T00:00:00.000Z')
        const queue = withLoop(
            withWorker(named<unknown>('jobs'), async (item) => {
                if (item instanceof Date) {
                    throw new Error('fail')
                }
                saw = item
            }),
        )

        const idle = waitForIdle(queue)
        queue.enqueue(when)
        await idle
        await flush(4)

        expect(saw).toEqual({
            value: when,
            [QKITT_QUEUE_KEY]: { loop: { jobs: { hops: 1 } } },
        })
    })

    it('uses trimmed buildQueue name for hop meta keys', async () => {
        let resolved: unknown
        const queue = withLoop(
            withWorker(buildQueue<{ id: string }>({ name: '  jobs  ' }), async (job) => {
                if (getLoopHops(job, 'jobs') === undefined) {
                    throw new Error('fail')
                }
                resolved = job
            }),
        )

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(4)

        expect(getLoopHops(resolved, 'jobs')).toBe(1)
    })

    it('applies user map then stamps hops', async () => {
        const received: unknown[] = []
        let pass = 0
        const queue = withLoop(
            withWorker(named<{ id: string }>('jobs'), async (item) => {
                received.push(item)
                pass += 1
                if (pass === 1) throw new Error('fail')
            }),
            {
                map: (item, error, ctx) => ({
                    id: item.id,
                    reason: error instanceof Error ? error.message : 'x',
                    hopsSeen: ctx.hops,
                }),
            },
        )

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(4)

        expect(received[1]).toEqual({
            id: 'a',
            reason: 'fail',
            hopsSeen: 1,
            [QKITT_QUEUE_KEY]: { loop: { jobs: { hops: 1 } } },
        })
        expect(getLoopHops(received[1], 'jobs')).toBe(1)
    })

    it('emits loop:meta-override when map changes __qkittQueue, then re-stamps', async () => {
        const override = vi.fn()
        let saw: unknown
        const queue = withLoop(
            withWorker(named<{ id: string }>('jobs'), async (job) => {
                if (getLoopHops(job, 'jobs') === undefined) {
                    throw new Error('fail')
                }
                saw = job
            }),
            {
                map: (item) => ({
                    ...item,
                    [QKITT_QUEUE_KEY]: { loop: { jobs: { hops: 99 } } },
                }),
            },
        )
        queue.on('loop:meta-override', override)

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(4)

        expect(override).toHaveBeenCalledOnce()
        expect(override.mock.calls[0]?.[0]).toMatchObject({
            name: 'jobs',
            attempted: { loop: { jobs: { hops: 99 } } },
            applied: { hops: 1 },
        })
        expect(getLoopHops(saw, 'jobs')).toBe(1)
    })

    it('does not emit meta-override when map returns original unchanged bag', async () => {
        const override = vi.fn()
        const queue = withLoop(
            withWorker(named<{ id: string }>('jobs'), async (job) => {
                if (getLoopHops(job, 'jobs') === undefined) {
                    throw new Error('fail')
                }
            }),
            {
                map: (item) => item,
            },
        )
        queue.on('loop:meta-override', override)

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(4)

        expect(override).not.toHaveBeenCalled()
    })

    it('skips re-enqueue when filter returns false', async () => {
        const run = vi.fn(async () => {
            throw new Error('fail')
        })
        const queue = withLoop(withWorker(named<number>('n'), run), {
            filter: () => false,
        })

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle
        await flush(2)

        expect(run).toHaveBeenCalledOnce()
        expect(queue.isEmpty()).toBe(true)
    })

    it('emits loop:error when map throws', async () => {
        const mapErr = new Error('map-fail')
        const queue = withLoop(
            withWorker(named<number>('jobs'), async () => {
                throw new Error('worker')
            }),
            {
                map: () => {
                    throw mapErr
                },
            },
        )

        const onError = vi.fn()
        queue.on('loop:error', onError)

        const idle = waitForIdle(queue)
        queue.enqueue(1)
        await idle

        const cause = onError.mock.calls[0]?.[0].cause as LoopEnqueueError
        expect(cause).toBeInstanceOf(LoopEnqueueError)
        expect(cause.cause).toBe(mapErr)
    })

    it('emits loop:enqueued on successful re-enqueue', async () => {
        const enqueued = vi.fn()
        const queue = withLoop(
            withWorker(named<{ id: string }>('jobs'), async (job) => {
                if (getLoopHops(job, 'jobs') === undefined) {
                    throw new Error('fail')
                }
            }),
        )
        queue.on('loop:enqueued', enqueued)

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(4)

        expect(enqueued).toHaveBeenCalledOnce()
        expect(enqueued.mock.calls[0]?.[0].loopItem).toMatchObject({
            id: 'a',
            [QKITT_QUEUE_KEY]: { loop: { jobs: { hops: 1 } } },
        })
    })

    it('still emits worker:failed', async () => {
        const error = new Error('boom')
        const failed = vi.fn()
        const queue = withLoop(
            withWorker(named<{ id: string }>('jobs'), async () => {
                throw error
            }),
            { filter: () => false },
        )
        queue.on('worker:failed', failed)

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle

        expect(failed).toHaveBeenCalledWith({ item: { id: 'a' }, error })
    })

    it('reads name through worker and loop decorator layers', async () => {
        let sawName: string | undefined
        const queue = withLoop(
            withWorker(named<{ id: string }>('orders'), async (job) => {
                if (getLoopHops(job, 'orders') === undefined) {
                    throw new Error('fail')
                }
            }),
            {
                map: (_item, _error, ctx) => {
                    sawName = ctx.name
                    return _item
                },
            },
        )

        const idle = waitForIdle(queue)
        queue.enqueue({ id: 'a' })
        await idle
        await flush(4)

        expect(sawName).toBe('orders')
    })
})
