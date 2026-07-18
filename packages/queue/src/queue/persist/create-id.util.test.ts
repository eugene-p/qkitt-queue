import { describe, expect, it } from 'vitest'
import { createId } from './create-id.util'

const URL_SAFE = /^[A-Za-z0-9_-]+$/

describe('createId', () => {
    it('returns a 21-char URL-safe id by default', () => {
        const id = createId()
        expect(id).toHaveLength(21)
        expect(id).toMatch(URL_SAFE)
    })

    it('honors custom size', () => {
        expect(createId(8)).toHaveLength(8)
        expect(createId(1)).toHaveLength(1)
    })

    it('produces distinct values across many samples', () => {
        const seen = new Set<string>()
        for (let i = 0; i < 200; i += 1) {
            seen.add(createId())
        }
        expect(seen.size).toBe(200)
    })

    it('rejects non-positive sizes', () => {
        expect(() => createId(0)).toThrow(RangeError)
        expect(() => createId(-1)).toThrow(RangeError)
        expect(() => createId(1.5)).toThrow(RangeError)
    })
})
