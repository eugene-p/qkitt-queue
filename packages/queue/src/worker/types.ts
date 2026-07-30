/// <reference lib="dom" />

/** Per-delivery information supplied by `withWorker`. */
export type WorkerContext = {
    /** Application job id when the item is a `Job`, otherwise undefined. */
    jobId: string | undefined
    /** 1-based durable delivery attempt. */
    attempt: number
    /** Epoch lease deadline, or undefined when the queue has no lease TTL. */
    leaseDeadline: number | undefined
    /** Opaque tracing/correlation context supplied by the job or worker option. */
    traceContext: unknown
    /** Aborted when the handler timeout or its lease deadline elapses. */
    signal: AbortSignal
}

/** Standard cancellation signal supplied for every `withWorker` delivery. */
export type WorkerAbortSignal = AbortSignal

/** Sync or async unit of work over a single job/item. */
export type WorkerFn<T, R = unknown> = (
    item: T,
    context?: WorkerContext,
) => R | Promise<R>

/** Runtime info passed as the second argument to each pipeline step. */
export type PipelineStepContext = WorkerContext & {
    name: string
    index: number
    metadata: unknown
}

/**
 * Pipeline step function. Second arg is {@link PipelineStepContext}
 * (name, index, metadata). One-arg functions still work.
 */
export type StepFn<TIn, TOut = unknown> = (
    item: TIn,
    ctx: PipelineStepContext,
) => TOut | Promise<TOut>
