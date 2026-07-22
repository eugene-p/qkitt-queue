/**
 * Shared hydrate / write-chain / restore-kick protocol for persist decorators.
 * Strategy-specific load/replace and error mapping stay in the decorator.
 */

import {
    createHydrateGate,
    type HydrateGate,
} from './hydrate-gate.util'
import { createWriteChain, type WriteChain } from './write-chain.util'

type PersistenceLifecycle = {
    gate: HydrateGate
    writes: WriteChain
    hydrate: () => Promise<void>
    flush: () => Promise<void>
}

type CreatePersistenceLifecycleOptions = {
    /**
     * Flush-safe load + silent `replaceAll` + emit `persist:loaded`.
     * Called only while the hydrate gate is closed.
     */
    loadAndReplace: () => Promise<void>
    /** Map load failures to `persist:error` (or equivalent). */
    onLoadError: (error: unknown) => void
    /** Used for the post-gate worker kick. */
    notify: {
        size: () => number
        peek: () => unknown
        emit: (eventName: string, data: unknown) => void
    }
}

/**
 * Owns exclusive hydrate, write-chain flush-before-load, and post-hydrate
 * worker notification. Does not own row rollback or snapshot auto-save.
 */
export const createPersistenceLifecycle = (
    options: CreatePersistenceLifecycleOptions,
): PersistenceLifecycle => {
    const gate = createHydrateGate()
    const writes = createWriteChain()

    const hydrate = async (): Promise<void> => {
        await gate.run(async () => {
            try {
                await writes.flush()
                await options.loadAndReplace()
            } catch (error) {
                options.onLoadError(error)
                throw error
            }
        })

        // Post-gate worker kick only — emit after the exclusive hydrate so
        // storage side effects are enabled again before stacked workers pump.
        // Gate on size (structural emptiness). Do not branch on the peeked
        // payload: null/undefined are valid heads and must still wake workers.
        const size = options.notify.size()
        if (size === 0) return
        options.notify.emit('queue:enqueued', {
            item: options.notify.peek(),
            size,
        })
    }

    return {
        gate,
        writes,
        hydrate,
        flush: writes.flush,
    }
}
