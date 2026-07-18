import { describe, expect, it } from 'vitest'
import {
    isValidPattern,
    isValidTopic,
    matchTopic,
} from './match.util'

describe('matchTopic', () => {
    it('matches exact topics', () => {
        expect(matchTopic('orders.created', 'orders.created')).toBe(true)
        expect(matchTopic('orders.created', 'orders.updated')).toBe(false)
        expect(matchTopic('orders.created', 'orders.created.eu')).toBe(false)
    })

    it('matches single-segment *', () => {
        expect(matchTopic('orders.*', 'orders.created')).toBe(true)
        expect(matchTopic('orders.*', 'orders.updated')).toBe(true)
        expect(matchTopic('orders.*', 'orders.created.eu')).toBe(false)
        expect(matchTopic('orders.*', 'orders')).toBe(false)
        expect(matchTopic('*.created', 'orders.created')).toBe(true)
        expect(matchTopic('a.*.c', 'a.b.c')).toBe(true)
        expect(matchTopic('a.*.c', 'a.b.d')).toBe(false)
    })

    it('matches multi-segment #', () => {
        expect(matchTopic('orders.#', 'orders')).toBe(true)
        expect(matchTopic('orders.#', 'orders.created')).toBe(true)
        expect(matchTopic('orders.#', 'orders.created.eu')).toBe(true)
        expect(matchTopic('#', 'anything.at.all')).toBe(true)
        expect(matchTopic('a.b.#', 'a.b')).toBe(true)
        expect(matchTopic('a.b.#', 'a.b.c.d')).toBe(true)
        expect(matchTopic('a.b.#', 'a.c')).toBe(false)
    })

    it('rejects invalid patterns and topics for matching', () => {
        expect(matchTopic('a.#.b', 'a.x.b')).toBe(false)
        expect(matchTopic('orders.*', 'orders.*.x')).toBe(false)
        expect(matchTopic('', 'a')).toBe(false)
        expect(matchTopic('a', '')).toBe(false)
    })
})

describe('isValidTopic / isValidPattern', () => {
    it('validates topics', () => {
        expect(isValidTopic('orders.created')).toBe(true)
        expect(isValidTopic('smth.smth.2')).toBe(true)
        expect(isValidTopic('orders.*')).toBe(false)
        expect(isValidTopic('orders.#')).toBe(false)
        expect(isValidTopic('orders..created')).toBe(false)
        expect(isValidTopic('')).toBe(false)
    })

    it('validates patterns', () => {
        expect(isValidPattern('orders.created')).toBe(true)
        expect(isValidPattern('orders.*')).toBe(true)
        expect(isValidPattern('orders.#')).toBe(true)
        expect(isValidPattern('#')).toBe(true)
        expect(isValidPattern('*.*.id')).toBe(true)
        expect(isValidPattern('a.#.b')).toBe(false)
        expect(isValidPattern('a..b')).toBe(false)
        expect(isValidPattern('')).toBe(false)
        // Wildcard chars only valid as whole segments.
        expect(isValidPattern('orders*')).toBe(false)
        expect(isValidPattern('orders#')).toBe(false)
        expect(isValidPattern('ord*.x')).toBe(false)
        expect(isValidPattern('x.ord#')).toBe(false)
    })
})
