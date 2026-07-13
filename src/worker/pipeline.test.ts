import { describe, expect, it, vi } from 'vitest'
import { pipeline, PipelineStepError } from './pipeline'

describe('pipeline', () => {
    it('rejects an empty step list', () => {
        expect(() => pipeline([])).toThrow('pipeline requires at least one step')
    })

    it('passes each step result to the next (bare functions)', async () => {
        const worker = pipeline([
            async (id: number) => ({ id, name: `user-${id}` }),
            async (user) => ({ ...user, ok: true }),
            async (row) => `${row.name}:${row.ok}`,
        ])

        await expect(worker(7)).resolves.toBe('user-7:true')
    })

    it('passes each step result to the next (named objects)', async () => {
        const worker = pipeline([
            {
                name: 'load',
                fn: async (id: number) => ({ id, name: `user-${id}` }),
            },
            {
                name: 'flag',
                fn: async (user) => ({ ...user, ok: true }),
            },
            {
                name: 'format',
                fn: async (row) => `${row.name}:${row.ok}`,
            },
        ])

        await expect(worker(7)).resolves.toBe('user-7:true')
    })

    it('supports mixing bare functions and named objects', async () => {
        const worker = pipeline([
            async (n: number) => n + 1,
            { name: 'double', fn: async (n: number) => n * 2 },
            async (n: number) => String(n),
        ])

        await expect(worker(3)).resolves.toBe('8')
    })

    it('supports a single step', async () => {
        const worker = pipeline([async (s: string) => s.toUpperCase()])
        await expect(worker('hi')).resolves.toBe('HI')
    })

    it('runs steps in order', async () => {
        const order: string[] = []
        const worker = pipeline([
            async (n: number) => {
                order.push('a')
                return n + 1
            },
            async (n) => {
                order.push('b')
                return n * 2
            },
        ])

        await expect(worker(3)).resolves.toBe(8)
        expect(order).toEqual(['a', 'b'])
    })

    it('wraps bare-function failures with default step name', async () => {
        const later = vi.fn(async (n: number) => n)
        const cause = new Error('boom')
        const worker = pipeline([
            async (_n: number) => {
                throw cause
            },
            later,
        ])

        let caught: unknown
        try {
            await worker(1)
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PipelineStepError)
        expect(caught).toMatchObject({
            name: 'PipelineStepError',
            stepName: 'step[0]',
            stepIndex: 0,
            cause,
        })
        expect(later).not.toHaveBeenCalled()
    })

    it('passes name, index, and metadata to each step via ctx', async () => {
        const seen: unknown[] = []
        const worker = pipeline([
            {
                name: 'load',
                metadata: { table: 'users' },
                fn: async (id: number, ctx) => {
                    seen.push(ctx)
                    return id
                },
            },
            async (id: number, ctx) => {
                seen.push(ctx)
                return id
            },
        ])

        await worker(1)
        expect(seen).toEqual([
            { name: 'load', index: 0, metadata: { table: 'users' } },
            { name: 'step[1]', index: 1, metadata: undefined },
        ])
    })

    it('wraps named-step failures with name and metadata', async () => {
        const later = vi.fn(async (n: number) => n)
        const cause = new Error('boom')
        const worker = pipeline([
            {
                name: 'validate',
                metadata: { stage: 'pre' },
                fn: async (_n: number) => {
                    throw cause
                },
            },
            { name: 'later', fn: later },
        ])

        await expect(worker(1)).rejects.toMatchObject({
            name: 'PipelineStepError',
            stepName: 'validate',
            stepIndex: 0,
            metadata: { stage: 'pre' },
            cause,
        })
        expect(later).not.toHaveBeenCalled()
    })

    it('reports the failing step index when a middle step throws', async () => {
        const worker = pipeline([
            async (n: number) => n + 1,
            {
                name: 'middle',
                fn: async () => {
                    throw new Error('nope')
                },
            },
            async (n: number) => n,
        ])

        await expect(worker(1)).rejects.toMatchObject({
            name: 'PipelineStepError',
            stepName: 'middle',
            stepIndex: 1,
        })
    })

    it('rejects invalid step entries at construction', () => {
        expect(() =>
            pipeline([{ name: '', fn: async (n: number) => n }] as never),
        ).toThrow(/non-empty name/)
        expect(() => pipeline([null as never])).toThrow(
            /must be a function or \{ name, fn/,
        )
        expect(() => pipeline([{ name: 'x' } as never])).toThrow(
            /must be a function or \{ name, fn/,
        )
    })
})

