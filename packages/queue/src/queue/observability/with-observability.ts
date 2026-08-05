import type { EventCallback, EventMap } from '../../events'
import { decorateQueue } from '../core/forward.util'
import { createMinHeap, type MinHeap } from '../core/min-heap.util'
import type { Queue, QueueEvents, QueueStats } from '../core/queue'
import { isJob } from '../jobs/job'

export type TimingMetrics = {
    count: number
    totalMs: number
    averageMs: number
}

/** A cheap snapshot; counters begin when `withObservability` is composed. */
export type QueueMetrics = {
    depth: QueueStats
    /** Age of the oldest opt-in `Job`, if the queue currently contains one. */
    oldestAgeMs?: number
    completed: number
    failed: number
    retried: number
    deadLettered: number
    handler: TimingMetrics
    store: TimingMetrics
}

export type QueueTraceEvent<T> = {
    name: string
    item?: T
    durationMs?: number
    error?: unknown
}

export type WithObservabilityOptions<T> = {
    /** Receives a coalesced snapshot after observable queue lifecycle events. */
    onMetrics?: (metrics: QueueMetrics) => void
    /** Lightweight integration point for tracing adapters. */
    onTrace?: (event: QueueTraceEvent<T>) => void
}

export type QueueWithObservability<
    T,
    TEvents extends EventMap = QueueEvents<T>,
> = Queue<T, TEvents> & {
    metrics: () => QueueMetrics
}

type QueueItem<TQueue> = TQueue extends Queue<infer T, any> ? T : never

type JobAgeEntry = {
    item: object
    enqueuedAt: number
}

const average = (count: number, totalMs: number): number =>
    count === 0 ? 0 : totalMs / count

/**
 * Add pull metrics and push hooks without coupling the queue to a metrics SDK.
 * Compose anywhere: worker/retry/DLQ events are emitted through the inner queue
 * and remain visible to this observer.
 */
export const withObservability = <TQueue extends Queue<any, any>>(
    queue: TQueue,
    options: WithObservabilityOptions<QueueItem<TQueue>> = {},
): TQueue & { metrics: () => QueueMetrics } => {
    let completed = 0
    let failed = 0
    let retried = 0
    let deadLettered = 0
    let handlerCount = 0
    let handlerTotalMs = 0
    let storeCount = 0
    let storeTotalMs = 0
    const jobTimes = new Map<object, number>()
    const jobAges: MinHeap<JobAgeEntry> = createMinHeap(
        (entry) => entry.enqueuedAt,
    )
    let jobIndexReady = false

    const indexJob = (item: unknown): void => {
        if (!isJob(item)) return
        const objectItem = item as object
        jobTimes.set(objectItem, item.enqueuedAt)
        jobAges.push({ item: objectItem, enqueuedAt: item.enqueuedAt })
    }

    const removeJob = (item: unknown): void => {
        if (item !== null && typeof item === 'object') {
            jobTimes.delete(item)
        }
    }

    const rebuildJobIndex = (): void => {
        jobTimes.clear()
        jobAges.clear()
        const jobs = queue.listJobs({ limit: Number.MAX_SAFE_INTEGER }).items
        for (const entry of jobs) indexJob(entry.item)
        jobIndexReady = true
    }

    const oldestJobAge = (): number | undefined => {
        if (!jobIndexReady) rebuildJobIndex()
        for (;;) {
            const head = jobAges.peek()
            if (head === undefined) return undefined
            if (jobTimes.get(head.item) === head.enqueuedAt) {
                return Math.max(0, Date.now() - head.enqueuedAt)
            }
            jobAges.pop()
        }
    }

    const metrics = (): QueueMetrics => {
        const oldestAgeMs = oldestJobAge()
        return {
            depth: queue.stats(),
            ...(oldestAgeMs === undefined ? {} : { oldestAgeMs }),
            completed,
            failed,
            retried,
            deadLettered,
            handler: {
                count: handlerCount,
                totalMs: handlerTotalMs,
                averageMs: average(handlerCount, handlerTotalMs),
            },
            store: {
                count: storeCount,
                totalMs: storeTotalMs,
                averageMs: average(storeCount, storeTotalMs),
            },
        }
    }

    const report = (): void => {
        if (options.onMetrics === undefined) return
        try {
            options.onMetrics(metrics())
        } catch {
            // Observability must never interfere with delivery.
        }
    }
    let reportScheduled = false
    const scheduleReport = (): void => {
        if (options.onMetrics === undefined || reportScheduled) return
        reportScheduled = true
        void Promise.resolve().then(() => {
            reportScheduled = false
            report()
        })
    }
    const trace = (event: QueueTraceEvent<QueueItem<TQueue>>): void => {
        try {
            options.onTrace?.(event)
        } catch {
            // Observability must never interfere with delivery.
        }
    }
    const on = queue.on as (
        name: string,
        callback: EventCallback<unknown>,
    ) => () => void
    const watch = (name: string, callback?: (data: any) => void): void => {
        on(name, (data) => {
            callback?.(data)
            scheduleReport()
        })
    }

    watch('queue:enqueued', (data) => indexJob(data.item))
    watch('queue:dequeued', (data) => removeJob(data.item))
    watch('queue:cleared', () => {
        jobTimes.clear()
        jobAges.clear()
        jobIndexReady = true
    })
    watch('persist:loaded', () => {
        // Hydrate coalesces its enqueue event to the head item, so rebuild the
        // index once on the next metrics read instead of scanning every event.
        jobIndexReady = false
    })
    watch('worker:started', (data) => trace({ name: 'worker:started', item: data.item }))
    watch('worker:completed', (data) => {
        completed += 1
        removeJob(data.item)
        trace({ name: 'worker:completed', item: data.item })
    })
    watch('worker:failed', (data) => {
        failed += 1
        trace({ name: 'worker:failed', item: data.item, error: data.error })
    })
    watch('worker:handled', (data) => {
        handlerCount += 1
        handlerTotalMs += data.durationMs
        trace({
            name: `worker:${data.outcome}`,
            item: data.item,
            durationMs: data.durationMs,
        })
    })
    watch('worker:dropped', (data) => removeJob(data.item))
    watch('dlq:enqueued', (data) => removeJob(data.item))
    watch('retry:scheduled', () => {
        retried += 1
    })
    watch('dlq:enqueued', () => {
        deadLettered += 1
    })
    watch('persist:operation', (data) => {
        storeCount += 1
        storeTotalMs += data.durationMs
        trace({ name: `store:${data.operation}`, durationMs: data.durationMs })
    })

    const ack = async (
        lease: Parameters<TQueue['ack']>[0],
    ): Promise<void> => {
        await queue.ack(lease)
        removeJob(lease.item)
    }

    const replaceAll = async (
        items: Parameters<TQueue['replaceAll']>[0],
    ): Promise<void> => {
        await queue.replaceAll(items)
        jobIndexReady = false
    }

    const cancelJob = async (
        id: Parameters<TQueue['cancelJob']>[0],
    ): Promise<boolean> => {
        const cancelled = await queue.cancelJob(id)
        if (cancelled) jobIndexReady = false
        return cancelled
    }

    const rescheduleJob = async (
        id: Parameters<TQueue['rescheduleJob']>[0],
        delayMs: Parameters<TQueue['rescheduleJob']>[1],
    ): Promise<boolean> => {
        const rescheduled = await queue.rescheduleJob(id, delayMs)
        if (rescheduled) jobIndexReady = false
        return rescheduled
    }

    const promoteJob = async (
        id: Parameters<TQueue['promoteJob']>[0],
    ): Promise<boolean> => {
        const promoted = await queue.promoteJob(id)
        if (promoted) jobIndexReady = false
        return promoted
    }

    return decorateQueue(queue, {
        metrics,
        ack,
        replaceAll,
        cancelJob,
        rescheduleJob,
        promoteJob,
    }) as TQueue & {
        metrics: () => QueueMetrics
    }
}
