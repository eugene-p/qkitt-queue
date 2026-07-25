/**
 * Enforce unique, non-empty row ids (not empty or whitespace-only) before
 * memory or store mutation. Duplicate ids corrupt durable row semantics
 * (stores upsert by id).
 */

import { DuplicateRowIdError, InvalidRowIdError } from '../errors'

export const assertUniqueRowId = (
    id: unknown,
    existingIds: ReadonlySet<string>,
): string => {
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new InvalidRowIdError()
    }
    if (existingIds.has(id)) {
        throw new DuplicateRowIdError(id)
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
