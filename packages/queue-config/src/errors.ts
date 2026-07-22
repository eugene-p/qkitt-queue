/**
 * Machine-readable codes for config validation / build failures.
 * Prefer branching on `code` rather than matching `message` strings.
 */
export type ConfigErrorCode =
    | 'INVALID_TYPE'
    | 'EMPTY_QUEUES'
    | 'EMPTY_KEY'
    | 'STORE_NOT_FOUND'
    | 'INVALID_ADAPTER'
    | 'INVALID_STRATEGY'
    | 'KEY_REQUIRED'
    | 'SHARED_STORE'
    | 'UNKNOWN_QUEUE'
    | 'JS_ONLY_FIELD'
    | 'INVALID_JSON'
    | 'INVALID_IMPL'
    | 'CONFLICTING_FIELDS'
    | 'MISSING_FIELD'

type ConfigValidationErrorOptions = {
    code: ConfigErrorCode
    /** Dot-path into the config when applicable (e.g. `config.stores.jobs.key`). */
    path?: string
    cause?: unknown
}

/**
 * Typed error thrown by validate / parse / resolve / build helpers.
 * `message` stays human-readable; `code` is for programmatic handling.
 */
export class ConfigValidationError extends Error {
    readonly code: ConfigErrorCode
    readonly path?: string

    constructor(message: string, options: ConfigValidationErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
        this.name = 'ConfigValidationError'
        this.code = options.code
        if (options.path !== undefined) {
            this.path = options.path
        }
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/** Throw a {@link ConfigValidationError} with a stable code. */
export const configError = (
    code: ConfigErrorCode,
    message: string,
    path?: string,
): never => {
    throw new ConfigValidationError(message, {
        code,
        ...(path !== undefined ? { path } : {}),
    })
}
