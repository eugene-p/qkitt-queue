import type { SystemConfig } from '../types'
import { configError } from '../errors'
import { parseSystemConfigValue } from './system'

/**
 * Validate an unknown value as **data-only** config (JSON-safe).
 * Rejects `worker` and custom store `impl` (JS-only fields).
 * Returns a cleaned {@link SystemConfig} (unknown fields stripped).
 */
export const validateSystemConfig = (value: unknown): SystemConfig =>
    parseSystemConfigValue(value, { allowJs: false })

/**
 * Validate a JS/TS module config **in place** and return the same reference.
 * Preserves workers, custom store impls, and any extra properties on `TConfig`.
 * Prefer {@link defineConfig} at the export site for typed inference.
 */
export const validateJsConfig = <TConfig extends SystemConfig>(
    value: TConfig,
): TConfig => {
    // Side-effect validation; discard the reconstructed SystemConfig so
    // callers keep their original object identity and type parameters.
    parseSystemConfigValue(value, { allowJs: true })
    return value
}

/**
 * Identity helper for typed JS config modules.
 * Validates structure and preserves function / store instance references.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   stores: {
 *     jobs: { adapter: 'localStorage', key: 'app:jobs' },
 *   },
 *   queues: {
 *     jobs: {
 *       persist: { store: 'jobs' },
 *       worker: handleJob,
 *     },
 *   },
 * })
 * ```
 */
export const defineConfig = <const TConfig extends SystemConfig>(
    config: TConfig,
): TConfig => validateJsConfig(config)

/**
 * Parse a JSON string into a validated **data-only** {@link SystemConfig}.
 */
export const parseSystemConfig = (json: string): SystemConfig => {
    let parsed: unknown
    try {
        parsed = JSON.parse(json) as unknown
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'invalid JSON'
        return configError(
            'INVALID_JSON',
            `config JSON is invalid: ${message}`,
        )
    }
    return validateSystemConfig(parsed)
}
