import {
    buildEventEmitter,
    type EventCallback,
    type EventEmitter,
    type EventMap,
    type MergeEventMaps,
} from '../../events'
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
import {
    cancelTimeout,
    scheduleTimeout,
} from '../../util/schedule-timeout.util'
import { createIdCounter } from './id-counter.util'
import { createMinHeap, type MinHeap } from './min-heap.util'
import { markQueueMaxSize } from './queue-max-size.util'
import { markQueueName } from './queue-name.util'
import { isJob } from '../jobs/job'

export type QueueEvents<T> = {
    /** Fired when an item becomes available; hydrate and batch promotion may coalesce it. */
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
    /** Epoch deadline for this lease, or null when no lease TTL is configured. */
    expiresAt: number | null
    /** 1-based delivery attempt; older durable rows begin at 1. */
    attempt: number
    /**
     * DLQ handoff retry count. `0` (or omitted on older rows) means no handoff
     * is in progress; values `>= 1` count failed dead-letter enqueue attempts.
     */
    dlqHandoffAttempt?: number
}

export type QueueStats = {
    available: number
    delayed: number
    leased: number
}

/** A job-envelope row as seen by queue administration. */
export type QueueJob<T> = {
    /** Application-owned {@link Job.id}; numeric row ids stay internal. */
    id: string
    item: T
    state: 'ready' | 'delayed' | 'leased'
    attempt: number
    availableAt?: number
    leaseDeadline?: number
}

export type QueueJobPage<T> = {
    items: QueueJob<T>[]
    /** Pass this value as `cursor` to read the following page. */
    nextCursor?: number
}

export type ListJobsOptions = {
    state?: QueueJob<unknown>['state']
    cursor?: number
    limit?: number
}

/**
 * Envelope for an occupied queue slot (admin peek/dequeue).
 * Presence means “there was an item”; value may be nullish.
 */
export type QueueSlot<T> = {
    readonly value: T
}

/** In-memory lease row. Structurally a {@link Lease} plus optional TTL. */
type LeasedEntry<T> = {
    id: number
    item: T
    generation: number
    expiresAt: number | null
    attempt: number
    dlqHandoffAttempt?: number
}

type DelayedEntry<T> = {
    id: number
    item: T
    availableAt: number
    attempt: number
    dlqHandoffAttempt?: number
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
        next: {
            item: T
            delayMs?: number
            attempt?: number
            /** @internal Used by the DLQ handoff recovery path. */
            dlqHandoffAttempt?: number
        },
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
    /** Inspect one opt-in {@link Job} by its stable application id. */
    getJob: (id: string) => QueueJob<T> | undefined
    /** Page opt-in {@link Job} envelopes in ready, delayed, or leased state. */
    listJobs: (options?: ListJobsOptions) => QueueJobPage<T>
    /** Remove a ready or delayed job. Leased jobs are intentionally untouched. */
    cancelJob: (id: string) => Promise<boolean>
    /** Move a ready or delayed job to its next available time. */
    rescheduleJob: (id: string, delayMs: number) => Promise<boolean>
    /** Make a delayed job immediately claimable. */
    promoteJob: (id: string) => Promise<boolean>
    /** Enqueue a DLQ job on another queue, then remove its source row. */
    replayJob: (id: string, target: Pick<Queue<T>, 'enqueue'>) => Promise<boolean>
    hydrate: () => Promise<void>
    flush: () => Promise<void>
    /** @internal Used by decorators to avoid building unobserved payloads. */
    hasListeners?: (eventName: string) => boolean
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
const RESOLVED_VOID: Promise<void> = Promise.resolve()

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
    const chain = store === undefined ? undefined : createWriteChain()
    /** Durable queues keep available row ids; bare queues allocate on claim. */
    const trackAvailableIds = store !== undefined

    // In-memory state: available FIFO (+ optional ids) + leased + delayed.
    let availableItems: T[] = []
    let availableHead = 0
    // Bare queues do not need stable ids for ready items; avoid retaining a
    // parallel numeric array until a durable store actually requires it.
    let availableIds: number[] | undefined = trackAvailableIds ? [] : undefined
    // Attempts are implicitly 1 until a retry puts a non-default value in FIFO.
    let availableAttempts: number[] | undefined
    // DLQ handoff state is absent until a destination has actually failed.
    let availableDlqHandoffAttempts: number[] | undefined
    let availableRetryMetadataCount = 0
    let availableDlqMetadataCount = 0
    const AVAILABLE_COMPACT_MIN = 1024
    let hasAvailableMetadata = false
    let availableCount = 0
    const leased = new Map<number, LeasedEntry<T>>()
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
        dlqHandoffAttempt?: number,
    ): LeasedEntry<T> => {
        const lease: LeasedEntry<T> = {
            id,
            item,
            generation,
            expiresAt,
            attempt,
        }
        // The common lease shape does not need a DLQ field. Add it only while
        // handoff recovery is active so ordinary in-flight jobs retain less.
        if (dlqHandoffAttempt !== undefined && dlqHandoffAttempt > 0) {
            lease.dlqHandoffAttempt = dlqHandoffAttempt
        }
        return lease
    }

    /** Map 0 / absent to `undefined` for store and available metadata. */
    const activeDlqHandoff = (
        value: number | undefined,
    ): number | undefined =>
        value !== undefined && value > 0 ? value : undefined

    type QueueFullEvents = MergeEventMaps<QueueEvents<T>, PersistEvents>
    const emitter = buildEventEmitter<QueueFullEvents>()
    const listenerCounts = new Map<keyof QueueFullEvents, number>()
    const on = <K extends keyof QueueFullEvents>(
        eventName: K,
        callback: EventCallback<QueueFullEvents[K]>,
    ): (() => void) => {
        const unsubscribe = emitter.on(eventName, callback)
        listenerCounts.set(eventName, (listenerCounts.get(eventName) ?? 0) + 1)
        let active = true
        return () => {
            if (!active) return
            active = false
            const count = listenerCounts.get(eventName) ?? 0
            if (count <= 1) listenerCounts.delete(eventName)
            else listenerCounts.set(eventName, count - 1)
            unsubscribe()
        }
    }
    const hasListeners = (eventName: string): boolean =>
        (listenerCounts.get(eventName as keyof QueueFullEvents) ?? 0) > 0

    let delayTimer: unknown
    let delayTimerAt: number | undefined
    let leaseTimer: unknown
    let hydrating = false

    const totalSize = (): number =>
        availableCount + delayedSize() + leased.size

    const assertNotFull = (extra = 1): void => {
        if (maxSize !== undefined && totalSize() + extra > maxSize) {
            throw new QueueFullError(maxSize)
        }
    }

    const materializeAvailableAttempts = (): void => {
        if (availableAttempts !== undefined) return
        availableAttempts = new Array<number>(availableItems.length).fill(1)
    }

    const materializeAvailableDlqHandoffAttempts = (): void => {
        if (availableDlqHandoffAttempts !== undefined) return
        availableDlqHandoffAttempts = new Array<number>(availableItems.length).fill(0)
    }

    const releaseAvailableMetadata = (): void => {
        if (availableRetryMetadataCount === 0) {
            availableAttempts = undefined
        }
        if (availableDlqMetadataCount === 0) {
            availableDlqHandoffAttempts = undefined
        }
        hasAvailableMetadata =
            availableAttempts !== undefined ||
            availableDlqHandoffAttempts !== undefined
    }

    /** Drop consumed slots and occasionally compact the head-index FIFO. */
    const compactAvailable = (): void => {
        if (availableHead === 0) return
        if (availableCount === 0) {
            availableItems = []
            availableIds = trackAvailableIds ? [] : undefined
            availableHead = 0
            if (availableAttempts !== undefined) availableAttempts = []
            if (availableDlqHandoffAttempts !== undefined) {
                availableDlqHandoffAttempts = []
            }
            availableRetryMetadataCount = 0
            availableDlqMetadataCount = 0
            hasAvailableMetadata = false
            return
        }
        if (
            availableHead < AVAILABLE_COMPACT_MIN ||
            availableHead * 2 < availableItems.length
        ) {
            return
        }
        availableItems = availableItems.slice(availableHead)
        if (trackAvailableIds) availableIds = availableIds!.slice(availableHead)
        if (availableAttempts !== undefined) {
            availableAttempts = availableAttempts.slice(availableHead)
        }
        if (availableDlqHandoffAttempts !== undefined) {
            availableDlqHandoffAttempts =
                availableDlqHandoffAttempts.slice(availableHead)
        }
        availableHead = 0
    }

    const consumeAvailableSlot = (): void => {
        // Clear the payload immediately; a large drained prefix must not retain
        // completed work until another enqueue happens.
        const index = availableHead
        availableItems[index] = undefined as T
        if (trackAvailableIds) availableIds![index] = 0
        if (availableAttempts?.[index] !== undefined) {
            if (availableAttempts[index]! > 1) availableRetryMetadataCount -= 1
            availableAttempts[index] = 1
        }
        if (availableDlqHandoffAttempts?.[index] !== undefined) {
            if (availableDlqHandoffAttempts[index]! > 0) {
                availableDlqMetadataCount -= 1
            }
            availableDlqHandoffAttempts[index] = 0
        }
        availableHead += 1
        availableCount -= 1
        releaseAvailableMetadata()
        if (
            availableCount === 0 ||
            (availableHead >= AVAILABLE_COMPACT_MIN &&
                availableHead * 2 >= availableItems.length)
        ) {
            compactAvailable()
        }
    }

    /** Push ready item. `id` required when tracking available ids (durable). */
    const pushAvailable = (
        item: T,
        id?: number,
        attempt = 1,
        dlqHandoffAttempt?: number,
    ): void => {
        if (
            availableHead >= AVAILABLE_COMPACT_MIN &&
            availableHead * 2 >= availableItems.length
        ) {
            compactAvailable()
        }
        const handoff = activeDlqHandoff(dlqHandoffAttempt)
        // Keep the common path free of metadata arrays.
        if (!hasAvailableMetadata && attempt === 1 && handoff === undefined) {
            availableItems.push(item)
            if (trackAvailableIds) {
                availableIds!.push(id as number)
            }
            availableCount += 1
            return
        }
        hasAvailableMetadata = true
        if (attempt !== 1) materializeAvailableAttempts()
        if (handoff !== undefined) {
            materializeAvailableDlqHandoffAttempts()
        }
        availableItems.push(item)
        if (trackAvailableIds) {
            availableIds!.push(id as number)
        }
        availableAttempts?.push(attempt)
        availableDlqHandoffAttempts?.push(handoff ?? 0)
        if (attempt !== 1) availableRetryMetadataCount += 1
        if (handoff !== undefined) availableDlqMetadataCount += 1
        availableCount += 1
    }

    const popAvailable = ():
        | {
              item: T
              id: number | undefined
              attempt: number
              dlqHandoffAttempt?: number
          }
        | undefined => {
        if (availableCount === 0) return undefined
        const index = availableHead
        const item = availableItems[index] as T
        const id = trackAvailableIds
            ? (availableIds![index] as number)
            : undefined
        const attempt = availableAttempts?.[index] ?? 1
        const dlqHandoffAttempt = availableDlqHandoffAttempts === undefined
            ? undefined
            : availableDlqHandoffAttempts[index]
        consumeAvailableSlot()
        return dlqHandoffAttempt !== undefined && dlqHandoffAttempt > 0
            ? { item, id, attempt, dlqHandoffAttempt }
            : { item, id, attempt }
    }

    const peekAvailable = ():
        | { item: T; id: number | undefined }
        | undefined => {
        if (availableCount === 0) return undefined
        return {
            item: availableItems[availableHead]!,
            id: trackAvailableIds ? availableIds![availableHead] : undefined,
        }
    }

    /** Remove one ready slot without rebuilding the entire FIFO. */
    const removeAvailableAt = (index: number): void => {
        if (index < availableHead || index >= availableItems.length) return
        if (availableAttempts?.[index] !== undefined) {
            if (availableAttempts[index]! > 1) availableRetryMetadataCount -= 1
            availableAttempts.splice(index, 1)
        }
        if (availableDlqHandoffAttempts?.[index] !== undefined) {
            if (availableDlqHandoffAttempts[index]! > 0) {
                availableDlqMetadataCount -= 1
            }
            availableDlqHandoffAttempts.splice(index, 1)
        }
        availableItems.splice(index, 1)
        if (trackAvailableIds) availableIds!.splice(index, 1)
        availableCount -= 1
        releaseAvailableMetadata()
        if (
            availableCount === 0 ||
            (availableHead >= AVAILABLE_COMPACT_MIN &&
                availableHead * 2 >= availableItems.length)
        ) {
            compactAvailable()
        }
    }

    const emitEnqueued = (item: T): void => {
        if (!hasListeners('queue:enqueued')) return
        emitter.emit('queue:enqueued', { item, size: totalSize() })
    }

    const emitDequeued = (item: T): void => {
        if (hasListeners('queue:dequeued')) {
            emitter.emit('queue:dequeued', { item, size: totalSize() })
        }
        if (totalSize() === 0) {
            if (hasListeners('queue:emptied')) {
                emitter.emit('queue:emptied', undefined)
            }
        }
    }

    const maybeWarnIdSpace = (): void => {
        if (ids.consumeLowWaterWarning()) {
            if (hasListeners('persist:id-space-low')) {
                emitter.emit('persist:id-space-low', {
                    remaining: Number.MAX_SAFE_INTEGER - ids.peek(),
                })
            }
        }
    }

    const toRecord = (
        id: number,
        item: T,
        availableAt: number,
        generation: number | null,
        expiresAt: number | null,
        attempt = 1,
        dlqHandoffAttempt?: number,
    ): RowRecord<T> => {
        const handoff = activeDlqHandoff(dlqHandoffAttempt)
        return {
            id,
            item,
            availableAt,
            leaseGeneration: generation,
            leaseExpiresAt: expiresAt,
            ...(attempt > 1 ? { attempt } : {}),
            ...(handoff !== undefined ? { dlqHandoffAttempt: handoff } : {}),
        }
    }

    /** Serialize durable work; bare queues apply the operation immediately. */
    const withChain = <R>(op: () => R | PromiseLike<R>): Promise<R> => {
        if (!chain) {
            return Promise.resolve(op())
        }
        // WriteChain returns the op result; no extra outer Promise wrapper.
        return chain.push(op)
    }

    const callStore = async <R>(
        operation: 'load' | 'put' | 'remove' | 'clear' | 'replace',
        id: number | undefined,
        op: () => R | PromiseLike<R>,
    ): Promise<R> => {
        const startedAt = nowMs()
        let result: R
        try {
            result = await op()
        } catch (error) {
            if (hasListeners('persist:error')) {
                emitter.emit('persist:error', {
                    operation,
                    error,
                    ...(id !== undefined ? { id } : {}),
                })
            }
            throw error
        }
        if (hasListeners('persist:operation')) {
            emitter.emit('persist:operation', {
                operation,
                durationMs: Math.max(0, nowMs() - startedAt),
                ...(id !== undefined ? { id } : {}),
            })
        }
        return result
    }

    const armDelayTimer = (): void => {
        if (delayed === undefined) {
            if (delayTimer !== undefined) cancelTimeout(delayTimer)
            delayTimer = undefined
            delayTimerAt = undefined
            return
        }
        const next = delayed.peek()
        if (next === undefined) {
            if (delayTimer !== undefined) cancelTimeout(delayTimer)
            delayTimer = undefined
            delayTimerAt = undefined
            return
        }
        if (delayTimer !== undefined && delayTimerAt === next.availableAt) {
            return
        }
        if (delayTimer !== undefined) cancelTimeout(delayTimer)
        delayTimer = undefined
        delayTimerAt = next.availableAt
        const wait = Math.max(0, next.availableAt - nowMs())
        delayTimer = scheduleTimeout(() => {
            delayTimer = undefined
            delayTimerAt = undefined
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
            // Retain the row id when storage is tracking available rows.
            pushAvailable(
                head.item,
                trackAvailableIds ? head.id : undefined,
                head.attempt,
                head.dlqHandoffAttempt,
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
        if (store) {
            await callStore('put', id, () => store.put(
                toRecord(
                    id,
                    entry.item,
                    0,
                    null,
                    null,
                    entry.attempt,
                    entry.dlqHandoffAttempt,
                ),
            ))
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
        const attempt = entry.attempt
        const dlqHandoffAttempt = activeDlqHandoff(entry.dlqHandoffAttempt)
        pushAvailable(
            item,
            trackAvailableIds ? id : undefined,
            attempt,
            dlqHandoffAttempt,
        )
        if (hasListeners('persist:lease-expired')) {
            emitter.emit('persist:lease-expired', { id, item })
        }
        emitEnqueued(item)
    }

    const reclaimExpiredLeasesCore = async (
        suppressStoreErrors: boolean,
    ): Promise<void> => {
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
                    if (!suppressStoreErrors) throw error
                    break
                }
            }
        }
        armLeaseTimer()
    }

    const reclaimExpiredLeases = async (): Promise<void> => {
        if (leaseTtlMs === undefined) return
        await withChain(() => reclaimExpiredLeasesCore(true))
    }

    const clearMemory = (): void => {
        availableItems = []
        availableHead = 0
        availableIds = trackAvailableIds ? [] : undefined
        availableAttempts = undefined
        availableDlqHandoffAttempts = undefined
        availableRetryMetadataCount = 0
        availableDlqMetadataCount = 0
        hasAvailableMetadata = false
        availableCount = 0
        leased.clear()
        delayed?.clear()
        leaseExpiries?.clear()
        if (delayTimer !== undefined) {
            cancelTimeout(delayTimer)
            delayTimer = undefined
        }
        delayTimerAt = undefined
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

    /** Claim one available row and persist the lease when a store is present. */
    const claimCore = async (): Promise<Lease<T> | undefined> => {
        promoteDueDelayed()
        if (leaseTtlMs !== undefined) await reclaimExpiredLeasesCore(false)

        const head = popAvailable()
        if (head === undefined) return undefined

        const id = head.id ?? ids.next()
        if (head.id === undefined) maybeWarnIdSpace()
        const nextGen = nextLeaseGeneration()
        const expiresAt =
            leaseTtlMs !== undefined ? nowMs() + leaseTtlMs : null

        if (store) {
            try {
                await callStore('put', id, () => store.put(
                    toRecord(
                        id,
                        head.item,
                        0,
                        nextGen,
                        expiresAt,
                        head.attempt,
                        head.dlqHandoffAttempt,
                    ),
                ))
            } catch (error) {
                pushAvailable(
                    head.item,
                    trackAvailableIds ? id : undefined,
                    head.attempt,
                    head.dlqHandoffAttempt,
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
            head.dlqHandoffAttempt,
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

    const applyEnqueueMemory = (
        item: T,
        id: number,
        availableAt: number,
    ): void => {
        if (availableAt === 0) {
            pushAvailable(item, trackAvailableIds ? id : undefined)
        } else {
            getDelayed().push({ id, item, availableAt, attempt: 1 })
            armDelayTimer()
        }
        emitEnqueued(item)
    }

    const enqueue = (item: T, opts?: { delayMs?: number }): Promise<void> => {
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

        if (!chain) {
            try {
                assertNotFull(1)
            } catch (e) {
                return Promise.reject(e)
            }
        }

        let id: number
        try {
            id = ids.next()
            maybeWarnIdSpace()
        } catch (e) {
            return Promise.reject(e)
        }

        const availableAt = delayMs > 0 ? nowMs() + delayMs : 0

        if (!chain) {
            try {
                applyEnqueueMemory(item, id, availableAt)
                return RESOLVED_VOID
            } catch (error) {
                return Promise.reject(error)
            }
        }

        return withChain(async () => {
            assertNotFull(1)
            await callStore('put', id, () => store!.put(
                toRecord(id, item, availableAt, null, null),
            ))
            applyEnqueueMemory(item, id, availableAt)
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
        return withChain(() => claimCore())
    }

    const ack = (lease: Lease<T>): Promise<void> => {
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError('cannot ack while hydrate is in progress'),
            )
        }
        return withChain(async () => {
            requireLease(lease)
            if (store) {
                await callStore('remove', lease.id, () => store.remove(lease.id))
            }
            const entry = leased.get(lease.id)
            if (
                entry === undefined ||
                entry.generation !== lease.generation
            ) {
                throw new LeaseMismatchError()
            }
            leased.delete(lease.id)
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
        return withChain(async () => {
            const entry = requireLease(lease)
            if (store) {
                await callStore('put', lease.id, () => store.put(
                    toRecord(
                        lease.id,
                        entry.item,
                        0,
                        null,
                        null,
                        entry.attempt,
                        entry.dlqHandoffAttempt,
                    ),
                ))
            }
            const still = leased.get(lease.id)
            if (
                still === undefined ||
                still.generation !== lease.generation
            ) {
                throw new LeaseMismatchError()
            }
            const item = entry.item
            const handoff = activeDlqHandoff(entry.dlqHandoffAttempt)
            leased.delete(lease.id)
            pushAvailable(
                item,
                trackAvailableIds ? lease.id : undefined,
                entry.attempt,
                handoff,
            )
            armLeaseTimer()
            emitEnqueued(item)
        })
    }

    const reschedule = (
        lease: Lease<T>,
        next: { item: T; delayMs?: number; attempt?: number; dlqHandoffAttempt?: number },
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
        const availableAt = delayMs > 0 ? nowMs() + delayMs : 0
        const item = next.item
        const attempt = next.attempt ?? lease.attempt
        const dlqHandoffAttempt = activeDlqHandoff(
            next.dlqHandoffAttempt ?? lease.dlqHandoffAttempt,
        )

        return withChain(async () => {
            requireLease(lease)
            if (store) {
                await callStore('put', lease.id, () => store.put(
                    toRecord(
                        lease.id,
                        item,
                        availableAt,
                        null,
                        null,
                        attempt,
                        dlqHandoffAttempt,
                    ),
                ))
            }
            const still = leased.get(lease.id)
            if (
                still === undefined ||
                still.generation !== lease.generation
            ) {
                throw new LeaseMismatchError()
            }
            leased.delete(lease.id)
            if (availableAt === 0) {
                pushAvailable(
                    item,
                    trackAvailableIds ? lease.id : undefined,
                    attempt,
                    dlqHandoffAttempt,
                )
                emitEnqueued(item)
            } else {
                getDelayed().push({
                    id: lease.id,
                    item,
                    availableAt,
                    attempt,
                    ...(dlqHandoffAttempt !== undefined
                        ? { dlqHandoffAttempt }
                        : {}),
                })
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
        return withChain(async () => {
            promoteDueDelayed()
            const head = popAvailable()
            if (head === undefined) return undefined
            if (store) {
                const id = head.id as number
                try {
                    await callStore('remove', id, () => store.remove(id))
                } catch (error) {
                    pushAvailable(
                        head.item,
                        id,
                        head.attempt,
                        head.dlqHandoffAttempt,
                    )
                    throw error
                }
            }
            emitDequeued(head.item)
            return { value: head.item }
        })
    }

    const dequeue = (): Promise<T | undefined> => {
        return tryDequeue().then((slot) => slot?.value)
    }

    const tryPeek = (): QueueSlot<T> | undefined => {
        promoteDueDelayed()
        if (availableCount === 0) return undefined
        return { value: availableItems[availableHead]! }
    }

    const peek = (): T | undefined => {
        promoteDueDelayed()
        return availableCount === 0
            ? undefined
            : availableItems[availableHead]
    }

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

        const applyMemory = (): void => {
            clearMemory()
            ids.reset()
            leaseGenSeq = 0
            if (removed > 0) {
                if (hasListeners('queue:cleared')) {
                    emitter.emit('queue:cleared', { removed })
                }
            }
        }

        return withChain(async () => {
            if (store) {
                await callStore('clear', undefined, () => store.clear())
            }
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
        if (maxSize !== undefined && items.length > maxSize) {
            return Promise.reject(new QueueFullError(maxSize))
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
        }

        return withChain(async () => {
            if (leased.size > 0) {
                throw new HydrateWhileActiveError()
            }
            if (store) {
                if (store.replaceAll) {
                    await callStore('replace', undefined, () => store.replaceAll!(planned))
                } else {
                    await callStore('clear', undefined, () => store.clear())
                    for (const rec of planned) {
                        await callStore('put', rec.id, () => store.put(rec))
                    }
                }
            }
            applyMemory()
        })
    }

    const toArray = (): T[] => {
        promoteDueDelayed()
        const out: T[] = []
        for (let i = availableHead; i < availableItems.length; i += 1) {
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
            for (let i = availableHead; i < availableIds!.length; i += 1) {
                out.push(availableIds![i]!)
            }
        }
        // Bare available rows have no stable ids until claim; omit those.
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

    type ReadyEntry = {
        item: T
        id: number | undefined
        attempt: number
        dlqHandoffAttempt?: number
    }

    const requireApplicationId = (id: string): string => {
        if (typeof id !== 'string' || id.trim() === '') {
            throw new InvalidQueueOptionError(
                'job id must be a non-empty string',
            )
        }
        return id.trim()
    }

    const makeJobView = (
        item: T,
        state: QueueJob<T>['state'],
        attempt: number,
        availableAt?: number,
        leaseDeadline?: number,
    ): QueueJob<T> | undefined => {
        if (!isJob(item)) return undefined
        return {
            id: item.id,
            item,
            state,
            attempt,
            ...(availableAt !== undefined ? { availableAt } : {}),
            ...(leaseDeadline !== undefined ? { leaseDeadline } : {}),
        }
    }

    const getJob = (id: string): QueueJob<T> | undefined => {
        const applicationId = requireApplicationId(id)
        promoteDueDelayed()
        for (let i = availableHead; i < availableItems.length; i += 1) {
            const item = availableItems[i]!
            if (isJob(item) && item.id === applicationId) {
                return makeJobView(
                    item,
                    'ready',
                    availableAttempts?.[i] ?? 1,
                )
            }
        }
        const delayedJob = delayed?.find(
            (entry) => isJob(entry.item) && entry.item.id === applicationId,
        )
        if (delayedJob !== undefined) {
            const job = makeJobView(
                delayedJob.item,
                'delayed',
                delayedJob.attempt,
                delayedJob.availableAt,
            )
            if (job) return job
        }
        for (const entry of leased.values()) {
            if (isJob(entry.item) && entry.item.id === applicationId) {
                return makeJobView(
                    entry.item,
                    'leased',
                    entry.attempt,
                    undefined,
                    entry.expiresAt ?? undefined,
                )
            }
        }
        return undefined
    }

    const listJobs = (options: ListJobsOptions = {}): QueueJobPage<T> => {
        const cursor = options.cursor ?? 0
        const limit = options.limit ?? 100
        if (!isIntegerInRange(cursor, 0)) {
            throw new InvalidQueueOptionError('cursor must be a safe integer >= 0')
        }
        if (!isIntegerInRange(limit, 1)) {
            throw new InvalidQueueOptionError('limit must be a safe integer >= 1')
        }
        promoteDueDelayed()
        // Keep one look-ahead item, but do not materialize the entire queue.
        // The numeric cursor remains backwards compatible; each page now
        // allocates at most `limit + 1` job views.
        const needed = Math.min(Number.MAX_SAFE_INTEGER, cursor + limit + 1)
        const collected: QueueJob<T>[] = []
        let skipped = 0
        const collect = (job: QueueJob<T> | undefined): boolean => {
            if (job === undefined) return collected.length < needed
            if (skipped < cursor) {
                skipped += 1
                return true
            }
            collected.push(job)
            return collected.length < needed
        }

        if (options.state === undefined || options.state === 'ready') {
            for (let i = availableHead; i < availableItems.length; i += 1) {
                if (
                    !collect(
                        makeJobView(
                            availableItems[i]!,
                            'ready',
                            availableAttempts?.[i] ?? 1,
                        ),
                    )
                ) break
            }
        }
        if (
            collected.length < needed &&
            (options.state === undefined || options.state === 'delayed')
        ) {
            const entries = (delayed?.toArray() ?? []).sort((a, b) => {
                if (a.availableAt !== b.availableAt) {
                    return a.availableAt - b.availableAt
                }
                return a.id - b.id
            })
            for (const entry of entries) {
                if (
                    !collect(
                        makeJobView(
                            entry.item,
                            'delayed',
                            entry.attempt,
                            entry.availableAt,
                        ),
                    )
                ) break
            }
        }
        if (
            collected.length < needed &&
            (options.state === undefined || options.state === 'leased')
        ) {
            const entries = [...leased.values()].sort((a, b) => a.id - b.id)
            for (const entry of entries) {
                if (
                    !collect(
                        makeJobView(
                            entry.item,
                            'leased',
                            entry.attempt,
                            undefined,
                            entry.expiresAt ?? undefined,
                        ),
                    )
                ) break
            }
        }

        const items = collected.slice(0, limit)
        const next = cursor + items.length
        return {
            items,
            ...(collected.length > items.length ? { nextCursor: next } : {}),
        }
    }

    const locatePendingJob = (id: string):
        | { state: 'ready'; index: number; entry: ReadyEntry }
        | { state: 'delayed'; entry: DelayedEntry<T> }
        | undefined => {
        for (let i = availableHead; i < availableItems.length; i += 1) {
            const item = availableItems[i]!
            if (isJob(item) && item.id === id) {
                return {
                    state: 'ready',
                    index: i,
                    entry: {
                        item,
                        id: trackAvailableIds ? availableIds![i] : undefined,
                        attempt: availableAttempts?.[i] ?? 1,
                        ...(availableDlqHandoffAttempts?.[i]
                            ? { dlqHandoffAttempt: availableDlqHandoffAttempts[i] }
                            : {}),
                    },
                }
            }
        }
        const delayedEntry = delayed?.find(
            (entry) => isJob(entry.item) && entry.item.id === id,
        )
        if (delayedEntry !== undefined) {
            return { state: 'delayed', entry: delayedEntry }
        }
        return undefined
    }

    const removePendingJob = (found: NonNullable<ReturnType<typeof locatePendingJob>>): void => {
        if (found.state === 'ready') {
            removeAvailableAt(found.index)
            return
        }
        delayed?.remove(found.entry)
        armDelayTimer()
    }

    const cancelJob = (id: string): Promise<boolean> => {
        const applicationId = requireApplicationId(id)
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError('cannot cancel while hydrate is in progress'),
            )
        }
        return withChain(async () => {
            const found = locatePendingJob(applicationId)
            if (!found) return false
            const rowId = found.entry.id
            if (store && rowId !== undefined) {
                await callStore('remove', rowId, () => store!.remove(rowId))
            }
            removePendingJob(found)
            return true
        })
    }

    const rescheduleJob = (id: string, delayMs: number): Promise<boolean> => {
        const applicationId = requireApplicationId(id)
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            return Promise.reject(
                new InvalidQueueOptionError('delayMs must be a finite number >= 0'),
            )
        }
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError('cannot reschedule while hydrate is in progress'),
            )
        }
        return withChain(async () => {
            const found = locatePendingJob(applicationId)
            if (!found) return false
            const availableAt = delayMs > 0 ? nowMs() + delayMs : 0
            const rowId =
                found.entry.id ?? (availableAt > 0 || store ? ids.next() : 0)
            const next: DelayedEntry<T> = {
                id: rowId,
                item: found.entry.item,
                availableAt,
                attempt: found.entry.attempt,
                ...(found.entry.dlqHandoffAttempt !== undefined
                    ? { dlqHandoffAttempt: found.entry.dlqHandoffAttempt }
                    : {}),
            }
            if (store) {
                await callStore('put', rowId, () => store!.put(
                    toRecord(
                        rowId,
                        next.item,
                        availableAt,
                        null,
                        null,
                        next.attempt,
                        next.dlqHandoffAttempt,
                    ),
                ))
            }
            removePendingJob(found)
            if (availableAt === 0) {
                pushAvailable(
                    next.item,
                    trackAvailableIds ? rowId : undefined,
                    next.attempt,
                    next.dlqHandoffAttempt,
                )
                emitEnqueued(next.item)
            } else {
                getDelayed().push(next)
                armDelayTimer()
            }
            return true
        })
    }

    const promoteJob = (id: string): Promise<boolean> => {
        const applicationId = requireApplicationId(id)
        if (hydrating) {
            return Promise.reject(
                new HydrateWhileActiveError('cannot promote while hydrate is in progress'),
            )
        }
        return withChain(async () => {
            const found = locatePendingJob(applicationId)
            if (!found || found.state !== 'delayed') return false
            if (store) {
                await callStore('put', found.entry.id, () => store!.put(
                    toRecord(
                        found.entry.id,
                        found.entry.item,
                        0,
                        null,
                        null,
                        found.entry.attempt,
                        found.entry.dlqHandoffAttempt,
                    ),
                ))
            }
            removePendingJob(found)
            pushAvailable(
                found.entry.item,
                trackAvailableIds ? found.entry.id : undefined,
                found.entry.attempt,
                found.entry.dlqHandoffAttempt,
            )
            emitEnqueued(found.entry.item)
            return true
        })
    }

    const replayJob = (
        id: string,
        target: Pick<Queue<T>, 'enqueue'>,
    ): Promise<boolean> => {
        const applicationId = requireApplicationId(id)
        if ((target as object) === api || target.enqueue === enqueue) {
            return Promise.reject(
                new InvalidQueueOptionError('replay target must differ from source queue'),
            )
        }
        const found = locatePendingJob(applicationId)
        if (!found) return Promise.resolve(false)
        // Cross-queue replay is deliberately enqueue-first, so a crash may
        // duplicate work but never silently loses a dead-letter row.
        return Promise.resolve(target.enqueue(found.entry.item)).then(() =>
            cancelJob(applicationId),
        )
    }

    const flush = (): Promise<void> => {
        if (!chain) return Promise.resolve()
        return chain.flush()
    }

    const hydrate = async (): Promise<void> => {
        if (!store) return
        if (hydrating || leased.size > 0) {
            throw new HydrateWhileActiveError()
        }
        hydrating = true
        try {
            await flush()
            // A claim already queued before hydration may have completed while
            // flush drained the write chain. Re-check after the await so we
            // never reclaim an active in-process lease.
            if (leased.size > 0) {
                throw new HydrateWhileActiveError()
            }
            const loaded = await callStore('load', undefined, () => store.loadAll())
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
                Pick<RowRecord<T>, 'id' | 'item' | 'attempt' | 'dlqHandoffAttempt'>
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
                        row.dlqHandoffAttempt,
                    )
                    // Persist recovery before replacing in-memory state.
                    await callStore('put', cleared.id, () => store.put(cleared))
                    availableRows.push(cleared)
                } else if (availableAt > now) {
                    delayedRows.push({
                        id: row.id,
                        item: row.item,
                        availableAt,
                        attempt: row.attempt ?? 1,
                        ...(row.dlqHandoffAttempt !== undefined
                            ? { dlqHandoffAttempt: row.dlqHandoffAttempt }
                            : {}),
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
                pushAvailable(
                    row.item,
                    row.id,
                    row.attempt ?? 1,
                    row.dlqHandoffAttempt,
                )
            }
            for (const d of delayedRows) {
                getDelayed().push(d)
            }
            armDelayTimer()
            if (hasListeners('persist:loaded')) {
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
        getJob,
        listJobs,
        cancelJob,
        rescheduleJob,
        promoteJob,
        replayJob,
        hydrate,
        flush,
        hasListeners,
        on,
        emit: emitter.emit,
    }

    return markQueueName(markQueueMaxSize(api, maxSize), name)
}
