/** Suppress side effects while restoring from the store. */
export type HydrateGate = {
    isSuppressing: () => boolean
    run: <R>(fn: () => Promise<R>) => Promise<R>
}

export const createHydrateGate = (): HydrateGate => {
    let suppressing = false

    return {
        isSuppressing: () => suppressing,
        run: async <R>(fn: () => Promise<R>): Promise<R> => {
            suppressing = true
            try {
                return await fn()
            } finally {
                suppressing = false
            }
        },
    }
}

/** Reject user mutations while hydrate() is replacing memory from the store. */
export const assertNotHydrating = (gate: HydrateGate): void => {
    if (gate.isSuppressing()) {
        throw new Error(
            'Cannot mutate queue while hydrate() is in progress; await hydrate() first',
        )
    }
}
