import { describe, expect, it, vi } from 'vitest'
import { buildEventEmitter } from './index'
import { createSubscriptionCounts } from './subscription-counts'

type TestEvents = {
    a: number
    b: string
    c: undefined
}

describe('createSubscriptionCounts', () => {
    it('bumps counts on subscribe and unsubscribe', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const { counts, wrapOn } = createSubscriptionCounts({
            a: 'a',
            b: 'b',
        })
        const on = wrapOn(emitter.on)

        expect(counts.a).toBe(0)
        expect(counts.b).toBe(0)

        const offA1 = on('a', vi.fn())
        const offA2 = on('a', vi.fn())
        const offB = on('b', vi.fn())
        expect(counts.a).toBe(2)
        expect(counts.b).toBe(1)

        offA1()
        expect(counts.a).toBe(1)
        offA2()
        offB()
        expect(counts.a).toBe(0)
        expect(counts.b).toBe(0)
    })

    it('does not track unmapped event names', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const { counts, wrapOn } = createSubscriptionCounts({
            a: 'a',
        })
        const on = wrapOn(emitter.on)

        const off = on('c', vi.fn())
        expect(counts.a).toBe(0)
        off()
        expect(counts.a).toBe(0)
    })
})
