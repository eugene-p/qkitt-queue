import { describe, expect, it } from 'vitest'
import { createJob, InvalidJobOptionError, isJob } from './job'

describe('createJob', () => {
    it('keeps payload separate from stable job metadata', () => {
        const job = createJob(
            { email: 'a@example.com' },
            {
                id: ' mail-1 ',
                enqueuedAt: 1_700_000_000_000,
                metadata: { traceId: 'trace-1' },
            },
        )

        expect(job).toEqual({
            id: 'mail-1',
            payload: { email: 'a@example.com' },
            enqueuedAt: 1_700_000_000_000,
            metadata: { traceId: 'trace-1' },
        })
        expect(isJob(job)).toBe(true)
    })

    it('rejects invalid application ids and timestamps', () => {
        expect(() => createJob('x', undefined as never)).toThrow(
            InvalidJobOptionError,
        )
        expect(() => createJob('x', { id: '  ' })).toThrow(
            InvalidJobOptionError,
        )
        expect(() => createJob('x', { id: 'x', enqueuedAt: -1 })).toThrow(
            InvalidJobOptionError,
        )
        expect(isJob({ id: 'x', payload: 1, enqueuedAt: Number.NaN })).toBe(
            false,
        )
    })
})
