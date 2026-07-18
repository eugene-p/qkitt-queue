/**
 * True when `value` is a safe integer (`Number.isSafeInteger`) within
 * `[min, max]` (inclusive). Bounds default to unbounded.
 *
 * Local copy — do not depend on @qkitt/queue internals.
 */
export const isIntegerInRange = (
    value: unknown,
    min = -Infinity,
    max = Infinity,
): value is number =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
