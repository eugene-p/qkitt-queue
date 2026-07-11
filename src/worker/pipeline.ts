import type { StepFn, WorkerFn } from './types'

/**
 * Compose steps into a pipeline (pipe / chain):
 * output of step n is the input of step n+1.
 *
 * Common name: **pipeline** (also pipe, chain).
 *
 * @example
 * const worker = pipeline(
 *   async (id: string) => fetchUser(id),
 *   async (user) => enrich(user),
 *   async (enriched) => save(enriched),
 * )
 * withWorker(queue, worker)
 */
export function pipeline<A, B>(s1: StepFn<A, B>): WorkerFn<A, B>
export function pipeline<A, B, C>(
    s1: StepFn<A, B>,
    s2: StepFn<B, C>,
): WorkerFn<A, C>
export function pipeline<A, B, C, D>(
    s1: StepFn<A, B>,
    s2: StepFn<B, C>,
    s3: StepFn<C, D>,
): WorkerFn<A, D>
export function pipeline<A, B, C, D, E>(
    s1: StepFn<A, B>,
    s2: StepFn<B, C>,
    s3: StepFn<C, D>,
    s4: StepFn<D, E>,
): WorkerFn<A, E>
export function pipeline<A, B, C, D, E, F>(
    s1: StepFn<A, B>,
    s2: StepFn<B, C>,
    s3: StepFn<C, D>,
    s4: StepFn<D, E>,
    s5: StepFn<E, F>,
): WorkerFn<A, F>
export function pipeline<A, B, C, D, E, F, G>(
    s1: StepFn<A, B>,
    s2: StepFn<B, C>,
    s3: StepFn<C, D>,
    s4: StepFn<D, E>,
    s5: StepFn<E, F>,
    s6: StepFn<F, G>,
): WorkerFn<A, G>
export function pipeline(
    ...steps: StepFn<unknown, unknown>[]
): WorkerFn<unknown, unknown> {
    if (steps.length === 0) {
        throw new Error('pipeline requires at least one step')
    }

    return async (input: unknown): Promise<unknown> => {
        let value: unknown = input
        for (const step of steps) {
            value = await step(value)
        }
        return value
    }
}
