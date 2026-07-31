/**
 * Binary min-heap keyed by a numeric field (e.g. availableAt).
 * O(1) peek, O(log n) push/pop.
 */

export type MinHeap<T> = {
    readonly size: number
    peek: () => T | undefined
    push: (value: T) => void
    pop: () => T | undefined
    /** Find a value without copying the backing array. */
    find: (predicate: (value: T) => boolean) => T | undefined
    /** Remove one value by identity without rebuilding the heap. */
    remove: (value: T) => boolean
    /** Rebuild from values (O(n)). */
    rebuild: (values: readonly T[]) => void
    clear: () => void
    toArray: () => T[]
}


export const createMinHeap = <T>(keyOf: (value: T) => number): MinHeap<T> => {
    let data: T[] = []

    const swap = (i: number, j: number): void => {
        const tmp = data[i]!
        data[i] = data[j]!
        data[j] = tmp
    }

    const siftUp = (index: number): void => {
        let i = index
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (keyOf(data[i]!) >= keyOf(data[parent]!)) break
            swap(i, parent)
            i = parent
        }
    }

    const siftDown = (index: number): void => {
        let i = index
        const n = data.length
        for (;;) {
            const left = i * 2 + 1
            const right = left + 1
            let smallest = i
            if (left < n && keyOf(data[left]!) < keyOf(data[smallest]!)) {
                smallest = left
            }
            if (right < n && keyOf(data[right]!) < keyOf(data[smallest]!)) {
                smallest = right
            }
            if (smallest === i) break
            swap(i, smallest)
            i = smallest
        }
    }

    const push = (value: T): void => {
        data.push(value)
        siftUp(data.length - 1)
    }

    const pop = (): T | undefined => {
        if (data.length === 0) return undefined
        const top = data[0]!
        const last = data.pop()!
        if (data.length > 0) {
            data[0] = last
            siftDown(0)
        }
        return top
    }

    const peek = (): T | undefined => data[0]

    const find = (predicate: (value: T) => boolean): T | undefined => {
        for (const value of data) {
            if (predicate(value)) return value
        }
        return undefined
    }

    const remove = (value: T): boolean => {
        const index = data.indexOf(value)
        if (index === -1) return false

        const last = data.pop()!
        if (index < data.length) {
            data[index] = last
            if (
                index > 0 &&
                keyOf(data[index]!) < keyOf(data[(index - 1) >> 1]!)
            ) {
                siftUp(index)
            } else {
                siftDown(index)
            }
        }
        return true
    }

    const rebuild = (values: readonly T[]): void => {
        // Replace instead of truncating so a large, stale heap backing store
        // is not retained after expiry compaction.
        data = Array.from(values)
        for (let i = (data.length >> 1) - 1; i >= 0; i -= 1) {
            siftDown(i)
        }
    }

    const clear = (): void => {
        // Drop capacity as well as element references; delayed/expiry heaps
        // can temporarily grow much larger than their steady-state size.
        data = []
    }

    const toArray = (): T[] => data.slice()

    return {
        get size() {
            return data.length
        },
        peek,
        push,
        pop,
        find,
        remove,
        rebuild,
        clear,
        toArray,
    }
}
