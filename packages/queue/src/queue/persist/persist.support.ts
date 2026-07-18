/**
 * Shared composition checks for queue persistence decorators.
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
