/** Reserved top-level key for library-owned queue bookkeeping on payloads. */
export const QKITT_QUEUE_KEY = '__qkittQueue' as const

/** True for plain objects (`{}` / Object.create(null)), not arrays, Date, class instances. */
export const isPlainObject = (
    value: unknown,
): value is Record<string, unknown> => {
    if (value === null || typeof value !== 'object') return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/**
 * Read hop count for a logical queue key.
 * Shape: `item.__qkittQueue.loop[name].hops`.
 */
export const getLoopHops = (
    item: unknown,
    name: string,
): number | undefined => {
    if (!isPlainObject(item)) return undefined
    const root = item[QKITT_QUEUE_KEY]
    if (!isPlainObject(root)) return undefined
    const loop = root.loop
    if (!isPlainObject(loop)) return undefined
    const entry = loop[name]
    if (!isPlainObject(entry)) return undefined
    const hops = entry.hops
    return typeof hops === 'number' && Number.isFinite(hops) ? hops : undefined
}

/** Shallow structural compare for reserved meta bags (JSON-safe values). */
export const queueMetaEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (a === undefined || b === undefined) return a === b
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    try {
        return JSON.stringify(a) === JSON.stringify(b)
    } catch {
        return false
    }
}

/**
 * Build library-owned `__qkittQueue` root with incremented hop for `name`,
 * preserving sibling keys under the root and under `loop`.
 */
export const buildLoopQueueMeta = (
    original: unknown,
    name: string,
    hops: number,
): Record<string, unknown> => {
    const prevRoot =
        isPlainObject(original) && isPlainObject(original[QKITT_QUEUE_KEY])
            ? (original[QKITT_QUEUE_KEY] as Record<string, unknown>)
            : {}
    const prevLoop = isPlainObject(prevRoot.loop)
        ? (prevRoot.loop as Record<string, unknown>)
        : {}
    const prevEntry = isPlainObject(prevLoop[name])
        ? (prevLoop[name] as Record<string, unknown>)
        : {}

    return {
        ...prevRoot,
        loop: {
            ...prevLoop,
            [name]: {
                ...prevEntry,
                hops,
            },
        },
    }
}

/**
 * Apply library hop stamp onto a user (or identity) map result.
 * Always overwrites {@link QKITT_QUEUE_KEY} with {@link buildLoopQueueMeta}
 * computed from the **original** failed item.
 */
export const stampLoopHops = <T>(
    mapped: unknown,
    original: T,
    name: string,
    hops: number,
): unknown => {
    const libraryRoot = buildLoopQueueMeta(original, name, hops)

    if (!isPlainObject(mapped)) {
        return {
            value: mapped,
            [QKITT_QUEUE_KEY]: libraryRoot,
        }
    }

    const next: Record<string, unknown> = { ...mapped }
    delete next[QKITT_QUEUE_KEY]
    next[QKITT_QUEUE_KEY] = libraryRoot
    return next
}

/** Own-property reserved bag on a plain mapped result, if any. */
export const readMappedQueueMeta = (mapped: unknown): unknown => {
    if (!isPlainObject(mapped)) return undefined
    if (!Object.prototype.hasOwnProperty.call(mapped, QKITT_QUEUE_KEY)) {
        return undefined
    }
    return mapped[QKITT_QUEUE_KEY]
}
