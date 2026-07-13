/** Sync or async unit of work over a single job/item. */
export type WorkerFn<T, R = unknown> = (item: T) => R | Promise<R>

/** Runtime info passed as the second argument to each pipeline step. */
export type PipelineStepContext = {
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
