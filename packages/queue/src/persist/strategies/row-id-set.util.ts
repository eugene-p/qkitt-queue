/**
 * O(1) row-id membership for row persist (avoids toArray+Set per enqueue).
 */

export type RowIdSet = {
    readonly set: ReadonlySet<string>
    has: (id: string) => boolean
    add: (id: string) => void
    delete: (id: string) => void
    clear: () => void
    rebuild: (rows: readonly { id: string }[]) => void
}

export const createRowIdSet = (): RowIdSet => {
    const ids = new Set<string>()

    return {
        get set() {
            return ids
        },
        has: (id) => ids.has(id),
        add: (id) => {
            ids.add(id)
        },
        delete: (id) => {
            ids.delete(id)
        },
        clear: () => {
            ids.clear()
        },
        rebuild: (rows) => {
            ids.clear()
            for (let i = 0; i < rows.length; i += 1) {
                ids.add(rows[i]!.id)
            }
        },
    }
}
