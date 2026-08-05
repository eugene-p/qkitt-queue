import { describe, expect, it, vi } from 'vitest'
import { createMemoryRowStore } from '../persist/stores/memory'
import { createJob } from './jobs/job'
import { buildQueue } from './core/queue'
import { withObservability } from './observability/with-observability'
import { withWorker } from './worker/with-worker'
import { whenIdle } from './worker/when-idle'

describe('job operations', () => {
    it('pages states and administers ready and delayed application jobs', async () => {
        const store = createMemoryRowStore<ReturnType<typeof createJob<string>>>()
        const queue = buildQueue({ store })
        const first = createJob('first', { id: 'first', enqueuedAt: 10 })
        const second = createJob('second', { id: 'second', enqueuedAt: 20 })
        const third = createJob('third', { id: 'third', enqueuedAt: 30 })

        await queue.enqueue(first)
        await queue.enqueue(third)
        await queue.enqueue(second, { delayMs: 60_000 })

        const firstPage = queue.listJobs({ state: 'ready', limit: 1 })
        expect(firstPage).toEqual({
            items: [
                expect.objectContaining({ id: 'first', state: 'ready', attempt: 1 }),
            ],
            nextCursor: 1,
        })
        expect(queue.listJobs({ state: 'ready', cursor: firstPage.nextCursor })).toEqual({
            items: [expect.objectContaining({ id: 'third', state: 'ready' })],
        })
        expect(queue.listJobs({ state: 'delayed' }).items).toEqual([
            expect.objectContaining({ id: 'second', state: 'delayed' }),
        ])
        expect(await queue.rescheduleJob('first', 60_000)).toBe(true)
        expect(await queue.promoteJob('second')).toBe(true)
        expect(queue.getJob('second')).toEqual(
            expect.objectContaining({ state: 'ready' }),
        )
        expect(await queue.cancelJob('first')).toBe(true)
        expect(queue.getJob('first')).toBeUndefined()
        expect(store.rows).toHaveLength(2)
    })

    it('replays enqueue-first and does not cancel an active lease', async () => {
        const source = buildQueue<ReturnType<typeof createJob<string>>>()
        const target = buildQueue<ReturnType<typeof createJob<string>>>()
        const job = createJob('retry me', { id: 'dead-1' })
        await source.enqueue(job)

        const lease = await source.claim()
        expect(lease).toBeDefined()
        expect(await source.cancelJob('dead-1')).toBe(false)
        await source.release(lease!)

        expect(await source.replayJob('dead-1', target)).toBe(true)
        expect(source.getJob('dead-1')).toBeUndefined()
        expect(target.getJob('dead-1')).toEqual(
            expect.objectContaining({ state: 'ready' }),
        )
    })

    it('pages a large job queue without changing its ordering', async () => {
        const queue = buildQueue<ReturnType<typeof createJob<number>>>()
        for (let i = 0; i < 2_000; i += 1) {
            await queue.enqueue(createJob(i, { id: `job-${i}`, enqueuedAt: i }))
        }

        const ids: string[] = []
        let cursor: number | undefined
        do {
            const page = queue.listJobs({ cursor, limit: 37 })
            ids.push(...page.items.map((job) => job.id))
            cursor = page.nextCursor
        } while (cursor !== undefined)

        expect(ids).toEqual(Array.from({ length: 2_000 }, (_, i) => `job-${i}`))
    })
})

describe('withObservability', () => {
    it('collects delivery and durable-store timings without affecting work', async () => {
        const reports = vi.fn()
        const queue = withObservability(
            withWorker(
                buildQueue({ store: createMemoryRowStore<ReturnType<typeof createJob<number>>>() }),
                (job) => job.payload + 1,
            ),
            { onMetrics: reports },
        )

        await queue.enqueue(createJob(1, { id: 'metrics-1' }))
        await whenIdle(queue)

        expect(queue.metrics()).toMatchObject({
            depth: { available: 0, delayed: 0, leased: 0 },
            completed: 1,
            failed: 0,
            handler: { count: 1 },
        })
        expect(queue.metrics().store.count).toBeGreaterThan(0)
        expect(reports).toHaveBeenCalled()
    })

    it('coalesces metric reports for a burst without changing the snapshot', async () => {
        const reports = vi.fn()
        const queue = withObservability(buildQueue<ReturnType<typeof createJob<number>>>(), {
            onMetrics: reports,
        })

        const first = queue.enqueue(createJob(1, { id: 'first', enqueuedAt: 10 }))
        const second = queue.enqueue(createJob(2, { id: 'second', enqueuedAt: 20 }))
        await Promise.all([first, second])

        await Promise.resolve()

        expect(reports).toHaveBeenCalledTimes(1)
        expect(reports).toHaveBeenCalledWith(
            expect.objectContaining({
                depth: { available: 2, delayed: 0, leased: 0 },
                oldestAgeMs: expect.any(Number),
            }),
        )
    })

    it('computes metrics for a large job queue', async () => {
        const queue = withObservability(buildQueue<ReturnType<typeof createJob<number>>>());
        for (let i = 0; i < 1_000; i += 1) {
            await queue.enqueue(createJob(i, { id: `metrics-${i}`, enqueuedAt: i }))
        }

        expect(queue.metrics()).toMatchObject({
            depth: { available: 1_000, delayed: 0, leased: 0 },
            oldestAgeMs: expect.any(Number),
        })
    })
})
