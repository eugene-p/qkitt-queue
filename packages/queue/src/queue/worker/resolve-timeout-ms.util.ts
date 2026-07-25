import { isNonNegativeFinite } from '../../util/number.util'
import { InvalidWorkerOptionError } from './invalid-worker-option-error'

/** Validate optional lifecycle `timeoutMs` (finite number ≥ 0). */
export const resolveTimeoutMs = (
    timeoutMs: number | undefined,
): number | undefined => {
    if (timeoutMs === undefined) return undefined
    if (!isNonNegativeFinite(timeoutMs)) {
        throw new InvalidWorkerOptionError(
            'timeoutMs must be a finite number >= 0',
        )
    }
    return timeoutMs
}
