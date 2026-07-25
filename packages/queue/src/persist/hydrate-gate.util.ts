/**
 * Thrown when a mutation (or dequeue) is attempted while `hydrate()` is
 * replacing memory from the store. Workers catch this specifically so they
 * can wait for the post-hydrate restore kick.
 */
export class QueueHydratingError extends Error {
    override readonly name = 'QueueHydratingError'

    constructor(
        message = 'Cannot mutate queue while hydrate() is in progress; await hydrate() first',
    ) {
        super(message)
    }
}

/** Thrown when a second `hydrate()` starts while one is already running. */
export class HydrateInProgressError extends Error {
    override readonly name = 'HydrateInProgressError'

    constructor(message = 'hydrate already in progress') {
        super(message)
    }
}

/** Suppress side effects while restoring from the store. Exclusive: one run at a time. */
export type HydrateGate = {
    isSuppressing: () => boolean
    /**
     * Run `fn` with the gate closed. Rejects immediately if another hydrate
     * is already in progress ({@link HydrateInProgressError}).
     */
    run: <R>(fn: () => Promise<R>) => Promise<R>
}

export const createHydrateGate = (): HydrateGate => {
    let active = false

    return {
        isSuppressing: () => active,
        run: async <R>(fn: () => Promise<R>): Promise<R> => {
            if (active) {
                throw new HydrateInProgressError()
            }
            active = true
            try {
                return await fn()
            } finally {
                active = false
            }
        },
    }
}

/** Reject user mutations while hydrate() is replacing memory from the store. */
export const assertNotHydrating = (gate: HydrateGate): void => {
    if (gate.isSuppressing()) {
        throw new QueueHydratingError()
    }
}
