/**
 * Shared parse context threaded through config validators.
 * Built after stores are known so queue/persist can resolve names + strategies.
 */

export type ParseJsOptions = {
    /** Allow workers and custom store impls (JS modules). */
    allowJs: boolean
}

/** Full context for queue-level parsing after store inventory is known. */
export type ParseCtx = ParseJsOptions & {
    storeNames: ReadonlySet<string>
    storeStrategies: ReadonlyMap<string, 'snapshot' | 'row'>
}
