import { isNonNegativeFinite } from './number.util'

/**
 * Delay in ms, or a function of the current 1-based attempt / hop count.
 * Only the attempt number is passed — not the error or other context.
 *
 * `withLoop` settles through `reschedule`; durable queues persist delayed rows
 * with their `availableAt` timestamp, while bare queues keep them in memory.
 */
export type DelayPolicy = number | ((attempt: number) => number)

/** Resolve a {@link DelayPolicy} to milliseconds (0 when unset). */
export const resolveDelayMs = (
    delay: DelayPolicy | undefined,
    attempt: number,
): number => {
    if (delay === undefined) return 0
    return typeof delay === 'function' ? delay(attempt) : delay
}

/** True when a static (non-function) delay option is present and invalid. */
export const isInvalidStaticDelay = (
    delay: DelayPolicy | undefined,
): boolean =>
    delay !== undefined &&
    typeof delay !== 'function' &&
    !isNonNegativeFinite(delay)
