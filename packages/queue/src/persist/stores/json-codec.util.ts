export type JsonCodec<T> = {
    serialize: (value: T) => string
    deserialize: (raw: string) => T
}

/** Thrown when storage JSON/codec deserialize fails (corrupt or hostile data). */
export class StorageCodecError extends Error {
    override readonly name = 'StorageCodecError'
    override readonly cause: unknown

    constructor(message: string, cause?: unknown) {
        super(message, cause !== undefined ? { cause } : undefined)
        this.cause = cause
    }
}

export const defaultJsonCodec = <T>(): JsonCodec<T> => ({
    serialize: (value) => JSON.stringify(value),
    deserialize: (raw) => JSON.parse(raw) as T,
})

export const decodeWithCodec = <T>(
    label: string,
    raw: string,
    deserialize: (raw: string) => T,
): T => {
    try {
        return deserialize(raw)
    } catch (error) {
        throw new StorageCodecError(
            `Failed to deserialize ${label}: ${
                error instanceof Error ? error.message : String(error)
            }`,
            error,
        )
    }
}
