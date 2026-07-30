/**
 * Mutable recovery configuration shared between withWorker and outer
 * withLoop / withDeadLetter layers (composition after worker).
 */

import { ConflictingRecoveryError } from '../../persist/errors'
import type { DelayPolicy } from '../../util/delay-policy.util'
import type { Lease } from '../core/queue'

export class LoopEnqueueError extends Error {
    override readonly name = 'LoopEnqueueError'
    override readonly cause: unknown
    readonly item: unknown
    readonly workerError: unknown

    constructor(
        message: string,
        options: { cause: unknown; item: unknown; workerError: unknown },
    ) {
        super(message, { cause: options.cause })
        this.cause = options.cause
        this.item = options.item
        this.workerError = options.workerError
    }
}

export class DeadLetterEnqueueError extends Error {
    override readonly name = 'DeadLetterEnqueueError'
    override readonly cause: unknown
    readonly item: unknown
    readonly workerError: unknown

    constructor(
        message: string,
        options: { cause: unknown; item: unknown; workerError: unknown },
    ) {
        super(message, { cause: options.cause })
        this.cause = options.cause
        this.item = options.item
        this.workerError = options.workerError
    }
}

export type RecoveryPolicyResult<T> =
    | { action: 'loop'; item?: T; delayMs?: number }
    | { action: 'fail' }

export type RecoveryPolicy<T> =
    | 'loop'
    | 'fail'
    | ((ctx: {
          item: T
          error: unknown
          lease: Lease<T>
      }) => void | Promise<void | RecoveryPolicyResult<T>>)

export type LoopMapContext = {
    name: string
    previousHops: number | undefined
    hops: number
}

export type LoopRecoveryOptions<T, U = T> = {
    map?: (item: T, error: unknown, ctx: LoopMapContext) => U
    filter?: (item: T, error: unknown, ctx: LoopMapContext) => boolean
    delay?: DelayPolicy
}

export type DlqRecoveryOptions<T, U = T> = {
    target: { enqueue: (item: U) => void | Promise<void> }
    map?: (item: T, error: unknown) => U
    filter?: (item: T, error: unknown) => boolean
}

export type RecoveryConfig<T> = {
    /** True once caller set onFailure explicitly on withWorker. */
    policyExplicit: boolean
    policy: RecoveryPolicy<T>
    loop?: LoopRecoveryOptions<T>
    dlq?: DlqRecoveryOptions<T>
}

const RECOVERY_KEY = Symbol.for('qkitt:recovery-config')

export const attachRecoveryConfig = <T, Q extends object>(
    queue: Q,
    config: RecoveryConfig<T>,
): Q => {
    Object.defineProperty(queue, RECOVERY_KEY, {
        value: config,
        enumerable: false,
        configurable: true,
        writable: true,
    })
    return queue
}

export const getRecoveryConfig = <T>(
    queue: object,
): RecoveryConfig<T> | undefined =>
    (queue as Record<symbol, RecoveryConfig<T> | undefined>)[RECOVERY_KEY]

/** Default floor backoff when DLQ handoff fails (ms). */
export const DLQ_RETRY_BACKOFF_MS = 1000

/** Apply loop options onto an existing worker recovery config. */
export const configureLoopRecovery = <T>(
    queue: object,
    loop: NonNullable<RecoveryConfig<T>['loop']>,
    setPolicyLoop: boolean,
): void => {
    const config = getRecoveryConfig<T>(queue)
    if (!config) {
        throw new ConflictingRecoveryError(
            'withLoop requires a worker layer recovery config',
        )
    }
    if (setPolicyLoop) {
        if (config.policyExplicit && config.policy !== 'loop') {
            throw new ConflictingRecoveryError(
                'withLoop conflicts with explicit onFailure that is not "loop"',
            )
        }
        config.policy = 'loop'
        config.policyExplicit = true
    }
    config.loop = loop
}

/** Register DLQ target on fail policy (does not change policy). */
export const configureDlqRecovery = <T>(
    queue: object,
    dlq: NonNullable<RecoveryConfig<T>['dlq']>,
): void => {
    const config = getRecoveryConfig<T>(queue)
    if (!config) {
        throw new ConflictingRecoveryError(
            'withDeadLetter requires a worker layer recovery config',
        )
    }
    config.dlq = dlq
}
