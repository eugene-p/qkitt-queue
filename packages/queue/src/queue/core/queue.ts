import {
    buildEventEmitter,
    type EventEmitter,
    type EventMap,
} from '../../events'
import { isIntegerInRange } from '../../util/number.util'
import { markQueueMaxSize } from './queue-max-size.util'

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

/**
 * Envelope for an occupied queue slot.
 *
 * Presence of the object means “there was an item”; {@link value} is the
 * payload and may be `null` or `undefined`. Emptiness is structural
 * (`undefined` return from {@link Queue.tryDequeue} / {@link Queue.tryPeek}),
 * never inferred from the payload.
 */
export type QueueSlot<T> = {
    readonly value: T
}

export type Queue<T, TEvents extends EventMap = QueueEvents<T>> = {
    /** Add an item to the tail (FIFO). Throws {@link QueueFullError} when at `maxSize`. */
    enqueue: (item: T) => void
    /**
     * Remove and return the head item, or `undefined` if empty.
     *
     * When `T` may be `null`/`undefined`, prefer {@link tryDequeue}: a bare
     * `undefined` return cannot distinguish “empty” from “payload was undefined”.
     */
    dequeue: () => T | undefined
    /**
     * Return the head item without removing it, or `undefined` if empty.
     *
     * When `T` may be `null`/`undefined`, prefer {@link tryPeek}.
     */
    peek: () => T | undefined
    /**
     * Remove the head and return it in a {@link QueueSlot}, or `undefined` if
     * the queue was empty. Nullish payloads are valid (`{ value: undefined }`).
     *
     * Decorators that override {@link dequeue} must override this too so side
     * effects (persist, hydrate gate) stay aligned.
     */
    tryDequeue: () => QueueSlot<T> | undefined
    /**
     * Peek the head in a {@link QueueSlot}, or `undefined` if empty.
     * Nullish payloads are valid (`{ value: undefined }`).
     *
     * Decorators that override {@link peek} must override this too when they
     * transform the payload (e.g. row unwrap).
     */
    tryPeek: () => QueueSlot<T> | undefined
    /** Current number of items. */
    size: () => number
    /** Whether the queue has no items. */
    isEmpty: () => boolean
    /** Remove all items and emit `queue:cleared`. */
    clear: () => void
    /**
     * Replace all items without emitting queue events.
     * Used by persist hydrate/rollback so workers are not mid-stream during rebuild.
     * Not a substitute for looping `enqueue` — no `queue:enqueued` events fire.
     * Throws {@link QueueFullError} when `items.length` exceeds `maxSize`.
     */
    replaceAll: (items: readonly T[]) => void
    /** Snapshot of items from head to tail (does not mutate). */
    toArray: () => T[]
    on: EventEmitter<TEvents>['on']
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

    // Integer sub counts: no-listener enqueue/dequeue stays a branch — no
    // Map.get and no payload allocation when nobody is subscribed.
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

    // Nullish payloads are valid. Emptiness is “no slot”, not “value is undefined”:
    // tryDequeue/tryPeek return `{ value }` when occupied, `undefined` when empty.
    const tryDequeue = (): QueueSlot<T> | undefined => {
        if (count === 0) return undefined

        if (outbox.length === 0) {
            flipInboxToOutbox()
        }

        const value = outbox.pop() as T
        count -= 1
        if (dequeuedSubs > 0) {
            emitter.emit('queue:dequeued', { item: value, size: count })
        }
        if (count === 0 && emptiedSubs > 0) {
            emitter.emit('queue:emptied', undefined)
        }

        return { value }
    }

    // Public dequeue inlines the core logic to avoid the QueueSlot allocation
    // that tryDequeue requires. Decorators use tryDequeue for the discriminant.
    const dequeue = (): T | undefined => {
        if (count === 0) return undefined

        if (outbox.length === 0) {
            flipInboxToOutbox()
        }

        const value = outbox.pop() as T
        count -= 1
        if (dequeuedSubs > 0) {
            emitter.emit('queue:dequeued', { item: value, size: count })
        }
        if (count === 0 && emptiedSubs > 0) {
            emitter.emit('queue:emptied', undefined)
        }

        return value
    }

    const tryPeek = (): QueueSlot<T> | undefined => {
        if (count === 0) return undefined
        const value =
            outbox.length > 0 ? outbox[outbox.length - 1]! : inbox[0]!
        return { value }
    }

    // Public peek inlines the lookup to avoid the QueueSlot allocation.
    const peek = (): T | undefined => {
        if (count === 0) return undefined
        return outbox.length > 0 ? outbox[outbox.length - 1]! : inbox[0]!
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

    // Single allocation: reverse-fill outbox then append inbox (head → tail).
    const toArray = (): T[] => {
        const outLen = outbox.length
        const inLen = inbox.length
        if (outLen === 0) return [...inbox]
        const result = new Array<T>(outLen + inLen)
        for (let i = 0; i < outLen; i += 1) {
            result[i] = outbox[outLen - 1 - i]!
        }
        for (let i = 0; i < inLen; i += 1) {
            result[outLen + i] = inbox[i]!
        }
        return result
    }

    const api: Queue<T> = {
        enqueue,
        dequeue,
        peek,
        tryDequeue,
        tryPeek,
        size,
        isEmpty,
        clear,
        replaceAll,
        toArray,
        on,
        emit: emitter.emit,
    }

    return markQueueMaxSize(api, maxSize)
}