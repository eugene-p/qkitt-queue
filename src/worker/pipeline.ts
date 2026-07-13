import type { PipelineStepContext, StepFn, WorkerFn } from './types'

/** Named step with optional metadata available to `fn` and on failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous step arrays
export type PipelineStepObject<TIn = any, TOut = any> = {
    name: string
    fn: StepFn<TIn, TOut>
    /**
     * Opaque config for this step. Passed to `fn` via `ctx.metadata`
     * and included on {@link PipelineStepError} if the step fails.
     */
    metadata?: unknown
}

/**
 * A pipeline step: a bare function, or a named object.
 * Bare functions get a default name `step[i]`.
 *
 * Defaults use `any` so mixed step arrays type-check without casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous step arrays
export type PipelineStep<TIn = any, TOut = any> =
    | StepFn<TIn, TOut>
    | PipelineStepObject<TIn, TOut>

type NormalizedStep = {
    name: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: StepFn<any, any>
    metadata: unknown
}

const isStepObject = (step: unknown): step is PipelineStepObject =>
    typeof step === 'object' &&
    step !== null &&
    typeof (step as PipelineStepObject).fn === 'function'

const normalizeStep = (step: PipelineStep, index: number): NormalizedStep => {
    if (typeof step === 'function') {
        return {
            name: `step[${index}]`,
            fn: step,
            metadata: undefined,
        }
    }

    if (isStepObject(step)) {
        if (typeof step.name !== 'string' || step.name.length === 0) {
            throw new Error(
                `pipeline step at index ${index} requires a non-empty name`,
            )
        }
        return {
            name: step.name,
            fn: step.fn,
            metadata: step.metadata,
        }
    }

    throw new Error(
        `pipeline step at index ${index} must be a function or { name, fn, metadata? }`,
    )
}

/** Thrown when a pipeline step rejects or throws. */
export class PipelineStepError extends Error {
    override readonly name = 'PipelineStepError'
    readonly stepName: string
    readonly stepIndex: number
    readonly metadata: unknown
    override readonly cause: unknown

    constructor(
        stepName: string,
        stepIndex: number,
        cause: unknown,
        metadata?: unknown,
    ) {
        super(`Pipeline step "${stepName}" (index ${stepIndex}) failed`, {
            cause,
        })
        this.stepName = stepName
        this.stepIndex = stepIndex
        this.metadata = metadata
        this.cause = cause
    }
}

/**
 * Compose steps into a pipeline (pipe / chain):
 * output of step n is the input of step n+1.
 *
 * Accepts bare functions or `{ name, fn, metadata? }` objects (mixable).
 * Each step receives `(input, ctx)` where `ctx` has `name`, `index`, `metadata`.
 * Empty arrays throw at construction. Step failures throw {@link PipelineStepError}.
 *
 * Type parameters: pass `pipeline<In, Out>(steps)` when you need a precise
 * result type — heterogeneous step arrays cannot infer end-to-end types.
 *
 * @example
 * pipeline([
 *   async (id: string) => fetchUser(id),
 *   {
 *     name: 'save',
 *     metadata: { table: 'users' },
 *     fn: async (user, ctx) => save(user, ctx.metadata),
 *   },
 * ])
 */
export function pipeline<T, R = unknown>(
    steps: readonly PipelineStep[],
): WorkerFn<T, R> {
    if (steps.length === 0) {
        throw new Error('pipeline requires at least one step')
    }

    const normalized = steps.map(normalizeStep)

    return async (input: T): Promise<R> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let value: any = input
        for (let i = 0; i < normalized.length; i += 1) {
            const step = normalized[i]!
            const ctx: PipelineStepContext = {
                name: step.name,
                index: i,
                metadata: step.metadata,
            }
            try {
                value = await step.fn(value, ctx)
            } catch (error) {
                throw new PipelineStepError(
                    step.name,
                    i,
                    error,
                    step.metadata,
                )
            }
        }
        return value as R
    }
}
