/** Dot-separated topic segments, e.g. `orders.created.eu`. */
export const TOPIC_SEPARATOR = '.'

/** Matches exactly one non-empty segment. */
export const SINGLE_WILDCARD = '*'

/** Matches zero or more segments; only valid as the final pattern token. */
export const MULTI_WILDCARD = '#'

const isEmptySegment = (segment: string): boolean => segment.length === 0

/**
 * Validate a concrete publish topic (no wildcards, no empty segments).
 */
export const isValidTopic = (topic: string): boolean => {
    if (topic.length === 0) return false
    if (topic.includes(SINGLE_WILDCARD) || topic.includes(MULTI_WILDCARD)) {
        return false
    }
    const segments = topic.split(TOPIC_SEPARATOR)
    return segments.length > 0 && !segments.some(isEmptySegment)
}

/**
 * Validate a bind pattern (`*`, `#` allowed; `#` only as last segment).
 */
export const isValidPattern = (pattern: string): boolean => {
    if (pattern.length === 0) return false
    const segments = pattern.split(TOPIC_SEPARATOR)
    if (segments.some(isEmptySegment)) return false

    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i]!
        if (segment === MULTI_WILDCARD) {
            return i === segments.length - 1
        }
        // `*` is a full segment; mixed tokens like `ord*` are not wildcards.
    }

    return true
}

/**
 * MQTT / AMQP-style topic match.
 *
 * - `orders.created` matches only that topic
 * - `orders.*` matches `orders.created`, not `orders.a.b`
 * - `orders.#` matches `orders`, `orders.created`, `orders.a.b`
 * - `#` matches everything
 */
export const matchTopic = (pattern: string, topic: string): boolean => {
    if (!isValidPattern(pattern) || !isValidTopic(topic)) return false

    const patternParts = pattern.split(TOPIC_SEPARATOR)
    const topicParts = topic.split(TOPIC_SEPARATOR)

    let pi = 0
    let ti = 0

    while (pi < patternParts.length && ti < topicParts.length) {
        const token = patternParts[pi]!

        if (token === MULTI_WILDCARD) {
            return true
        }

        if (token === SINGLE_WILDCARD || token === topicParts[ti]) {
            pi += 1
            ti += 1
            continue
        }

        return false
    }

    // Trailing `#` matches the empty remainder.
    if (pi === patternParts.length - 1 && patternParts[pi] === MULTI_WILDCARD) {
        return true
    }

    return pi === patternParts.length && ti === topicParts.length
}
