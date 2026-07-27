/**
 * Serialize store mutations so concurrent ops cannot race the backend.
 * Ops may be sync or async; results propagate to the caller.
 */
export type WriteChain = {
    push: <R>(op: () => R | PromiseLike<R>) => Promise<R>
    flush: () => Promise<void>
}

const isThenable = <R>(value: R | PromiseLike<R>): value is PromiseLike<R> =>
    value != null &&
    typeof (value as { then?: unknown }).then === 'function'

/**
 * Serialize work one-at-a-time. Sync ops avoid an extra `async` wrapper hop
 * when the previous link has already settled (common for memory stores).
 */
export const createWriteChain = (): WriteChain => {
    let chain: Promise<void> = Promise.resolve()

    const push = <R>(op: () => R | PromiseLike<R>): Promise<R> => {
        const run = chain.then(
            () => {
                const result = op()
                return isThenable(result) ? Promise.resolve(result) : result
            },
            () => {
                // Prior op failed; still run this op (same as old chain.then(op, op)).
                const result = op()
                return isThenable(result) ? Promise.resolve(result) : result
            },
        )
        chain = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }

    const flush = (): Promise<void> => chain

    return { push, flush }
}
