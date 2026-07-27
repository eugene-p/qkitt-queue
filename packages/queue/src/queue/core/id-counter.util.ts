import { IdSpaceExhaustedError } from '../../persist/errors'

export const ID_MAX = Number.MAX_SAFE_INTEGER
/** Warn once when remaining ids drop to this many (or below). */
export const ID_LOW_WATER = 1_000_000

export type IdCounter = {
    /** Next id to allocate (1-based after first next()). */
    peek: () => number
    /** Allocate next id; throws {@link IdSpaceExhaustedError} at ceiling. */
    next: () => number
    /** After hydrate: ensure counter is at least `maxId` (0 if empty). */
    fixup: (maxId: number) => void
    /** Reset to 0 (after clear / replaceAll). */
    reset: () => void
    /** True once after remaining ids first reach {@link ID_LOW_WATER}. */
    consumeLowWaterWarning: () => boolean
}

export const createIdCounter = (start = 0): IdCounter => {
    let counter = start
    let lowWaterWarned = false

    const peek = (): number => counter

    const next = (): number => {
        if (counter >= ID_MAX) {
            throw new IdSpaceExhaustedError()
        }
        counter += 1
        return counter
    }

    const fixup = (maxId: number): void => {
        if (maxId > counter) counter = maxId
    }

    const reset = (): void => {
        counter = 0
        lowWaterWarned = false
    }

    const consumeLowWaterWarning = (): boolean => {
        if (lowWaterWarned) return false
        const remaining = ID_MAX - counter
        if (remaining > ID_LOW_WATER) return false
        lowWaterWarned = true
        return true
    }

    return { peek, next, fixup, reset, consumeLowWaterWarning }
}
