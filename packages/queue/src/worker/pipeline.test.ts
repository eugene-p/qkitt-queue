import { describe, expect, it, vi } from 'vitest'
import { retryWorker } from './retry'
import {
    pipelineDone,
    pipelineWorker,
    PipelineStepError,
} from './pipeline'

describe('pipelineWorker', () => {
    it('rejects an empty step list', () => {
        expect(() => pipelineWorker([])).toThrow(
            'pipelineWorker requires at least one step',
        )
    })

    it('passes each step result to the next (bare functions)', async () => {
        const worker = pipelineWorker([
            async (id: number) => ({ id, name: `user-${id}` }),
            async (user) => ({ ...user, ok: true }),
            async (row) => `${row.name}:${row.ok}`,
        ])

        await expect(worker(7)).resolves.toBe('user-7:true')
    })

    it('passes each step result to the next (named objects)', async () => {
        const worker = pipelineWorker([
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
        const worker = pipelineWorker([
            async (n: number) => n + 1,
            { name: 'double', fn: async (n: number) => n * 2 },
            async (n: number) => String(n),
        ])

        await expect(worker(3)).resolves.toBe('8')
    })

    it('supports a single step', async () => {
        const worker = pipelineWorker([async (s: string) => s.toUpperCase()])
        await expect(worker('hi')).resolves.toBe('HI')
    })

    it('runs steps in order', async () => {
        const order: string[] = []
        const worker = pipelineWorker([
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
        const worker = pipelineWorker([
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
        const worker = pipelineWorker([
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
        const worker = pipelineWorker([
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
        const worker = pipelineWorker([
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
            pipelineWorker([{ name: '', fn: async (n: number) => n }] as never),
        ).toThrow(/non-empty name/)
        expect(() => pipelineWorker([null as never])).toThrow(
            /must be a function or \{ name, fn/,
        )
        expect(() => pipelineWorker([{ name: 'x' } as never])).toThrow(
            /must be a function or \{ name, fn/,
        )
    })

    describe('pipelineDone', () => {
        it('resolves with undefined when done wraps undefined', async () => {
            const later = vi.fn(async () => 'nope')
            const worker = pipelineWorker([
                async () => pipelineDone(undefined),
                later,
            ])
            await expect(worker('x')).resolves.toBeUndefined()
            expect(later).not.toHaveBeenCalled()
        })

        it('stops the pipeline and resolves with the unwrapped value', async () => {
            const later = vi.fn(async (n: number) => n * 10)
            const worker = pipelineWorker([
                async (n: number) => {
                    if (n < 0) return pipelineDone({ status: 'skipped', n })
                    return n + 1
                },
                later,
            ])

            await expect(worker(-3)).resolves.toEqual({
                status: 'skipped',
                n: -3,
            })
            expect(later).not.toHaveBeenCalled()

            await expect(worker(2)).resolves.toBe(30)
            expect(later).toHaveBeenCalledOnce()
        })

        it('works from a named middle step', async () => {
            const third = vi.fn(async (s: string) => s.toUpperCase())
            const worker = pipelineWorker([
                async (n: number) => n + 1,
                {
                    name: 'guard',
                    fn: async (n: number) => {
                        if (n === 2) return pipelineDone('early')
                        return String(n)
                    },
                },
                third,
            ])

            await expect(worker(1)).resolves.toBe('early')
            expect(third).not.toHaveBeenCalled()

            await expect(worker(2)).resolves.toBe('3')
            expect(third).toHaveBeenCalledWith('3', expect.any(Object))
        })

        it('unwraps when the last step returns pipelineDone', async () => {
            const worker = pipelineWorker([
                async (n: number) => n + 1,
                async (n: number) => pipelineDone(n * 2),
            ])
            await expect(worker(3)).resolves.toBe(8)
        })

        it('does not treat plain objects with a value field as done', async () => {
            const worker = pipelineWorker([
                async () => ({ value: 42, status: 'ok' }),
                async (row: { value: number }) => row.value,
            ])
            await expect(worker(undefined)).resolves.toBe(42)
        })

        it('does not retry under retryWorker (success path)', async () => {
            const attempts = vi.fn(async (n: number) => {
                if (n === 0) return pipelineDone({ status: 'skipped' })
                throw new Error('should not run as failure')
            })
            const worker = retryWorker(
                pipelineWorker([
                    attempts,
                    async () => {
                        throw new Error('later step')
                    },
                ]),
                { retries: 3, delay: 0 },
            )

            await expect(worker(0)).resolves.toEqual({ status: 'skipped' })
            expect(attempts).toHaveBeenCalledOnce()
        })
    })
})

