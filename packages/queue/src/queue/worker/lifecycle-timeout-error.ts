/** Rejected when `whenIdle` / `gracefulStop` exceed `timeoutMs`. */
export class LifecycleTimeoutError extends Error {
    override readonly name = 'LifecycleTimeoutError'
    readonly timeoutMs: number

    constructor(message: string, timeoutMs: number) {
        super(message)
        this.timeoutMs = timeoutMs
    }
}
