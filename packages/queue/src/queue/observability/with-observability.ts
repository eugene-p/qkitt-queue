import type { EventCallback, EventMap } from '../../events'
import { decorateQueue } from '../core/forward.util'
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
    /** Receives snapshots after each observable queue lifecycle event. */
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

    const metrics = (): QueueMetrics => {
        let oldestEnqueuedAt: number | undefined
        let cursor: number | undefined
        do {
            const page = queue.listJobs({ cursor, limit: 100 })
            for (const entry of page.items) {
                if (isJob(entry.item)) {
                    oldestEnqueuedAt =
                        oldestEnqueuedAt === undefined
                            ? entry.item.enqueuedAt
                            : Math.min(oldestEnqueuedAt, entry.item.enqueuedAt)
                }
            }
            cursor = page.nextCursor
        } while (cursor !== undefined)
        return {
            depth: queue.stats(),
            ...(oldestEnqueuedAt === undefined
                ? {}
                : { oldestAgeMs: Math.max(0, Date.now() - oldestEnqueuedAt) }),
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
        try {
            options.onMetrics?.(metrics())
        } catch {
            // Observability must never interfere with delivery.
        }
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
            report()
        })
    }

    watch('queue:enqueued')
    watch('queue:dequeued')
    watch('queue:cleared')
    watch('persist:loaded')
    watch('worker:started', (data) => trace({ name: 'worker:started', item: data.item }))
    watch('worker:completed', (data) => {
        completed += 1
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

    return decorateQueue(queue, { metrics }) as TQueue & {
        metrics: () => QueueMetrics
    }
}
