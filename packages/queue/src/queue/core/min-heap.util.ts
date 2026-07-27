/**
 * Binary min-heap keyed by a numeric field (e.g. availableAt).
 * O(1) peek, O(log n) push/pop.
 */

export type MinHeap<T> = {
    readonly size: number
    peek: () => T | undefined
    push: (value: T) => void
    pop: () => T | undefined
    /** Rebuild from values (O(n)). */
    rebuild: (values: readonly T[]) => void
    clear: () => void
    toArray: () => T[]
}


export const createMinHeap = <T>(keyOf: (value: T) => number): MinHeap<T> => {
    const data: T[] = []

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

    const rebuild = (values: readonly T[]): void => {
        data.length = 0
        for (let i = 0; i < values.length; i += 1) {
            data.push(values[i]!)
        }
        for (let i = (data.length >> 1) - 1; i >= 0; i -= 1) {
            siftDown(i)
        }
    }

    const clear = (): void => {
        data.length = 0
    }

    const toArray = (): T[] => data.slice()

    return {
        get size() {
            return data.length
        },
        peek,
        push,
        pop,
        rebuild,
        clear,
        toArray,
    }
}
