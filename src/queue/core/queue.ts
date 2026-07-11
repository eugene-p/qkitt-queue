import {
    buildEventEmitter,
    type EventEmitter,
    type EventMap,
    type MergeEventMaps,
} from '../../events'

export type QueueEvents<T> = {
    /** Fired after an item is added to the tail. */
    'queue:enqueued': { item: T; size: number }
    /** Fired after an item is removed from the head. */
    'queue:dequeued': { item: T; size: number }
    /** Fired when the last item is dequeued (queue becomes empty). */
    'queue:emptied': undefined
    /** Fired after clear() removes all items. */
    'queue:cleared': { removed: number }
}

export type Queue<T, TEvents extends EventMap = QueueEvents<T>> = {
    /** Add an item to the tail (FIFO). Throws {@link QueueFullError} when at `maxSize`. */
    enqueue: (item: T) => void
    /** Remove and return the head item, or `undefined` if empty. */
    dequeue: () => T | undefined
    /** Return the head item without removing it. */
    peek: () => T | undefined
    /** Current number of items. */
    size: () => number
    /** Whether the queue has no items. */
    isEmpty: () => boolean
    /** Remove all items and emit `queue:cleared`. */
    clear: () => void
    /**
     * Replace all items without emitting queue events.
     * Used by persist hydrate/rollback so workers are not mid-stream during rebuild.
     * Throws {@link QueueFullError} when `items.length` exceeds `maxSize`.
     */
    replaceAll: (items: readonly T[]) => void
    /** Snapshot of items from head to tail (does not mutate). */
    toArray: () => T[]
    on: EventEmitter<TEvents>['on']
    once: EventEmitter<TEvents>['once']
    off: EventEmitter<TEvents>['off']
    /** Emit an event (built-in or added via expand). */
    emit: EventEmitter<TEvents>['emit']
    /**
     * Widen the queue event map with additional event types.
     * Same queue instance; existing listeners are preserved.
     */
    expand: <TExtra extends EventMap>() => Queue<T, MergeEventMaps<TEvents, TExtra>>
}

export type BuildQueueOptions = {
    /**
     * Maximum items allowed in the queue.
     * `enqueue` / `replaceAll` throw {@link QueueFullError} when exceeded.
     */
    maxSize?: number
}

/** Thrown when enqueue/replaceAll would exceed {@link BuildQueueOptions.maxSize}. */
export class QueueFullError extends Error {
    override readonly name = 'QueueFullError'
    readonly maxSize: number

    constructor(maxSize: number) {
        super(`Queue is full (maxSize=${maxSize})`)
        this.maxSize = maxSize
    }
}

/** Compact dead head slots after this many dequeues without a full rebuild. */
const COMPACT_HEAD_THRESHOLD = 64

export const buildQueue = <T>(options: BuildQueueOptions = {}): Queue<T> => {
    const maxSize = options.maxSize
    if (
        maxSize !== undefined &&
        (!Number.isFinite(maxSize) || maxSize < 1)
    ) {
        throw new Error('maxSize must be a finite number >= 1')
    }

    // Ring-style buffer: O(1) dequeue via head index; compact when head grows.
    const items: T[] = []
    let head = 0
    const emitter = buildEventEmitter<QueueEvents<T>>()

    const liveSize = (): number => items.length - head

    const compactIfNeeded = (): void => {
        if (head === 0) return
        if (head < COMPACT_HEAD_THRESHOLD && head * 2 < items.length) return
        items.splice(0, head)
        head = 0
    }

    const assertCapacity = (nextSize: number): void => {
        if (maxSize !== undefined && nextSize > maxSize) {
            throw new QueueFullError(maxSize)
        }
    }

    const enqueue = (item: T): void => {
        assertCapacity(liveSize() + 1)
        items.push(item)
        emitter.emit('queue:enqueued', { item, size: liveSize() })
    }

    const dequeue = (): T | undefined => {
        if (head >= items.length) return undefined

        const item = items[head] as T
        head += 1
        compactIfNeeded()

        const size = liveSize()
        emitter.emit('queue:dequeued', { item, size })

        if (size === 0) {
            emitter.emit('queue:emptied', undefined)
        }

        return item
    }

    const peek = (): T | undefined => {
        if (head >= items.length) return undefined
        return items[head]
    }

    const size = (): number => liveSize()

    const isEmpty = (): boolean => head >= items.length

    const clear = (): void => {
        const removed = liveSize()
        if (removed === 0) return

        items.length = 0
        head = 0
        emitter.emit('queue:cleared', { removed })
    }

    const replaceAll = (next: readonly T[]): void => {
        assertCapacity(next.length)
        items.length = 0
        head = 0
        for (const item of next) {
            items.push(item)
        }
    }

    const toArray = (): T[] => items.slice(head)

    const api: Queue<T> = {
        enqueue,
        dequeue,
        peek,
        size,
        isEmpty,
        clear,
        replaceAll,
        toArray,
        on: emitter.on,
        once: emitter.once,
        off: emitter.off,
        emit: emitter.emit,
        expand: <TExtra extends EventMap>() =>
            api as unknown as Queue<T, MergeEventMaps<QueueEvents<T>, TExtra>>,
    }

    return api
}
