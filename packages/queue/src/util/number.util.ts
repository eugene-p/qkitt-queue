/**
 * True when `value` is a safe integer (`Number.isSafeInteger`) within
 * `[min, max]` (inclusive). Bounds default to unbounded.
 *
 * Prefer this for capacities, concurrency, and retry counts so values outside
 * `Number.MIN_SAFE_INTEGER`…`Number.MAX_SAFE_INTEGER` are rejected.
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

/**
 * True when `value` is a finite number ≥ 0 (durations may be fractional ms).
 */
export const isNonNegativeFinite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
