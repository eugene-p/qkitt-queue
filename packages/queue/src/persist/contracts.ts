/**
 * Public persist contracts: row records and store interfaces.
 * No queue-implementation imports — types only.
 */

/**
 * Durable row: stable numeric id + payload + claim/delay lease fields.
 * `availableAt === 0` means immediately claimable (no wall-clock on hot path).
 */
export type RowRecord<T> = {
    id: number
    item: T
    /** Earliest claim time (ms epoch), or `0` for immediate. */
    availableAt: number
    /** Non-null while a worker owns the row; bumped on each claim. */
    leaseGeneration: number | null
    /** Absolute lease deadline when TTL is configured; otherwise null. */
    leaseExpiresAt: number | null
    /** 1-based delivery attempt; omitted rows start at 1. */
    attempt?: number
    /** DLQ handoff attempts; omitted until a destination enqueue has failed. */
    dlqHandoffAttempt?: number
}

/**
 * Row-level backend. `loadAll` returns all rows (any order; queue rebuilds
 * FIFO from id order of available heads). `put` upserts full row state.
 */
export type RowStore<T> = {
    loadAll: () => readonly RowRecord<T>[] | Promise<readonly RowRecord<T>[]>
    put: (record: RowRecord<T>) => void | Promise<void>
    remove: (id: number) => void | Promise<void>
    clear: () => void | Promise<void>
    putBatch?: (records: readonly RowRecord<T>[]) => void | Promise<void>
    removeBatch?: (ids: readonly number[]) => void | Promise<void>
    replaceAll?: (records: readonly RowRecord<T>[]) => void | Promise<void>
}

/** Events emitted for durable store lifecycle (not work lifecycle). */
export type PersistEvents = {
    'persist:loaded': { size: number }
    'persist:lease-expired': { id: number; item: unknown }
    'persist:id-space-low': { remaining: number }
    'persist:error': {
        operation: 'load' | 'put' | 'remove' | 'clear' | 'replace'
        error: unknown
        id?: number
    }
    /** Successful store operation timing, emitted only while observed. */
    'persist:operation': {
        operation: 'load' | 'put' | 'remove' | 'clear' | 'replace'
        durationMs: number
        id?: number
    }
}
