type TimerHandle = {
    current: unknown
    cancelled: boolean
}

/** Maximum delay accepted by browser and Node timer implementations. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Platform-neutral timeout schedule (no DOM lib required). */
export const scheduleTimeout = (
    fn: () => void,
    delay: number,
): unknown => {
    const schedule = (
        globalThis as unknown as {
            setTimeout: (cb: () => void, ms: number) => unknown
        }
    ).setTimeout
    const state: TimerHandle = { current: undefined, cancelled: false }
    const scheduleChunk = (remaining: number): void => {
        if (state.cancelled) return
        const chunk = Math.min(Math.max(0, remaining), MAX_TIMER_DELAY_MS)
        state.current = schedule(() => {
            if (state.cancelled) return
            if (remaining > chunk) {
                scheduleChunk(remaining - chunk)
            } else {
                fn()
            }
        }, chunk)
    }
    scheduleChunk(delay)
    return state
}

export const cancelTimeout = (handle: unknown): void => {
    const state = handle as Partial<TimerHandle> | null
    if (state && typeof state === 'object' && 'cancelled' in state) {
        state.cancelled = true
    }
    const clear = (
        globalThis as unknown as {
            clearTimeout: (id: unknown) => void
        }
    ).clearTimeout
    clear(
        state && typeof state === 'object' && 'current' in state
            ? state.current
            : handle,
    )
}

/** Prefer `queueMicrotask`; fall back to a thenable hop. */
export const scheduleMicrotask = (fn: () => void): void => {
    const queueMicrotask = (
        globalThis as unknown as {
            queueMicrotask?: (cb: () => void) => void
        }
    ).queueMicrotask
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(fn)
        return
    }
    Promise.resolve().then(fn)
}
