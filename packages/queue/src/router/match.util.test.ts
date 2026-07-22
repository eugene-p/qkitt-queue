import { describe, expect, it } from 'vitest'
import {
    isValidPattern,
    isValidTopicParts,
    matchTopicParts,
    TOPIC_SEPARATOR,
} from './match.util'

const parts = (s: string): string[] => s.split(TOPIC_SEPARATOR)

/** Match only when both sides validate (same gate as the router hot path). */
const match = (pattern: string, topic: string): boolean => {
    const patternParts = parts(pattern)
    const topicParts = parts(topic)
    if (!isValidPattern(pattern) || !isValidTopicParts(topicParts)) return false
    return matchTopicParts(patternParts, topicParts)
}

describe('matchTopicParts', () => {
    it('matches exact topics', () => {
        expect(match('orders.created', 'orders.created')).toBe(true)
        expect(match('orders.created', 'orders.updated')).toBe(false)
        expect(match('orders.created', 'orders.created.eu')).toBe(false)
    })

    it('matches single-segment *', () => {
        expect(match('orders.*', 'orders.created')).toBe(true)
        expect(match('orders.*', 'orders.updated')).toBe(true)
        expect(match('orders.*', 'orders.created.eu')).toBe(false)
        expect(match('orders.*', 'orders')).toBe(false)
        expect(match('*.created', 'orders.created')).toBe(true)
        expect(match('a.*.c', 'a.b.c')).toBe(true)
        expect(match('a.*.c', 'a.b.d')).toBe(false)
    })

    it('matches multi-segment #', () => {
        expect(match('orders.#', 'orders')).toBe(true)
        expect(match('orders.#', 'orders.created')).toBe(true)
        expect(match('orders.#', 'orders.created.eu')).toBe(true)
        expect(match('#', 'anything.at.all')).toBe(true)
        expect(match('a.b.#', 'a.b')).toBe(true)
        expect(match('a.b.#', 'a.b.c.d')).toBe(true)
        expect(match('a.b.#', 'a.c')).toBe(false)
    })

    it('rejects invalid patterns and topics', () => {
        expect(match('a.#.b', 'a.x.b')).toBe(false)
        expect(match('orders.*', 'orders.*.x')).toBe(false)
        expect(match('', 'a')).toBe(false)
        expect(match('a', '')).toBe(false)
    })
})

describe('isValidTopicParts', () => {
    it('validates concrete topic segments', () => {
        expect(isValidTopicParts(parts('orders.created'))).toBe(true)
        expect(isValidTopicParts(parts('smth.smth.2'))).toBe(true)
        expect(isValidTopicParts(parts('orders.*'))).toBe(false)
        expect(isValidTopicParts(parts('orders.#'))).toBe(false)
        expect(isValidTopicParts(parts('orders..created'))).toBe(false)
        expect(isValidTopicParts([])).toBe(false)
        expect(isValidTopicParts([''])).toBe(false)
    })
})

describe('isValidPattern', () => {
    it('validates bind patterns', () => {
        expect(isValidPattern('orders.created')).toBe(true)
        expect(isValidPattern('orders.*')).toBe(true)
        expect(isValidPattern('orders.#')).toBe(true)
        expect(isValidPattern('#')).toBe(true)
        expect(isValidPattern('*.*.id')).toBe(true)
        expect(isValidPattern('a.#.b')).toBe(false)
        expect(isValidPattern('a..b')).toBe(false)
        expect(isValidPattern('')).toBe(false)
        expect(isValidPattern('orders*')).toBe(false)
        expect(isValidPattern('orders#')).toBe(false)
        expect(isValidPattern('ord*.x')).toBe(false)
        expect(isValidPattern('x.ord#')).toBe(false)
    })
})
