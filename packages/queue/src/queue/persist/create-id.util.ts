/**
 * Compact URL-safe ids (nanoid-style alphabet + random bytes).
 * Used as the default row id factory for {@link withRowPersist}.
 */

/** 64 URL-safe chars; power-of-two size keeps `byte & 63` unbiased. */
const ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

const DEFAULT_SIZE = 21

type GetRandomValues = (array: Uint8Array) => Uint8Array

let cachedGetRandomValues: GetRandomValues | undefined
let cryptoResolved = false

const resolveGetRandomValues = (): GetRandomValues | undefined => {
    if (cryptoResolved) return cachedGetRandomValues
    cryptoResolved = true
    const cryptoObj = (
        globalThis as {
            crypto?: {
                getRandomValues?: GetRandomValues
            }
        }
    ).crypto
    cachedGetRandomValues =
        typeof cryptoObj?.getRandomValues === 'function'
            ? cryptoObj.getRandomValues.bind(cryptoObj)
            : undefined
    return cachedGetRandomValues
}

const fillRandom = (bytes: Uint8Array): void => {
    const getRandomValues = resolveGetRandomValues()
    if (getRandomValues) {
        getRandomValues(bytes)
        return
    }

    // Weak fallback when Web Crypto is unavailable (e.g. very old runtimes).
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256)
    }
}

/**
 * Generate a compact URL-safe id.
 * Default length 21 ≈ 126 bits of entropy under `crypto.getRandomValues`.
 */
export const createId = (size: number = DEFAULT_SIZE): string => {
    if (!Number.isInteger(size) || size <= 0) {
        throw new RangeError(`createId size must be a positive integer, got ${size}`)
    }

    const bytes = new Uint8Array(size)
    fillRandom(bytes)

    const chars = new Array<string>(size)
    for (let i = 0; i < size; i += 1) {
        chars[i] = ALPHABET[(bytes[i] as number) & 63]!
    }
    return chars.join('')
}
