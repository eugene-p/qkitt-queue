/**
 * Shared checks and post-hydrate hooks for queue persistence decorators.
 */

import {
    hasQueueLayer,
    PERSIST_LAYER,
    WORKER_LAYER,
} from '../core/layers.util'

/**
 * Fail fast when persist is stacked incorrectly.
 * Correct order: `withWorker(withRowPersist(queue, store), worker)`.
 * Do not wrap a worker queue or an already-persisted queue.
 */
export const assertBareQueueForPersist = (
    queue: object,
    wrapperName: string,
): void => {
    if (hasQueueLayer(queue, WORKER_LAYER)) {
        throw new Error(
            `${wrapperName} must wrap the bare queue before withWorker: ` +
                `withWorker(${wrapperName}(queue, store), worker)`,
        )
    }

    if (hasQueueLayer(queue, PERSIST_LAYER)) {
        throw new Error(
            `${wrapperName} cannot wrap an already-persisted queue; ` +
                `use a single persist layer on the bare queue`,
        )
    }
}

/**
 * After a silent hydrate rebuild, kick stacked workers that pump on
 * `queue:enqueued` without re-inserting items into the store.
 */
export const notifyQueueRestored = <T>(queue: {
    size: () => number
    peek: () => T | undefined
    emit: (eventName: string, data: unknown) => void
}): void => {
    const size = queue.size()
    if (size === 0) return
    const item = queue.peek()
    if (item === undefined) return
    queue.emit('queue:enqueued', { item, size })
}
