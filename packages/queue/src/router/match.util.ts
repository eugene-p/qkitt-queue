/** Dot-separated topic segments, e.g. `orders.created.eu`. */
export const TOPIC_SEPARATOR = '.'

/** Matches exactly one non-empty segment. */
export const SINGLE_WILDCARD = '*'

/** Matches zero or more segments; only valid as the final pattern token. */
export const MULTI_WILDCARD = '#'

const isEmptySegment = (segment: string): boolean => segment.length === 0

/**
 * Validate pre-split concrete topic segments (no wildcards, no empty parts).
 * Prefer this on hot paths that already split the topic string once.
 */
export const isValidTopicParts = (segments: readonly string[]): boolean => {
    if (segments.length === 0) return false
    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i]!
        if (isEmptySegment(segment)) return false
        if (
            segment.includes(SINGLE_WILDCARD) ||
            segment.includes(MULTI_WILDCARD)
        ) {
            return false
        }
    }
    return true
}

/**
 * Validate a concrete publish topic (no wildcards, no empty segments).
 */
export const isValidTopic = (topic: string): boolean => {
    if (topic.length === 0) return false
    return isValidTopicParts(topic.split(TOPIC_SEPARATOR))
}

/**
 * Validate a bind pattern.
 * Wildcards `*` and `#` are only valid as an entire segment (`*` any one
 * segment; `#` only as the final segment). Mixed tokens like `orders*` or
 * `ord#` are rejected so they cannot form dead bindings.
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
        if (segment === SINGLE_WILDCARD) {
            continue
        }
        // Literal segments must not embed wildcard characters.
        if (
            segment.includes(SINGLE_WILDCARD) ||
            segment.includes(MULTI_WILDCARD)
        ) {
            return false
        }
    }

    return true
}

/**
 * Core matcher over pre-split segments. No validation — caller must supply
 * valid parts (e.g. after {@link isValidPattern} / {@link isValidTopic}).
 * Used by {@link matchTopic} and by the router hot path to avoid re-splitting.
 */
export const matchTopicParts = (
    patternParts: readonly string[],
    topicParts: readonly string[],
): boolean => {
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
    return matchTopicParts(
        pattern.split(TOPIC_SEPARATOR),
        topic.split(TOPIC_SEPARATOR),
    )
}
