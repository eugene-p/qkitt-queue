import {
    cancelTimeout,
    scheduleMicrotask,
    scheduleTimeout,
} from '../../util/schedule-timeout.util'
import { LifecycleTimeoutError } from './lifecycle-timeout-error'
import { resolveTimeoutMs } from './resolve-timeout-ms.util'

/** Minimal surface for {@link gracefulStop}. */
export type GracefulStopable = {
    stop: () => void
    isProcessing: () => boolean
    on: (
        event: 'worker:completed' | 'worker:failed',
        cb: () => void,
    ) => () => void
    flush?: () => void | PromiseLike<void>
}

export type GracefulStopOptions = {
    /**
     * When true, await `flush()` after in-flight work settles if the queue
     * exposes it. Default false (opt-in).
     */
    flush?: boolean
    /**
     * Reject with {@link LifecycleTimeoutError} if settle (and optional flush)
     * exceed this budget. Does not cancel in-flight workers or an in-progress
     * flush — only rejects the returned promise.
     */
    timeoutMs?: number
}

const runFlush = async (queue: GracefulStopable): Promise<void> => {
    const flush = queue.flush
    if (typeof flush !== 'function') return
    await flush()
}

/**
 * Stop taking new items, wait for in-flight work to finish, optionally flush.
 *
 * Unlike {@link import('./when-idle').whenIdle}, this does **not** require an
 * empty queue — remaining items stay queued (typical SIGTERM path for durable
 * queues).
 */
export const gracefulStop = (
    queue: GracefulStopable,
    options: GracefulStopOptions = {},
): Promise<void> => {
    const timeoutMs = resolveTimeoutMs(options.timeoutMs)
    const shouldFlush = options.flush === true

    return new Promise((resolve, reject) => {
        let settled = false
        /** Prevents concurrent completion waves from starting flush twice. */
        let settling = false
        let timer: unknown
        let offCompleted: (() => void) | undefined
        let offFailed: (() => void) | undefined

        const cleanup = (): void => {
            offCompleted?.()
            offFailed?.()
            offCompleted = undefined
            offFailed = undefined
            if (timer !== undefined) {
                cancelTimeout(timer)
                timer = undefined
            }
        }

        const finish = (action: () => void): void => {
            if (settled) return
            settled = true
            cleanup()
            action()
        }

        const settle = (): void => {
            if (settled || settling) return
            if (queue.isProcessing()) return

            settling = true
            // Drop listeners as soon as settle starts (before await flush).
            offCompleted?.()
            offFailed?.()
            offCompleted = undefined
            offFailed = undefined

            void (async () => {
                try {
                    if (shouldFlush) {
                        await runFlush(queue)
                    }
                    finish(() => {
                        resolve()
                    })
                } catch (error) {
                    finish(() => {
                        reject(error)
                    })
                }
            })()
        }

        // completed/failed emit before active is decremented — check on a
        // microtask so isProcessing() reflects the post-finish state.
        const onItemDone = (): void => {
            scheduleMicrotask(settle)
        }

        queue.stop()

        offCompleted = queue.on('worker:completed', onItemDone)
        offFailed = queue.on('worker:failed', onItemDone)

        if (timeoutMs !== undefined) {
            timer = scheduleTimeout(() => {
                finish(() => {
                    reject(
                        new LifecycleTimeoutError(
                            `gracefulStop timed out after ${timeoutMs}ms`,
                            timeoutMs,
                        ),
                    )
                })
            }, timeoutMs)
        }

        settle()
    })
}
