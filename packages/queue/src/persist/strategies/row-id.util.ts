/**
 * Enforce unique, non-empty row ids (not empty or whitespace-only) before
 * memory or store mutation. Duplicate ids corrupt durable row semantics
 * (stores upsert by id).
 */
export const assertUniqueRowId = (
    id: unknown,
    existingIds: ReadonlySet<string>,
): string => {
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('row id must be a non-empty string')
    }
    if (existingIds.has(id)) {
        throw new Error(`duplicate row id: ${id}`)
    }
    return id
}

/**
 * Validate a full ordered list of persisted rows (e.g. `loadAll()` / `replaceAll`).
 * Rejects empty, whitespace-only, or duplicate ids before any queue mutation.
 */
export const assertUniqueRowIds = (
    rows: readonly { id: unknown }[],
): void => {
    const seen = new Set<string>()
    for (const row of rows) {
        const id = assertUniqueRowId(row.id, seen)
        seen.add(id)
    }
}
