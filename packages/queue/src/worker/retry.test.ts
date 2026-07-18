import { describe, expect, it, vi } from 'vitest'
import { RetryExhaustedError, retryWorker, withRetry } from './retry'

describe('retryWorker', () => {
    it('exports withRetry as an alias of retryWorker', () => {
        expect(withRetry).toBe(retryWorker)
    })

    it('returns on first success without retrying', async () => {
        const inner = vi.fn(async (n: number) => n * 2)
        const worker = retryWorker(inner, 3)

        await expect(worker(21)).resolves.toBe(42)
        expect(inner).toHaveBeenCalledTimes(1)
    })

    it('retries the given number of times then succeeds', async () => {
        const inner = vi
            .fn()
            .mockRejectedValueOnce(new Error('1'))
            .mockRejectedValueOnce(new Error('2'))
            .mockResolvedValueOnce('ok')

        const worker = retryWorker(inner, { retries: 2 })

        await expect(worker('job')).resolves.toBe('ok')
        expect(inner).toHaveBeenCalledTimes(3)
    })

    it('throws RetryExhaustedError after all attempts fail', async () => {
        const cause = new Error('always')
        const inner = vi.fn(async () => {
            throw cause
        })
        const worker = retryWorker(inner, 2)

        let caught: unknown
        try {
            await worker(1)
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(RetryExhaustedError)
        expect(caught).toMatchObject({
            name: 'RetryExhaustedError',
            attempts: 3,
            cause,
        })
        expect(inner).toHaveBeenCalledTimes(3)
    })

    it('accepts a bare number as retries', async () => {
        const inner = vi
            .fn()
            .mockRejectedValueOnce(new Error('x'))
            .mockResolvedValueOnce(1)

        const worker = retryWorker(inner, 1)
        await expect(worker(0)).resolves.toBe(1)
        expect(inner).toHaveBeenCalledTimes(2)
    })

    it('honors shouldRetry to stop early', async () => {
        const fatal = Object.assign(new Error('fatal'), { fatal: true })
        const inner = vi.fn(async () => {
            throw fatal
        })
        const worker = retryWorker(inner, {
            retries: 5,
            shouldRetry: (error) =>
                !(error instanceof Error && 'fatal' in error && error.fatal),
        })

        await expect(worker(1)).rejects.toMatchObject({
            name: 'RetryExhaustedError',
            attempts: 1,
            cause: fatal,
        })
        expect(inner).toHaveBeenCalledTimes(1)
    })

    it('waits delay between retries', async () => {
        vi.useFakeTimers()
        const inner = vi
            .fn()
            .mockRejectedValueOnce(new Error('1'))
            .mockResolvedValueOnce('done')

        const worker = retryWorker(inner, { retries: 1, delay: 50 })
        const pending = worker('x')

        await Promise.resolve()
        expect(inner).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(50)
        await expect(pending).resolves.toBe('done')
        expect(inner).toHaveBeenCalledTimes(2)

        vi.useRealTimers()
    })

    it('supports function delay', async () => {
        vi.useFakeTimers()
        const seen: Array<{ attempt: number; error: unknown }> = []
        const inner = vi
            .fn()
            .mockRejectedValueOnce(new Error('1'))
            .mockResolvedValueOnce('ok')

        const worker = retryWorker(inner, {
            retries: 1,
            delay: (attempt, error) => {
                seen.push({ attempt, error })
                return 10
            },
        })
        const pending = worker('job')

        await Promise.resolve()
        expect(inner).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(10)
        await expect(pending).resolves.toBe('ok')
        expect(inner).toHaveBeenCalledTimes(2)
        expect(seen).toHaveLength(1)
        expect(seen[0]!.attempt).toBe(1)
        expect(seen[0]!.error).toBeInstanceOf(Error)

        vi.useRealTimers()
    })

    it('rejects invalid retries at wrap time', () => {
        const inner = vi.fn(async (n: number) => n)
        expect(() => retryWorker(inner, NaN)).toThrow(/retries/)
        expect(() => retryWorker(inner, -1)).toThrow(/retries/)
        expect(() => retryWorker(inner, 1.5)).toThrow(/retries/)
        expect(() => retryWorker(inner, { retries: Infinity })).toThrow(/retries/)
    })

    it('rejects invalid static delay at wrap time', () => {
        const inner = vi.fn(async (n: number) => n)
        expect(() => retryWorker(inner, { retries: 1, delay: -1 })).toThrow(
            /delay/,
        )
        expect(() => retryWorker(inner, { retries: 1, delay: NaN })).toThrow(
            /delay/,
        )
        expect(() =>
            retryWorker(inner, { retries: 1, delay: Infinity }),
        ).toThrow(/delay/)
    })

    it('throws when delay callback returns an invalid duration', async () => {
        const cause = new Error('fail')
        const inner = vi.fn(async () => {
            throw cause
        })
        const worker = retryWorker(inner, {
            retries: 2,
            delay: () => -1,
        })

        await expect(worker(1)).rejects.toThrow(/delay/)
        // Delay validation runs after the first failure, before retry 2.
        expect(inner).toHaveBeenCalledTimes(1)
    })

    it('retains RetryExhaustedError cause for exhausted failures', async () => {
        const cause = new Error('always')
        const inner = vi.fn(async () => {
            throw cause
        })
        const worker = retryWorker(inner, { retries: 0 })

        await expect(worker(1)).rejects.toMatchObject({
            name: 'RetryExhaustedError',
            attempts: 1,
            cause,
        })
    })
})
