/**
 * Serialize store mutations so concurrent ops cannot race the backend.
 * Ops may be sync or async; results propagate to the caller.
 */
export type WriteChain = {
    push: <R>(op: () => R | PromiseLike<R>) => Promise<R>
    flush: () => Promise<void>
}

/** Serialize work one-at-a-time. */
export const createWriteChain = (): WriteChain => {
    let chain: Promise<void> = Promise.resolve()

    const push = <R>(op: () => R | PromiseLike<R>): Promise<R> => {
        const run = chain.then(op, op)
        chain = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }

    const flush = (): Promise<void> => chain

    return { push, flush }
}
