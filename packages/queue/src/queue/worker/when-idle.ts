import {
    cancelTimeout,
    scheduleTimeout,
} from '../../util/schedule-timeout.util'
import { LifecycleTimeoutError } from './lifecycle-timeout-error'
import { resolveTimeoutMs } from './resolve-timeout-ms.util'

export { LifecycleTimeoutError } from './lifecycle-timeout-error'

/** Minimal surface for {@link whenIdle}. */
export type IdleWaitable = {
    on: (event: 'worker:idle', cb: () => void) => () => void
    isEmpty: () => boolean
    isProcessing: () => boolean
}

export type WhenIdleOptions = {
    /** Reject with {@link LifecycleTimeoutError} if idle is not reached in time. */
    timeoutMs?: number
}

/**
 * Resolve when the worker queue is empty and nothing is in flight.
 *
 * Subscribes to `worker:idle` first, then resolves immediately if already idle
 * (avoids missing a concurrent transition). Does not call `stop()`.
 *
 * Idle never fires if items remain and the pump is not running (`stop()`, or
 * `autoStart: false` without `start()`). Pass `timeoutMs`, start the worker,
 * or drain/clear first.
 */
export const whenIdle = (
    queue: IdleWaitable,
    options: WhenIdleOptions = {},
): Promise<void> => {
    const timeoutMs = resolveTimeoutMs(options.timeoutMs)

    return new Promise((resolve, reject) => {
        let settled = false
        let timer: unknown

        const cleanup = (): void => {
            off()
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

        const off = queue.on('worker:idle', () => {
            finish(() => {
                resolve()
            })
        })

        if (timeoutMs !== undefined) {
            timer = scheduleTimeout(() => {
                finish(() => {
                    reject(
                        new LifecycleTimeoutError(
                            `whenIdle timed out after ${timeoutMs}ms`,
                            timeoutMs,
                        ),
                    )
                })
            }, timeoutMs)
        }

        if (queue.isEmpty() && !queue.isProcessing()) {
            finish(() => {
                resolve()
            })
        }
    })
}
