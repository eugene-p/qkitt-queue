type TimerHandle = unknown

/** Platform-neutral timeout schedule (no DOM lib required). */
export const scheduleTimeout = (
    fn: () => void,
    delay: number,
): TimerHandle => {
    const schedule = (
        globalThis as unknown as {
            setTimeout: (cb: () => void, ms: number) => unknown
        }
    ).setTimeout
    return schedule(fn, delay)
}

export const cancelTimeout = (handle: TimerHandle): void => {
    const clear = (
        globalThis as unknown as {
            clearTimeout: (id: unknown) => void
        }
    ).clearTimeout
    clear(handle)
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
