import type { PersistEvents, RowStore } from '../../persist/contracts'
import { createWriteChain } from '../../persist/write-chain.util'

type PersistOperation = PersistEvents['persist:operation']['operation']

export type DurableCoordinator<T> = {
    readonly hasStore: boolean
    withChain: <R>(op: () => R | PromiseLike<R>) => Promise<R>
    callStore: <R>(
        operation: PersistOperation,
        id: number | undefined,
        op: () => R | PromiseLike<R>,
    ) => Promise<R>
    flush: () => Promise<void>
}

/** Own the durable write chain and persistence telemetry for a queue. */
export const createDurableCoordinator = <T>(options: {
    store: RowStore<T> | undefined
    now: () => number
    hasListeners: (eventName: keyof PersistEvents) => boolean
    emit: <K extends keyof PersistEvents>(
        eventName: K,
        data: PersistEvents[K],
    ) => void
}): DurableCoordinator<T> => {
    const chain = options.store === undefined ? undefined : createWriteChain()

    const withChain = <R>(op: () => R | PromiseLike<R>): Promise<R> => {
        if (chain === undefined) return Promise.resolve(op())
        return chain.push(op)
    }

    const callStore = async <R>(
        operation: PersistOperation,
        id: number | undefined,
        op: () => R | PromiseLike<R>,
    ): Promise<R> => {
        const startedAt = options.now()
        let result: R
        try {
            result = await op()
        } catch (error) {
            if (options.hasListeners('persist:error')) {
                options.emit('persist:error', {
                    operation,
                    error,
                    ...(id !== undefined ? { id } : {}),
                })
            }
            throw error
        }
        if (options.hasListeners('persist:operation')) {
            options.emit('persist:operation', {
                operation,
                durationMs: Math.max(0, options.now() - startedAt),
                ...(id !== undefined ? { id } : {}),
            })
        }
        return result
    }

    return {
        hasStore: options.store !== undefined,
        withChain,
        callStore,
        flush: () => chain?.flush() ?? Promise.resolve(),
    }
}
