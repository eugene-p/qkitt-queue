/**
 * Public persist / composition errors (safe to re-export from package barrels).
 */

/** Thrown when queue decorators are stacked in an unsupported order. */
export class InvalidQueueCompositionError extends Error {
    override readonly name = 'InvalidQueueCompositionError'

    constructor(message: string) {
        super(message)
    }
}

/** Thrown when a store does not implement {@link import('./contracts').RowStore}. */
export class InvalidStoreError extends Error {
    override readonly name = 'InvalidStoreError'

    constructor(message: string) {
        super(message)
    }
}

/** Thrown when a row id is not a safe integer ≥ 1. */
export class InvalidRowIdError extends Error {
    override readonly name = 'InvalidRowIdError'

    constructor(message = 'row id must be a safe integer >= 1') {
        super(message)
    }
}

/** Thrown when a row id collides with an existing id in the same queue/store. */
export class DuplicateRowIdError extends Error {
    override readonly name = 'DuplicateRowIdError'
    readonly id: number

    constructor(id: number) {
        super(`duplicate row id: ${id}`)
        this.id = id
    }
}

/** Thrown when lease generation does not match the current row lease. */
export class LeaseMismatchError extends Error {
    override readonly name = 'LeaseMismatchError'

    constructor(message = 'lease generation does not match current row lease') {
        super(message)
    }
}

/**
 * Thrown when `hydrate` / `replaceAll` runs while workers are active or rows
 * are leased.
 */
export class HydrateWhileActiveError extends Error {
    override readonly name = 'HydrateWhileActiveError'

    constructor(
        message = 'hydrate/replaceAll requires an idle queue (no active workers or leased rows)',
    ) {
        super(message)
    }
}

/** Thrown when the monotonic id counter cannot allocate another id. */
export class IdSpaceExhaustedError extends Error {
    override readonly name = 'IdSpaceExhaustedError'

    constructor(message = 'queue id space exhausted (MAX_SAFE_INTEGER)') {
        super(message)
    }
}

/** Thrown when recovery composition conflicts (e.g. withLoop + onFailure fail). */
export class ConflictingRecoveryError extends Error {
    override readonly name = 'ConflictingRecoveryError'

    constructor(message: string) {
        super(message)
    }
}
