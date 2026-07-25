/**
 * Public persist / composition errors (safe to re-export from package barrels).
 * Keep this module free of private strategy imports so prune-dts does not pack
 * implementation-only declaration files.
 */

/** Thrown when queue decorators are stacked in an unsupported order. */
export class InvalidQueueCompositionError extends Error {
    override readonly name = 'InvalidQueueCompositionError'

    constructor(message: string) {
        super(message)
    }
}

/** Thrown when snapshot persist options are invalid. */
export class InvalidPersistOptionError extends Error {
    override readonly name = 'InvalidPersistOptionError'

    constructor(message: string) {
        super(message)
    }
}

/** Thrown when `withPersist` cannot resolve a store strategy. */
export class InvalidStoreError extends Error {
    override readonly name = 'InvalidStoreError'

    constructor(message: string) {
        super(message)
    }
}

/** Thrown when a row id is missing, empty, or whitespace-only. */
export class InvalidRowIdError extends Error {
    override readonly name = 'InvalidRowIdError'

    constructor(message = 'row id must be a non-empty string') {
        super(message)
    }
}

/** Thrown when a row id collides with an existing id in the same queue/store. */
export class DuplicateRowIdError extends Error {
    override readonly name = 'DuplicateRowIdError'
    readonly id: string

    constructor(id: string) {
        super(`duplicate row id: ${id}`)
        this.id = id
    }
}
