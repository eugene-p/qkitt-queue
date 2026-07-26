import { describe, expect, it } from 'vitest'
import {
    isInvalidStaticDelay,
    resolveDelayMs,
} from './delay-policy.util'

describe('delay-policy.util', () => {
    it('resolveDelayMs returns 0 when unset', () => {
        expect(resolveDelayMs(undefined, 1)).toBe(0)
    })

    it('resolveDelayMs returns static ms', () => {
        expect(resolveDelayMs(50, 3)).toBe(50)
    })

    it('resolveDelayMs passes attempt to function', () => {
        expect(resolveDelayMs((n) => n * 10, 3)).toBe(30)
    })

    it('isInvalidStaticDelay detects bad numbers only', () => {
        expect(isInvalidStaticDelay(undefined)).toBe(false)
        expect(isInvalidStaticDelay(0)).toBe(false)
        expect(isInvalidStaticDelay(1)).toBe(false)
        expect(isInvalidStaticDelay(() => 1)).toBe(false)
        expect(isInvalidStaticDelay(-1)).toBe(true)
        expect(isInvalidStaticDelay(NaN)).toBe(true)
        expect(isInvalidStaticDelay(Infinity)).toBe(true)
    })
})
