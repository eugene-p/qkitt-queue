/**
 * Non-enumerable hook for process-local (no store) claim/ack without Promises.
 * Used by withWorker to restore tight-loop drain performance.
 */
import type { Lease } from './queue'

export const INLINE_OPS = Symbol.for('qkitt:inline-ops')

export type InlineOps<T> = {
    claimSync: () => Lease<T> | undefined
    ackSync: (lease: Lease<T>) => void
    rescheduleSync: (
        lease: Lease<T>,
        next: { item: T; delayMs?: number; attempt?: number; dlqHandoffAttempt?: number },
    ) => void
    releaseSync: (lease: Lease<T>) => void
}

export const getInlineOps = <T>(queue: object): InlineOps<T> | undefined =>
    (queue as Record<symbol, InlineOps<T> | undefined>)[INLINE_OPS]

export const attachInlineOps = <T, Q extends object>(
    queue: Q,
    ops: InlineOps<T>,
): Q => {
    Object.defineProperty(queue, INLINE_OPS, {
        value: ops,
        enumerable: false,
        configurable: false,
        writable: false,
    })
    return queue
}
