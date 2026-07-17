import {
    buildEventEmitter,
    type EventEmitter,
    type EventMap,
} from '../../events'
import { isIntegerInRange } from '../../util/number.util'

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
    emit: EventEmitter<TEvents>['emit']
}

export type BuildQueueOptions = {
    /**
     * Maximum items allowed in the queue.
     * Must be a safe integer ≥ 1.
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

export const buildQueue = <T>(options: BuildQueueOptions = {}): Queue<T> => {
    const maxSize = options.maxSize
    if (maxSize !== undefined && !isIntegerInRange(maxSize, 1)) {
        throw new Error('maxSize must be a safe integer >= 1')
    }

    // Two-stack FIFO: O(1) amortized enqueue/dequeue without splice shifting.
    let inbox: T[] = []
    let outbox: T[] = []
    const emitter = buildEventEmitter<QueueEvents<T>>()

    const liveSize = (): number => inbox.length + outbox.length

    const flipInboxToOutbox = (): void => {
        outbox = inbox.reverse()
        inbox = []
    }

    const assertCapacity = (nextSize: number): void => {
        if (maxSize !== undefined && nextSize > maxSize) {
            throw new QueueFullError(maxSize)
        }
    }

    const enqueue = (item: T): void => {
        assertCapacity(liveSize() + 1)
        inbox.push(item)
        emitter.emit('queue:enqueued', { item, size: liveSize() })
    }

    const dequeue = (): T | undefined => {
        if (liveSize() === 0) return undefined

        if (outbox.length === 0) {
            flipInboxToOutbox()
        }

        const item = outbox.pop() as T
        const size = liveSize()
        emitter.emit('queue:dequeued', { item, size })

        if (size === 0) {
            emitter.emit('queue:emptied', undefined)
        }

        return item
    }

    const peek = (): T | undefined => {
        if (liveSize() === 0) return undefined
        if (outbox.length > 0) {
            return outbox[outbox.length - 1]
        }
        return inbox[0]
    }

    const size = (): number => liveSize()

    const isEmpty = (): boolean => liveSize() === 0

    const clear = (): void => {
        const removed = liveSize()
        if (removed === 0) return

        inbox = []
        outbox = []
        emitter.emit('queue:cleared', { removed })
    }

    const replaceAll = (next: readonly T[]): void => {
        assertCapacity(next.length)
        inbox = [...next]
        outbox = []
    }

    const toArray = (): T[] => {
        if (outbox.length === 0) return [...inbox]
        return [...outbox.slice().reverse(), ...inbox]
    }

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
    }

    return api
}