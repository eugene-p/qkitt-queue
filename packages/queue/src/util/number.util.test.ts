import { describe, expect, it } from 'vitest'
import { isIntegerInRange, isNonNegativeFinite } from './number.util'

describe('isIntegerInRange', () => {
    it('accepts integers in range', () => {
        expect(isIntegerInRange(0, 0)).toBe(true)
        expect(isIntegerInRange(1, 1)).toBe(true)
        expect(isIntegerInRange(5, 1, 10)).toBe(true)
        expect(isIntegerInRange(-2, -5, 0)).toBe(true)
    })

    it('rejects non-integers and out-of-range values', () => {
        expect(isIntegerInRange(1.5, 1)).toBe(false)
        expect(isIntegerInRange(NaN, 0)).toBe(false)
        expect(isIntegerInRange(Infinity, 0)).toBe(false)
        expect(isIntegerInRange(-Infinity, 0)).toBe(false)
        expect(isIntegerInRange(0, 1)).toBe(false)
        expect(isIntegerInRange(-1, 0)).toBe(false)
        expect(isIntegerInRange(11, 1, 10)).toBe(false)
        expect(isIntegerInRange('1', 1)).toBe(false)
        expect(isIntegerInRange(undefined, 1)).toBe(false)
        expect(isIntegerInRange(null, 1)).toBe(false)
    })

    it('rejects integers outside the safe integer range', () => {
        const unsafe = Number.MAX_SAFE_INTEGER + 1
        expect(Number.isInteger(unsafe)).toBe(true)
        expect(Number.isSafeInteger(unsafe)).toBe(false)
        expect(isIntegerInRange(unsafe, 1)).toBe(false)
        expect(isIntegerInRange(Number.MIN_SAFE_INTEGER - 1, -Infinity)).toBe(
            false,
        )
        expect(isIntegerInRange(Number.MAX_SAFE_INTEGER, 1)).toBe(true)
    })
})

describe('isNonNegativeFinite', () => {
    it('accepts zero and positive finite numbers', () => {
        expect(isNonNegativeFinite(0)).toBe(true)
        expect(isNonNegativeFinite(0.5)).toBe(true)
        expect(isNonNegativeFinite(100)).toBe(true)
    })

    it('rejects negatives, non-finite, and non-numbers', () => {
        expect(isNonNegativeFinite(-1)).toBe(false)
        expect(isNonNegativeFinite(NaN)).toBe(false)
        expect(isNonNegativeFinite(Infinity)).toBe(false)
        expect(isNonNegativeFinite('0')).toBe(false)
    })
})
