import { describe, expect, it } from 'vitest'
import { createWriteChain } from './write-chain.util'

describe('createWriteChain', () => {
    it('runs ops in order', async () => {
        const chain = createWriteChain()
        const order: number[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const first = chain.push(async () => {
            await gate
            order.push(1)
        })
        const second = chain.push(async () => {
            order.push(2)
        })

        release()
        await Promise.all([first, second])
        expect(order).toEqual([1, 2])
    })

    it('continues after a rejected op', async () => {
        const chain = createWriteChain()
        const order: string[] = []

        const failed = chain.push(async () => {
            order.push('a')
            throw new Error('boom')
        })
        const next = chain.push(async () => {
            order.push('b')
        })

        await expect(failed).rejects.toThrow('boom')
        await next
        expect(order).toEqual(['a', 'b'])
    })

    it('flush waits for the current chain', async () => {
        const chain = createWriteChain()
        let done = false
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        void chain.push(async () => {
            await gate
            done = true
        })

        const flushed = chain.flush()
        expect(done).toBe(false)
        release()
        await flushed
        expect(done).toBe(true)
    })
})
