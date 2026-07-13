import type { WorkerFn } from './types'

export type RetryOptions = {
    /**
     * How many times to retry after the first failure.
     * Total attempts = `retries + 1`.
     */
    retries: number
    /**
     * Delay in ms before each retry. Number or function of
     * (failedAttempt, error) where failedAttempt is 1-based.
     */
    delay?: number | ((failedAttempt: number, error: unknown) => number)
    /** Return false to stop retrying early. Defaults to always retry. */
    shouldRetry?: (error: unknown, failedAttempt: number) => boolean
}

/** Thrown when all retry attempts are exhausted (or `shouldRetry` returns false). */
export class RetryExhaustedError extends Error {
    override readonly name = 'RetryExhaustedError'
    readonly attempts: number
    override readonly cause: unknown

    constructor(attempts: number, cause: unknown) {
        super(`Retry exhausted after ${attempts} attempt(s)`, { cause })
        this.attempts = attempts
        this.cause = cause
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        // Avoid depending on DOM lib typings (tsconfig uses empty `types`).
        const schedule = (
            globalThis as unknown as {
                setTimeout: (fn: () => void, delay: number) => unknown
            }
        ).setTimeout
        schedule(resolve, ms)
    })

const resolveDelay = (
    delay: RetryOptions['delay'],
    failedAttempt: number,
    error: unknown,
): number => {
    if (delay === undefined) return 0
    if (typeof delay === 'function') return Math.max(0, delay(failedAttempt, error))
    return Math.max(0, delay)
}

/**
 * Wrap a worker so failed jobs are retried a fixed number of times.
 *
 * @example
 * const worker = withRetry(async (job) => callApi(job), { retries: 3, delay: 100 })
 * withWorker(queue, worker)
 */
export const withRetry = <T, R>(
    worker: WorkerFn<T, R>,
    options: RetryOptions | number,
): WorkerFn<T, R> => {
    const opts: RetryOptions =
        typeof options === 'number' ? { retries: options } : options

    const maxRetries = Math.max(0, opts.retries)
    const shouldRetry = opts.shouldRetry ?? (() => true)

    return async (item: T): Promise<R> => {
        let lastError: unknown

        for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
            try {
                return await worker(item)
            } catch (error) {
                lastError = error
                const failedAttempt = attempt
                const retriesLeft = maxRetries + 1 - attempt

                if (retriesLeft <= 0 || !shouldRetry(error, failedAttempt)) {
                    throw new RetryExhaustedError(failedAttempt, error)
                }

                const wait = resolveDelay(opts.delay, failedAttempt, error)
                if (wait > 0) {
                    await sleep(wait)
                }
            }
        }

        // Unreachable: loop always returns or throws.
        throw lastError
    }
}
