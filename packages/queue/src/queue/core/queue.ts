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
    // Maintained `count` avoids inbox.length + outbox.length on every op.
    let inbox: T[] = []
    let outbox: T[] = []
    let count = 0
    const emitter = buildEventEmitter<QueueEvents<T>>()

    // Integer sub counts: no-listener enqueue/dequeue is a branch, not a Map.get.
    let enqueuedSubs = 0
    let dequeuedSubs = 0
    let emptiedSubs = 0
    let clearedSubs = 0

    const bump = (eventName: keyof QueueEvents<T>, delta: number): void => {
        switch (eventName) {
            case 'queue:enqueued':
                enqueuedSubs += delta
                break
            case 'queue:dequeued':
                dequeuedSubs += delta
                break
            case 'queue:emptied':
                emptiedSubs += delta
                break
            case 'queue:cleared':
                clearedSubs += delta
                break
        }
    }

    const on: Queue<T>['on'] = (eventName, callback) => {
        const unsubscribe = emitter.on(eventName, callback)
        bump(eventName, 1)
        return () => {
            unsubscribe()
            bump(eventName, -1)
        }
    }

    const once: Queue<T>['once'] = (eventName, callback) => {
        bump(eventName, 1)
        let settled = false
        const release = (): void => {
            if (settled) return
            settled = true
            bump(eventName, -1)
        }
        const unsubscribe = emitter.once(eventName, (data) => {
            release()
            callback(data)
        })
        return () => {
            unsubscribe()
            release()
        }
    }

    const flipInboxToOutbox = (): void => {
        // Reverse in place, then retarget: no intermediate copy of elements.
        outbox = inbox
        outbox.reverse()
        inbox = []
    }

    const enqueue = (item: T): void => {
        if (maxSize !== undefined && count >= maxSize) {
            throw new QueueFullError(maxSize)
        }
        inbox.push(item)
        count += 1
        if (enqueuedSubs > 0) {
            emitter.emit('queue:enqueued', { item, size: count })
        }
    }

    const dequeue = (): T | undefined => {
        if (count === 0) return undefined

        if (outbox.length === 0) {
            flipInboxToOutbox()
        }

        const item = outbox.pop() as T
        count -= 1
        if (dequeuedSubs > 0) {
            emitter.emit('queue:dequeued', { item, size: count })
        }
        if (count === 0 && emptiedSubs > 0) {
            emitter.emit('queue:emptied', undefined)
        }

        return item
    }

    const peek = (): T | undefined => {
        if (count === 0) return undefined
        if (outbox.length > 0) {
            return outbox[outbox.length - 1]
        }
        return inbox[0]
    }

    const size = (): number => count

    const isEmpty = (): boolean => count === 0

    const clear = (): void => {
        if (count === 0) return

        const removed = count
        inbox = []
        outbox = []
        count = 0
        if (clearedSubs > 0) {
            emitter.emit('queue:cleared', { removed })
        }
    }

    const replaceAll = (next: readonly T[]): void => {
        if (maxSize !== undefined && next.length > maxSize) {
            throw new QueueFullError(maxSize)
        }
        inbox = [...next]
        outbox = []
        count = next.length
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
        on,
        once,
        emit: emitter.emit,
    }

    return api
}