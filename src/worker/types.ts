/** Sync or async unit of work over a single job/item. */
export type WorkerFn<T, R = unknown> = (item: T) => R | Promise<R>

/** Alias used by pipelines — same shape as {@link WorkerFn}. */
export type StepFn<TIn, TOut = unknown> = WorkerFn<TIn, TOut>
