import {
    buildEventEmitter,
    type EventEmitter,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
import { createSubscriptionCounts } from '../../events/subscription-counts'
import type { PersistEvents, RowRecord, RowStore } from '../../persist/contracts'
import {
    DuplicateRowIdError,
    HydrateWhileActiveError,
    InvalidRowIdError,
    InvalidStoreError,
    LeaseMismatchError,
} from '../../persist/errors'
import { isRowStore } from '../../persist/store-guards.util'
import { createWriteChain } from '../../persist/write-chain.util'
import { isIntegerInRange } from '../../util/number.util'
import { RESOLVED, RESOLVED_UNDEFINED } from '../../util/resolved.util'
import {
    cancelTimeout,
    scheduleTimeout,
} from '../../util/schedule-timeout.util'
import { createIdCounter } from './id-counter.util'
import { attachInlineOps } from './inline-ops'
import { createMinHeap, type MinHeap } from './min-heap.util'
import { markQueueMaxSize } from './queue-max-size.util'
import { markQueueName } from './queue-name.util'

export type QueueEvents<T> = {
    /** Fired after an item is added (available or delayed). */
    'queue:enqueued': { item: T; size: number }
    /** Fired after an admin drop removes the head available item. */
    'queue:dequeued': { item: T; size: number }
    /** Fired when size becomes 0 after a remove path. */
    'queue:emptied': undefined
    /** Fired after clear() removes all items. */
    'queue:cleared': { removed: number }
}

export type Lease<T> = {
    id: number
    item: T
    generation: number
    /** 1-based delivery attempt; older durable rows begin at 1. */
    attempt: number
}

export type QueueStats = {
    available: number
    delayed: number
    leased: number
}

/**
 * Envelope for an occupied queue slot (admin peek/dequeue).
 * Presence means “there was an item”; value may be nullish.
 */
export type QueueSlot<T> = {
    readonly value: T
}

/**
 * In-memory lease row. Structurally a {@link Lease} plus optional TTL.
 * Inline claimSync returns this same object (one alloc) and may recycle it
 * via a freelist after ack/release, dropping the payload reference on settle.
 */
type LeasedEntry<T> = {
    id: number
    item: T
    generation: number
    expiresAt: number | null
    attempt: number
}

type DelayedEntry<T> = {
    id: number
    item: T
    availableAt: number
    attempt: number
}

type LeaseExpiry = {
    id: number
    generation: number
    expiresAt: number
}

export type Queue<
    T,
    TEvents extends EventMap = QueueEvents<T>,
> = {
    enqueue: (item: T, opts?: { delayMs?: number }) => Promise<void>
    claim: () => Promise<Lease<T> | undefined>
    ack: (lease: Lease<T>) => Promise<void>
    release: (lease: Lease<T>) => Promise<void>
    reschedule: (
        lease: Lease<T>,
        next: { item: T; delayMs?: number; attempt?: number },
    ) => Promise<void>
    /** Admin drop of head available row (not the worker processing path). */
    dequeue: () => Promise<T | undefined>
    tryDequeue: () => Promise<QueueSlot<T> | undefined>
    peek: () => T | undefined
    tryPeek: () => QueueSlot<T> | undefined
    /** All non-acked rows (available + delayed + leased). */
    size: () => number
    /** Claimable available rows only. */
    readyCount: () => number
    stats: () => QueueStats
    isEmpty: () => boolean
    clear: () => Promise<void>
    replaceAll: (items: readonly T[]) => Promise<void>
    toArray: () => T[]
    rowIds: () => number[]
    hydrate: () => Promise<void>
    flush: () => Promise<void>
    on: EventEmitter<TEvents>['on']
    emit: EventEmitter<TEvents>['emit']
}

export type BuildQueueOptions<T = unknown> = {
    maxSize?: number
    name?: string
    store?: RowStore<T>
    /**
     * In-process lease TTL (ms). Omitted → reclaim only on hydrate/restart.
     * Must be a safe integer ≥ 1 when set.
     */
    leaseTtlMs?: number
}

/** Thrown when enqueue/replaceAll would exceed maxSize. */
export class QueueFullError extends Error {
    override readonly name = 'QueueFullError'
    readonly maxSize: number

    constructor(maxSize: number) {
        super(`Queue is full (maxSize=${maxSize})`)
        this.maxSize = maxSize
    }
}

/** Thrown when {@link BuildQueueOptions} values are invalid. */
export class InvalidQueueOptionError extends Error {
    override readonly name = 'InvalidQueueOptionError'

    constructor(message: string) {
        super(message)
    }
}

const nowMs = (): number => Date.now()

const isSafeId = (id: unknown): id is number =>
    typeof id === 'number' && Number.isSafeInteger(id) && id >= 1

export const buildQueue = <T>(
    options: BuildQueueOptions<T> = {},
): Queue<T, MergeEventMaps<QueueEvents<T>, PersistEvents>> => {
    const maxSize = options.maxSize
    if (maxSize !== undefined && !isIntegerInRange(maxSize, 1)) {
        throw new InvalidQueueOptionError('maxSize must be a safe integer >= 1')
    }

    let name: string | undefined
    if (options.name !== undefined) {
        const trimmed = options.name.trim()
        if (trimmed === '') {
            throw new InvalidQueueOptionError('name must be a non-empty string')
        }
        name = trimmed
    }

    const leaseTtlMs = options.leaseTtlMs
    if (leaseTtlMs !== undefined && !isIntegerInRange(leaseTtlMs, 1)) {
        throw new InvalidQueueOptionError(
            'leaseTtlMs must be a safe integer >= 1',
        )
    }

    const store = options.store
    if (store !== undefined && !isRowStore(store)) {
        throw new InvalidStoreError(
            'buildQueue: store must implement RowStore (loadAll, put, remove, clear)',
        )
    }
    const durable = store !== undefined
    const chain = durable ? createWriteChain() : undefined
    /**
     * Durable rows need stable ids on available. Inline available is raw `T`
     * (no parallel id array) — ids are allocated only on claim / delay.
     */
    const trackAvailableIds = durable

    // Split in-memory state: available FIFO (+ optional ids) + leased + delayed.
    let availableItems: T[] = []
    let availableIds: number[] = []
    let availableAttempts: number[] = []
    let availableOutItems: T[] = []
    let availableOutIds: number[] = []
    let availableOutAttempts: number[] = []
    let availableCount = 0
    const leased = new Map<number, LeasedEntry<T>>()
    /** Recycled lease objects for the inline claim/ack hot path (cap keeps GC happy). */
    const leaseFreelist: LeasedEntry<T>[] = []
    const LEASE_FREELIST_MAX = 64
    // Lazy: most queues never use delay.
    let delayed: MinHeap<DelayedEntry<T>> | undefined
    const getDelayed = (): MinHeap<DelayedEntry<T>> => {
        if (delayed === undefined) {
            delayed = createMinHeap<DelayedEntry<T>>((e) => e.availableAt)
        }
        return delayed
    }
    const delayedSize = (): number => delayed?.size ?? 0
    // Lazy: only queues with lease TTLs need expiry tracking.
    let leaseExpiries: MinHeap<LeaseExpiry> | undefined
    const getLeaseExpiries = (): MinHeap<LeaseExpiry> => {
        if (leaseExpiries === undefined) {
            leaseExpiries = createMinHeap<LeaseExpiry>((entry) => entry.expiresAt)
        }
        return leaseExpiries
    }
    const ids = createIdCounter()
    // Monotonic lease generation (single-process); no per-id Map retained after ack.
    let leaseGenSeq = 0
    const nextLeaseGeneration = (): number => {
        leaseGenSeq += 1
        return leaseGenSeq
    }

    const allocLease = (
        id: number,
        item: T,
        generation: number,
        expiresAt: number | null,
        attempt: number,
    ): LeasedEntry<T> => {
        const recycled = leaseFreelist.pop()
        if (recycled !== undefined) {
            recycled.id = id
            recycled.item = item
            recycled.generation = generation
            recycled.expiresAt = expiresAt
            recycled.attempt = attempt
            return recycled
        }
        return { id, item, generation, expiresAt, attempt }
    }

    const recycleLease = (entry: LeasedEntry<T>): void => {
        // Do not retain completed payloads solely for object-shape reuse.
        entry.item = undefined as T
        if (leaseFreelist.length < LEASE_FREELIST_MAX) {
            leaseFreelist.push(entry)
        }
    }

    type QueueFullEvents = MergeEventMaps<QueueEvents<T>, PersistEvents>
    const emitter = buildEventEmitter<QueueFullEvents>()
    const { counts: subs, wrapOn } = createSubscriptionCounts({
        enqueued: 'queue:enqueued',
        dequeued: 'queue:dequeued',
        emptied: 'queue:emptied',
        cleared: 'queue:cleared',
        loaded: 'persist:loaded',
        leaseExpired: 'persist:lease-expired',
        idSpaceLow: 'persist:id-space-low',
        persistError: 'persist:error',
    })
    const on = wrapOn(emitter.on)

    let delayTimer: unknown
    let leaseTimer: unknown
    let hydrating = false

    const totalSize = (): number =>
        availableCount + delayedSize() + leased.size

    const assertNotFull = (extra = 1): void => {
        if (maxSize !== undefined && totalSize() + extra > maxSize) {
            throw new QueueFullError(maxSize)
        }
    }

    const flipAvailable = (): void => {
        availableOutItems = availableItems
        availableOutItems.reverse()
        availableItems = []
        if (trackAvailableIds) {
            availableOutIds = availableIds
            availableOutIds.reverse()
            availableIds = []
        }
        availableOutAttempts = availableAttempts
        availableOutAttempts.reverse()
        availableAttempts = []
    }

    /** Push ready item. `id` required when tracking available ids (durable). */
    const pushAvailable = (item: T, id?: number, attempt = 1): void => {
        availableItems.push(item)
        if (trackAvailableIds) {
            availableIds.push(id as number)
        }
        availableAttempts.push(attempt)
        availableCount += 1
    }

    const popAvailable = ():
        | { item: T; id: number | undefined; attempt: number }
        | undefined => {
        if (availableCount === 0) return undefined
        if (availableOutItems.length === 0) flipAvailable()
        const item = availableOutItems.pop() as T
        const id = trackAvailableIds
            ? (availableOutIds.pop() as number)
            : undefined
        const attempt = availableOutAttempts.pop() as number
        availableCount -= 1
        return { item, id, attempt }
    }

    const peekAvailable = ():
        | { item: T; id: number | undefined }
        | undefined => {
        if (availableCount === 0) return undefined
        if (availableOutItems.length > 0) {
            const i = availableOutItems.length - 1
            return {
                item: availableOutItems[i]!,
                id: trackAvailableIds ? availableOutIds[i] : undefined,
            }
        }
        return {
            item: availableItems[0]!,
            id: trackAvailableIds ? availableIds[0] : undefined,
        }
    }

    const emitEnqueued = (item: T): void => {
        if (subs.enqueued > 0) {
            emitter.emit('queue:enqueued', { item, size: totalSize() })
        }
    }

    const emitDequeued = (item: T): void => {
        if (subs.dequeued > 0) {
            emitter.emit('queue:dequeued', { item, size: totalSize() })
        }
        // Only compute size when emptied is observed (hot dequeue path).
        if (subs.emptied > 0 && totalSize() === 0) {
            emitter.emit('queue:emptied', undefined)
        }
    }

    const maybeWarnIdSpace = (): void => {
        if (ids.consumeLowWaterWarning() && subs.idSpaceLow > 0) {
            emitter.emit('persist:id-space-low', {
                remaining: Number.MAX_SAFE_INTEGER - ids.peek(),
            })
        }
    }

    const toRecord = (
        id: number,
        item: T,
        availableAt: number,
        generation: number | null,
        expiresAt: number | null,
        attempt = 1,
    ): RowRecord<T> => ({
        id,
        item,
        availableAt,
        leaseGeneration: generation,
        leaseExpiresAt: expiresAt,
        ...(attempt > 1 ? { attempt } : {}),
    })

    /** Serialize durable work; always runs `op` (inline path runs immediately). */
    const withChain = <R>(op: () => R | PromiseLike<R>): Promise<R> => {
        if (!durable || !chain) {
            return Promise.resolve(op())
        }
        // WriteChain returns the op result; no extra outer Promise wrapper.
        return chain.push(op)
    }

    const runStore = (op: () => void | PromiseLike<void>): Promise<void> =>
        withChain(op)

    const armDelayTimer = (): void => {
        if (delayTimer !== undefined) {
            cancelTimeout(delayTimer)
            delayTimer = undefined
        }
        if (delayed === undefined) return
        const next = delayed.peek()
        if (next === undefined) return
        const wait = Math.max(0, next.availableAt - nowMs())
        delayTimer = scheduleTimeout(() => {
            delayTimer = undefined
            promoteDueDelayed()
        }, wait)
    }

    const promoteDueDelayed = (): void => {
        if (delayed === undefined || delayed.size === 0) return
        const now = nowMs()
        let promoted = false
        for (;;) {
            const head = delayed.peek()
            if (head === undefined || head.availableAt > now) break
            delayed.pop()
            // Keep durable id when tracking; inline reuses id for delayed→available.
            pushAvailable(
                head.item,
                trackAvailableIds ? head.id : undefined,
                head.attempt,
            )
            promoted = true
        }
        armDelayTimer()
        if (promoted) {
            const head = peekAvailable()
            if (head !== undefined) emitEnqueued(head.item)
        }
    }

    const armLeaseTimer = (): void => {
        if (leaseTimer !== undefined) {
            cancelTimeout(leaseTimer)
            leaseTimer = undefined
        }
        if (leaseTtlMs === undefined) return
        if (leaseExpiries === undefined) return
        if (leased.size === 0) {
            leaseExpiries.clear()
            return
        }
        // Settled leases leave stale heap entries. Compact occasionally so a
        // long-lived lease cannot retain every short-lived lease beside it.
        if (leaseExpiries.size > leased.size * 2 + 64) {
            const live: LeaseExpiry[] = []
            for (const [id, entry] of leased) {
                if (entry.expiresAt !== null) {
                    live.push({
                        id,
                        generation: entry.generation,
                        expiresAt: entry.expiresAt,
                    })
                }
            }
            leaseExpiries.rebuild(live)
        }
        for (;;) {
            const head = leaseExpiries.peek()
            if (head === undefined) return
            const entry = leased.get(head.id)
            if (
                entry !== undefined &&
                entry.generation === head.generation &&
                entry.expiresAt === head.expiresAt
            ) {
                const wait = Math.max(0, head.expiresAt - nowMs())
                leaseTimer = scheduleTimeout(() => {
                    leaseTimer = undefined
                    void reclaimExpiredLeases()
                }, wait)
                return
            }
            leaseExpiries.pop()
        }
    }

    /** Reclaim one expired lease (must run on write chain when durable). */
    const reclaimOneExpired = async (
        id: number,
        entry: LeasedEntry<T>,
    ): Promise<void> => {
        const current = leased.get(id)
        if (
            current === undefined ||
            current.generation !== entry.generation
        ) {
            return
        }
        if (durable && store) {
            await store.put(
                toRecord(id, entry.item, 0, null, null, entry.attempt),
            )
        }
        // Re-check after await — another op may have settled this lease.
        const still = leased.get(id)
        if (
            still === undefined ||
            still.generation !== entry.generation
        ) {
            return
        }
        leased.delete(id)
        const item = entry.item
        recycleLease(entry)
        pushAvailable(item, trackAvailableIds ? id : undefined, entry.attempt)
        if (subs.leaseExpired > 0) {
            emitter.emit('persist:lease-expired', {
                id,
                item,
            })
        }
        emitEnqueued(item)
    }

    const reclaimExpiredLeases = async (): Promise<void> => {
        if (leaseTtlMs === undefined) return
        await withChain(async () => {
            const now = nowMs()
            if (leaseExpiries !== undefined) {
                for (;;) {
                    const head = leaseExpiries.peek()
                    if (head === undefined || head.expiresAt > now) break
                    leaseExpiries.pop()
                    const entry = leased.get(head.id)
                    if (
                        entry === undefined ||
                        entry.generation !== head.generation ||
                        entry.expiresAt !== head.expiresAt
                    ) {
                        continue
                    }
                    try {
                        await reclaimOneExpired(head.id, entry)
                    } catch (error) {
                        // Retain the expiry so a transient store failure retries.
                        leaseExpiries.push(head)
                        if (subs.persistError > 0) {
                            emitter.emit('persist:error', {
                                operation: 'put',
                                error,
                                id: head.id,
                            })
                        }
                        break
                    }
                }
            }
            armLeaseTimer()
        })
    }

    const clearMemory = (): void => {
        availableItems = []
        availableIds = []
        availableAttempts = []
        availableOutItems = []
        availableOutIds = []
        availableOutAttempts = []
        availableCount = 0
        leased.clear()
        leaseFreelist.length = 0
        delayed?.clear()
        leaseExpiries?.clear()
        if (delayTimer !== undefined) {
            cancelTimeout(delayTimer)
            delayTimer = undefined
        }
        if (leaseTimer !== undefined) {
            cancelTimeout(leaseTimer)
            leaseTimer = undefined
        }
    }

    const requireLease = (
        lease: Lease<T>,
    ): LeasedEntry<T> => {
        const entry = leased.get(lease.id)
        if (entry === undefined || entry.generation !== lease.generation) {
            throw new LeaseMismatchError()
        }
        return entry
    }

    /** Sync claim for inline path (and durable body of withChain). */
    const claimCore = async (): Promise<Lease<T> | undefined> => {
        promoteDueDelayed()
        if (leaseTtlMs !== undefined) {
            const now = nowMs()
            for (const [id, entry] of [...leased]) {
                if (entry.expiresAt !== null && entry.expiresAt <= now) {
                    await reclaimOneExpired(id, entry)
                }
            }
        }

        const head = popAvailable()
        if (head === undefined) return undefined

        const id = head.id ?? ids.next()
        if (head.id === undefined) maybeWarnIdSpace()
        const nextGen = nextLeaseGeneration()
        const expiresAt =
            leaseTtlMs !== undefined ? nowMs() + leaseTtlMs : null

        if (durable && store) {
            try {
                await store.put(
                    toRecord(
                        id,
                        head.item,
                        0,
                        nextGen,
                        expiresAt,
                        head.attempt,
                    ),
                )
            } catch (error) {
                pushAvailable(
                    head.item,
                    trackAvailableIds ? id : undefined,
                    head.attempt,
                )
                throw error
            }
        }

        const lease = allocLease(
            id,
            head.item,
            nextGen,
            expiresAt,
            head.attempt,
        )
        leased.set(id, lease)
        if (expiresAt !== null) {
            getLeaseExpiries().push({
                id,
                generation: nextGen,
                expiresAt,
            })
        }
        armLeaseTimer()
        return lease
    }

    const claimSync = (): Lease<T> | undefined => {
        // Inline only — no awaitable store / TTL reclaim await.
        // Fast empty check before delayed promotion / id work.
        if (availableCount === 0) {
            if (delayed === undefined || delayed.size === 0) return undefined
            promoteDueDelayed()
            if (availableCount === 0) return undefined
        }
        if (availableOutItems.length === 0) flipAvailable()
        const item = availableOutItems.pop() as T
        const attempt = availableOutAttempts.pop() as number
        availableCount -= 1
        // One monotonic counter serves as both row id and lease generation
        // (inline never reuses an id while a lease is live).
        const id = ids.next()
        const lease = allocLease(id, item, id, null, attempt)
        leased.set(id, lease)
        // Same object is the public Lease (one alloc, freelist on settle).
        return lease
    }

    const ackSync = (lease: Lease<T>): void => {
        const entry = leased.get(lease.id)
        if (entry === undefined || entry.generation !== lease.generation) {
            throw new LeaseMismatchError()
        }
        leased.delete(lease.id)
        recycleLease(entry)
    }

    const releaseSync = (lease: Lease<T>): void => {
        const entry = leased.get(lease.id)
        if (entry === undefined || entry.generation !== lease.generation) {
            throw new LeaseMismatchError()
        }
        leased.delete(lease.id)
        const item = entry.item
        recycleLease(entry)
        // Inline available has no stable ids.
        pushAvailable(item, undefined, entry.attempt)
        emitEnqueued(item)
    }

    const rescheduleSync = (
        lease: Lease<T>,
        next: { item: T; delayMs?: number; attempt?: number },
    ): void => {
        const entry = leased.get(lease.id)
        if (entry === undefined || entry.generation !== lease.generation) {
            throw new LeaseMismatchError()
        }
        const delayMs = next.delayMs ?? 0
        const availableAt = delayMs > 0 ? nowMs() + delayMs : 0
        const leaseId = lease.id
        const attempt = next.attempt ?? entry.attempt
        leased.delete(lease.id)
        recycleLease(entry)
        if (availableAt === 0) {
            pushAvailable(next.item, undefined, attempt)
            emitEnqueued(next.item)
        } else {
            getDelayed().push({
                id: leaseId,
                item: next.item,
                availableAt,
                attempt,
            })
            armDelayTimer()
        }
    }

    const enqueue = (item: T, opts?: { delayMs?: number }): Promise<void> => {
        // Hot path first: inline + immediate — no id, no Promise alloc.
        if (!durable && !hydrating && opts === undefined) {
            if (maxSize !== undefined && totalSize() >= maxSize) {
                return Promise.reject(new QueueFullError(maxSize))
            }
            pushAvailable(item)
            if (subs.enqueued > 0) {
                emitter.emit('queue:enqueued', { item, size: totalSize() })
            }
            return RESOLVED
        }

        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot enqueue while hydrate is in progress',
                ),
            )
        }
        const delayMs = opts?.delayMs ?? 0
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            return Promise.reject(
                new InvalidQueueOptionError(
                    'delayMs must be a finite number >= 0',
                ),
            )
        }

        try {
            assertNotFull(1)
        } catch (e) {
            return Promise.reject(e)
        }

        // Inline delayed/opts path without store.
        if (!durable && delayMs === 0) {
            pushAvailable(item)
            emitEnqueued(item)
            return RESOLVED
        }

        let id: number
        try {
            id = ids.next()
            maybeWarnIdSpace()
        } catch (e) {
            return Promise.reject(e)
        }

        const availableAt = delayMs > 0 ? nowMs() + delayMs : 0

        const applyMemory = (): void => {
            if (availableAt === 0) {
                pushAvailable(item, id)
            } else {
                getDelayed().push({ id, item, availableAt, attempt: 1 })
                armDelayTimer()
            }
            emitEnqueued(item)
        }

        if (!store) {
            applyMemory()
            return RESOLVED
        }

        return runStore(async () => {
            await store.put(
                toRecord(id, item, availableAt, null, null),
            )
            applyMemory()
        })
    }

    const claim = (): Promise<Lease<T> | undefined> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot claim while hydrate is in progress',
                ),
            )
        }
        if (!durable && leaseTtlMs === undefined) {
            const lease = claimSync()
            return lease === undefined
                ? (RESOLVED_UNDEFINED as Promise<undefined>)
                : Promise.resolve(lease)
        }
        return withChain(() => claimCore())
    }

    const ack = (lease: Lease<T>): Promise<void> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError('cannot ack while hydrate is in progress'),
            )
        }
        if (!durable) {
            try {
                ackSync(lease)
                return RESOLVED
            } catch (e) {
                return Promise.reject(e)
            }
        }
        return withChain(async () => {
            requireLease(lease)
            if (store) {
                await store.remove(lease.id)
            }
            const entry = leased.get(lease.id)
            if (
                entry === undefined ||
                entry.generation !== lease.generation
            ) {
                throw new LeaseMismatchError()
            }
            leased.delete(lease.id)
            recycleLease(entry)
            armLeaseTimer()
        })
    }

    const release = (lease: Lease<T>): Promise<void> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot release while hydrate is in progress',
                ),
            )
        }
        if (!durable) {
            try {
                releaseSync(lease)
                return RESOLVED
            } catch (e) {
                return Promise.reject(e)
            }
        }
        return withChain(async () => {
            const entry = requireLease(lease)
            if (store) {
                await store.put(
                    toRecord(
                        lease.id,
                        entry.item,
                        0,
                        null,
                        null,
                        entry.attempt,
                    ),
                )
            }
            const still = leased.get(lease.id)
            if (
                still === undefined ||
                still.generation !== lease.generation
            ) {
                throw new LeaseMismatchError()
            }
            const item = entry.item
            leased.delete(lease.id)
            recycleLease(entry)
            pushAvailable(item, lease.id, entry.attempt)
            armLeaseTimer()
            emitEnqueued(item)
        })
    }

    const reschedule = (
        lease: Lease<T>,
        next: { item: T; delayMs?: number; attempt?: number },
    ): Promise<void> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot reschedule while hydrate is in progress',
                ),
            )
        }
        const delayMs = next.delayMs ?? 0
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            return Promise.reject(
                new InvalidQueueOptionError(
                    'delayMs must be a finite number >= 0',
                ),
            )
        }
        if (!durable) {
            try {
                rescheduleSync(lease, next)
                return RESOLVED
            } catch (e) {
                return Promise.reject(e)
            }
        }
        const availableAt = delayMs > 0 ? nowMs() + delayMs : 0
        const item = next.item
        const attempt = next.attempt ?? lease.attempt

        return withChain(async () => {
            requireLease(lease)
            if (store) {
                await store.put(
                    toRecord(lease.id, item, availableAt, null, null, attempt),
                )
            }
            const still = leased.get(lease.id)
            if (
                still === undefined ||
                still.generation !== lease.generation
            ) {
                throw new LeaseMismatchError()
            }
            leased.delete(lease.id)
            recycleLease(still)
            if (availableAt === 0) {
                pushAvailable(item, lease.id, attempt)
                emitEnqueued(item)
            } else {
                getDelayed().push({ id: lease.id, item, availableAt, attempt })
                armDelayTimer()
            }
            armLeaseTimer()
        })
    }

    const tryDequeue = (): Promise<QueueSlot<T> | undefined> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot dequeue while hydrate is in progress',
                ),
            )
        }
        // Inline admin drop: two-stack pop, no chain.
        if (!durable) {
            if (availableCount === 0) {
                if (delayed !== undefined && delayed.size > 0) {
                    promoteDueDelayed()
                }
                if (availableCount === 0) {
                    return RESOLVED_UNDEFINED as Promise<undefined>
                }
            }
            if (availableOutItems.length === 0) flipAvailable()
            const item = availableOutItems.pop() as T
            availableOutAttempts.pop()
            availableCount -= 1
            emitDequeued(item)
            return Promise.resolve({ value: item })
        }
        return withChain(async () => {
            promoteDueDelayed()
            const head = popAvailable()
            if (head === undefined) return undefined
            const id = head.id as number
            try {
                await store!.remove(id)
            } catch (error) {
                pushAvailable(head.item, id, head.attempt)
                throw error
            }
            emitDequeued(head.item)
            return { value: head.item }
        })
    }

    const dequeue = (): Promise<T | undefined> => {
        // Inline: avoid async-function Promise + tryDequeue slot envelope.
        if (!durable && !hydrating) {
            if (availableCount === 0) {
                if (delayed !== undefined && delayed.size > 0) {
                    promoteDueDelayed()
                }
                if (availableCount === 0) {
                    return RESOLVED_UNDEFINED as Promise<undefined>
                }
            }
            if (availableOutItems.length === 0) flipAvailable()
            const item = availableOutItems.pop() as T
            availableOutAttempts.pop()
            availableCount -= 1
            if (subs.dequeued > 0) {
                emitter.emit('queue:dequeued', {
                    item,
                    size: totalSize(),
                })
            }
            if (subs.emptied > 0 && totalSize() === 0) {
                emitter.emit('queue:emptied', undefined)
            }
            return Promise.resolve(item)
        }
        return tryDequeue().then((slot) => slot?.value)
    }

    const tryPeek = (): QueueSlot<T> | undefined => {
        promoteDueDelayed()
        const head = peekAvailable()
        if (head === undefined) return undefined
        return { value: head.item }
    }

    const peek = (): T | undefined => tryPeek()?.value

    const size = (): number => totalSize()
    const readyCount = (): number => {
        promoteDueDelayed()
        return availableCount
    }
    const stats = (): QueueStats => {
        promoteDueDelayed()
        return {
            available: availableCount,
            delayed: delayedSize(),
            leased: leased.size,
        }
    }
    const isEmpty = (): boolean => totalSize() === 0

    const clear = (): Promise<void> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot clear while hydrate is in progress',
                ),
            )
        }
        const removed = totalSize()
        if (removed === 0 && !durable) return RESOLVED

        const applyMemory = (): void => {
            clearMemory()
            ids.reset()
            leaseGenSeq = 0
            if (removed > 0 && subs.cleared > 0) {
                emitter.emit('queue:cleared', { removed })
            }
        }

        if (!durable || !store) {
            applyMemory()
            return RESOLVED
        }

        return runStore(async () => {
            await store.clear()
            applyMemory()
        })
    }

    const replaceAll = (items: readonly T[]): Promise<void> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError(
                    'cannot replaceAll while hydrate is in progress',
                ),
            )
        }
        if (leased.size > 0) {
            return Promise.reject(new HydrateWhileActiveError())
        }
        if (maxSize !== undefined && items.length > maxSize) {
            return Promise.reject(new QueueFullError(maxSize))
        }

        if (!durable) {
            clearMemory()
            ids.reset()
            leaseGenSeq = 0
            // Inline rows have no stable available ids, so avoid allocating
            // durable RowRecord envelopes solely to rebuild the FIFO.
            for (let i = 0; i < items.length; i += 1) {
                pushAvailable(items[i]!)
            }
            availableCount = items.length
            return RESOLVED
        }

        const planned = new Array<RowRecord<T>>(items.length)
        for (let i = 0; i < items.length; i += 1) {
            planned[i] = toRecord(i + 1, items[i]!, 0, null, null)
        }

        const applyMemory = (): void => {
            clearMemory()
            ids.reset()
            leaseGenSeq = 0
            for (const rec of planned) {
                pushAvailable(rec.item, trackAvailableIds ? rec.id : undefined)
                if (trackAvailableIds) ids.fixup(rec.id)
            }
            if (!trackAvailableIds) {
                // Inline: no durable ids; keep counter ready for claim.
                ids.reset()
            }
        }

        if (!durable || !store) {
            applyMemory()
            return RESOLVED
        }

        return withChain(async () => {
            if (store.replaceAll) {
                await store.replaceAll(planned)
            } else {
                await store.clear()
                for (const rec of planned) {
                    await store.put(rec)
                }
            }
            applyMemory()
        })
    }

    const toArray = (): T[] => {
        promoteDueDelayed()
        const out: T[] = []
        if (availableOutItems.length > 0) {
            for (let i = availableOutItems.length - 1; i >= 0; i -= 1) {
                out.push(availableOutItems[i]!)
            }
        }
        for (let i = 0; i < availableItems.length; i += 1) {
            out.push(availableItems[i]!)
        }
        if (delayed !== undefined && delayed.size > 0) {
            const delayedList = delayed.toArray().sort((a, b) => {
                if (a.availableAt !== b.availableAt) {
                    return a.availableAt - b.availableAt
                }
                return a.id - b.id
            })
            for (const d of delayedList) out.push(d.item)
        }
        const leasedIds = [...leased.keys()].sort((a, b) => a - b)
        for (const id of leasedIds) out.push(leased.get(id)!.item)
        return out
    }

    const rowIds = (): number[] => {
        promoteDueDelayed()
        const out: number[] = []
        if (trackAvailableIds) {
            if (availableOutIds.length > 0) {
                for (let i = availableOutIds.length - 1; i >= 0; i -= 1) {
                    out.push(availableOutIds[i]!)
                }
            }
            for (let i = 0; i < availableIds.length; i += 1) {
                out.push(availableIds[i]!)
            }
        }
        // Inline available has no stable ids until claim; omit those.
        if (delayed !== undefined && delayed.size > 0) {
            const delayedList = delayed.toArray().sort((a, b) => {
                if (a.availableAt !== b.availableAt) {
                    return a.availableAt - b.availableAt
                }
                return a.id - b.id
            })
            for (const d of delayedList) out.push(d.id)
        }
        const leasedIds = [...leased.keys()].sort((a, b) => a - b)
        for (const id of leasedIds) out.push(id)
        return out
    }

    const flush = (): Promise<void> => {
        if (!chain) return RESOLVED
        return chain.flush()
    }

    const hydrate = async (): Promise<void> => {
        if (!durable || !store) return
        if (hydrating || leased.size > 0) {
            throw new HydrateWhileActiveError()
        }
        hydrating = true
        try {
            await flush()
            const loaded = await store.loadAll()
            const seen = new Set<number>()
            let maxId = 0
            for (const record of loaded) {
                if (!isSafeId(record.id)) {
                    throw new InvalidRowIdError(
                        `invalid row id: ${String(record.id)}`,
                    )
                }
                if (seen.has(record.id)) {
                    throw new DuplicateRowIdError(record.id)
                }
                seen.add(record.id)
                if (record.id > maxId) maxId = record.id
            }

            const now = nowMs()
            const availableRows: Array<
                Pick<RowRecord<T>, 'id' | 'item' | 'attempt'>
            > = []
            const delayedRows: DelayedEntry<T>[] = []

            for (const row of loaded) {
                const availableAt =
                    typeof row.availableAt === 'number' ? row.availableAt : 0
                if (row.leaseGeneration != null) {
                    const cleared = toRecord(
                        row.id,
                        row.item,
                        0,
                        null,
                        null,
                        row.attempt ?? 1,
                    )
                    // Persist recovery before replacing in-memory state.
                    await store.put(cleared)
                    availableRows.push(cleared)
                } else if (availableAt > now) {
                    delayedRows.push({
                        id: row.id,
                        item: row.item,
                        availableAt,
                        attempt: row.attempt ?? 1,
                    })
                } else {
                    availableRows.push(row)
                }
            }

            clearMemory()
            ids.reset()
            ids.fixup(maxId)
            leaseGenSeq = 0

            availableRows.sort((a, b) => a.id - b.id)
            for (const row of availableRows) {
                pushAvailable(row.item, row.id, row.attempt ?? 1)
            }
            for (const d of delayedRows) {
                getDelayed().push(d)
            }
            armDelayTimer()
            if (subs.loaded > 0) {
                emitter.emit('persist:loaded', { size: totalSize() })
            }
            if (availableCount > 0) {
                const head = peekAvailable()
                if (head) emitEnqueued(head.item)
            }
        } finally {
            hydrating = false
        }
    }

    const api: Queue<T, QueueFullEvents> = {
        enqueue,
        claim,
        ack,
        release,
        reschedule,
        dequeue,
        tryDequeue,
        peek,
        tryPeek,
        size,
        readyCount,
        stats,
        isEmpty,
        clear,
        replaceAll,
        toArray,
        rowIds,
        hydrate,
        flush,
        on,
        emit: emitter.emit,
    }

    const marked = markQueueName(markQueueMaxSize(api, maxSize), name)
    if (!durable && leaseTtlMs === undefined) {
        attachInlineOps(marked, {
            claimSync,
            ackSync,
            releaseSync,
            rescheduleSync,
        })
    }
    return marked
}
