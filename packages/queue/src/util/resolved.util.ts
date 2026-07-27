/** Shared settled promises for hot inline paths (no per-call allocation). */
export const RESOLVED: Promise<void> = Promise.resolve()
export const RESOLVED_UNDEFINED: Promise<undefined> = Promise.resolve(undefined)
