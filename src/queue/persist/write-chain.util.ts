/**
 * Serialize async store mutations so concurrent enqueue/dequeue/clear
 * cannot race the backend.
 */
export type WriteChain = {
    /** Enqueue an operation; returned promise settles when this op finishes. */
    push: (op: () => Promise<void>) => Promise<void>
    /** Wait until all currently queued ops have settled. */
    flush: () => Promise<void>
}

export const createWriteChain = (): WriteChain => {
    let chain: Promise<void> = Promise.resolve()

    const push = (op: () => Promise<void>): Promise<void> => {
        const run = chain.then(op, op)
        // Keep the chain alive even when `run` rejects so later ops still run.
        chain = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }

    const flush = (): Promise<void> => chain

    return { push, flush }
}
