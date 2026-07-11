import { describe, expect, it, vi } from 'vitest'
import { pipeline } from './pipeline'

describe('pipeline', () => {
    it('passes each step result to the next', async () => {
        const worker = pipeline(
            async (id: number) => ({ id, name: `user-${id}` }),
            async (user) => ({ ...user, ok: true }),
            async (row) => `${row.name}:${row.ok}`,
        )

        await expect(worker(7)).resolves.toBe('user-7:true')
    })

    it('supports a single step', async () => {
        const worker = pipeline(async (s: string) => s.toUpperCase())
        await expect(worker('hi')).resolves.toBe('HI')
    })

    it('runs steps in order', async () => {
        const order: string[] = []
        const worker = pipeline(
            async (n: number) => {
                order.push('a')
                return n + 1
            },
            async (n) => {
                order.push('b')
                return n * 2
            },
        )

        await expect(worker(3)).resolves.toBe(8)
        expect(order).toEqual(['a', 'b'])
    })

    it('stops and throws when a step fails', async () => {
        const later = vi.fn(async (n: number) => n)
        const worker = pipeline(
            async (_n: number) => {
                throw new Error('boom')
            },
            later,
        )

        await expect(worker(1)).rejects.toThrow('boom')
        expect(later).not.toHaveBeenCalled()
    })

    it('rejects an empty pipeline', () => {
        const empty = pipeline as unknown as () => never
        expect(() => empty()).toThrow(/at least one step/)
    })
})
