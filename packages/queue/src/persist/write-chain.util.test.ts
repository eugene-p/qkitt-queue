import { describe, expect, it } from 'vitest'
import { createWriteChain } from './write-chain.util'

describe('createWriteChain', () => {
    it('runs ops in order', async () => {
        const chain = createWriteChain()
        const order: number[] = []
        const p1 = chain.push(async () => {
            order.push(1)
        })
        const p2 = chain.push(async () => {
            order.push(2)
        })
        await Promise.all([p1, p2])
        expect(order).toEqual([1, 2])
    })

    it('flush waits for pending ops', async () => {
        const chain = createWriteChain()
        let done = false
        void chain.push(async () => {
            await Promise.resolve()
            done = true
        })
        await chain.flush()
        expect(done).toBe(true)
    })

    it('propagates sync return values', async () => {
        const chain = createWriteChain()
        const value = await chain.push(() => 42)
        expect(value).toBe(42)
    })

    it('continues after a rejected op', async () => {
        const chain = createWriteChain()
        const failed = chain.push(() => {
            throw new Error('boom')
        })
        await expect(failed).rejects.toThrow('boom')
        const next = await chain.push(() => 'ok')
        expect(next).toBe('ok')
    })
})
