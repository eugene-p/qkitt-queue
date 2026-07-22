/**
 * Public persist decorator: `withPersist(queue, store)`.
 * Strategy is inferred from the store's method shape at runtime.
 */

import type { EventMap } from '../events'
import type { Queue, QueueEvents } from '../queue/core/queue'
import type {
    QueueWithPersist,
    RowStore,
    SnapshotStore,
} from './contracts'
import { isRowStore, isSnapshotStore } from './store-guards.util'
import { assertBareQueueForPersist } from './strategies/support'
import { attachRowPersist } from './strategies/row'
import { attachSnapshotPersist } from './strategies/snapshot'

/**
 * Attach persistence to a bare queue. Strategy is resolved by the store's
 * method shape:
 * - `load` + `save` → snapshot persist
 * - `loadAll` + `insert` + `remove` + `clear` → row persist
 *
 * Strategy options are read from `store.persistOptions` (attached by factories
 * or custom authors). Custom stores that omit it get defaults.
 *
 * **Composition (required):** wrap the bare queue, then the worker:
 * `withWorker(withPersist(buildQueue(), store), worker)`.
 *
 * @throws {TypeError} if the store matches both shapes or neither.
 * @throws {Error} if the queue already has a worker or persist layer.
 */
export function withPersist<
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: SnapshotStore<T>,
): QueueWithPersist<T, 'snapshot', TEvents>

export function withPersist<
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: RowStore<T>,
): QueueWithPersist<T, 'row', TEvents>

export function withPersist<
    T,
    TEvents extends QueueEvents<T> = QueueEvents<T>,
>(
    queue: Queue<T, TEvents>,
    store: SnapshotStore<T> | RowStore<T>,
): QueueWithPersist<T, 'snapshot' | 'row', TEvents> {
    assertBareQueueForPersist(queue, 'withPersist')

    const isSnap = isSnapshotStore<T>(store)
    const isRow = isRowStore<T>(store)

    if (isSnap && isRow) {
        throw new TypeError(
            'withPersist: store matches both SnapshotStore and RowStore',
        )
    }

    if (isSnap) {
        const options =
            (store as { persistOptions?: Record<string, unknown> })
                .persistOptions ?? {}
        return attachSnapshotPersist(
            queue,
            store,
            options,
        ) as QueueWithPersist<T, 'snapshot' | 'row', TEvents>
    }

    if (isRow) {
        const options =
            (store as { persistOptions?: Record<string, unknown> })
                .persistOptions ?? {}
        return attachRowPersist(
            queue,
            store,
            options,
        ) as QueueWithPersist<T, 'snapshot' | 'row', TEvents>
    }

    throw new TypeError(
        'withPersist: store must implement SnapshotStore or RowStore',
    )
}
