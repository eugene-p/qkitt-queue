/** Compact dead head slots after this many shifts without a full rebuild. */
const COMPACT_HEAD_THRESHOLD = 64

/**
 * Parallel id list for row-persist (head at `idHead`, same FIFO order as the queue).
 * Mirrors the queue's head-index buffer so dequeue stays O(1) amortized.
 */
export type RowIdList = {
    push: (id: string) => void
    shift: () => string | undefined
    reset: (next: readonly string[]) => void
    /** Live ids head → tail (aligned with `queue.toArray()`). */
    live: () => string[]
    liveCount: () => number
}

export const createRowIdList = (): RowIdList => {
    const ids: string[] = []
    let idHead = 0

    const compactIfNeeded = (): void => {
        if (idHead === 0) return
        if (idHead < COMPACT_HEAD_THRESHOLD && idHead * 2 < ids.length) return
        ids.splice(0, idHead)
        idHead = 0
    }

    return {
        push: (id) => {
            ids.push(id)
        },
        shift: () => {
            if (idHead >= ids.length) return undefined
            const id = ids[idHead] as string
            idHead += 1
            compactIfNeeded()
            return id
        },
        reset: (next) => {
            ids.length = 0
            idHead = 0
            for (const id of next) {
                ids.push(id)
            }
        },
        live: () => ids.slice(idHead),
        liveCount: () => ids.length - idHead,
    }
}
