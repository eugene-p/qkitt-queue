import {
    isIntegerInRange,
    isNonNegativeFinite,
} from '../util/number.util'
import type { WorkerFn } from './types'

export type RetryOptions = {
    /**
     * Total attempts = `retries + 1`.
     * How many times to retry after the first failure.
     * Must be a safe integer ≥ 0.
     */
    retries: number
    /**
     * Delay in ms before each retry. Number or function of
     * (failedAttempt, error) where failedAttempt is 1-based.
     * Must resolve to a finite number ≥ 0.
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
    const ms = typeof delay === 'function' ? delay(failedAttempt, error) : delay
    if (!isNonNegativeFinite(ms)) {
        throw new Error('retry delay must be a finite number >= 0')
    }
    return ms
}

/**
 * Wrap a worker function so failed jobs are retried a fixed number of times.
 * Returns a {@link WorkerFn} for {@link withWorker} (does not wrap a queue).
 *
 * @example
 * const run = retryWorker(async (job) => callApi(job), { retries: 3, delay: 100 })
 * withWorker(queue, run)
 */
export const retryWorker = <T, R>(
    worker: WorkerFn<T, R>,
    options: RetryOptions | number,
): WorkerFn<T, R> => {
    const opts: RetryOptions =
        typeof options === 'number' ? { retries: options } : options

    if (!isIntegerInRange(opts.retries, 0)) {
        throw new Error('retries must be a safe integer >= 0')
    }

    // Static delay: validate once at wrap time.
    if (
        opts.delay !== undefined &&
        typeof opts.delay !== 'function' &&
        !isNonNegativeFinite(opts.delay)
    ) {
        throw new Error('retry delay must be a finite number >= 0')
    }

    const maxRetries = opts.retries
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

        // Unreachable when retries is a validated non-negative integer:
        // the loop always returns or throws RetryExhaustedError.
        throw new RetryExhaustedError(maxRetries + 1, lastError)
    }
}

