import type { QueueConfig, StoreDefinition, SystemConfig } from './types'

/**
 * Shallow-freeze so callers cannot reassign top-level fields, while keeping
 * worker / store impl references intact (unlike JSON round-trip).
 */
export const freezeConfig = <TConfig extends SystemConfig>(
    config: TConfig,
): Readonly<TConfig> => {
    const queues: Record<string, QueueConfig> = {}
    for (const [name, queue] of Object.entries(config.queues)) {
        queues[name] = Object.freeze({ ...queue })
    }

    const stores: Record<string, StoreDefinition> = {}
    if (config.stores) {
        for (const [name, store] of Object.entries(config.stores)) {
            stores[name] = Object.freeze({ ...store }) as StoreDefinition
        }
    }

    const frozen = {
        ...config,
        ...(Object.keys(stores).length > 0
            ? { stores: Object.freeze(stores) }
            : {}),
        queues: Object.freeze(queues),
        ...(config.router
            ? {
                  router: Object.freeze({
                      ...config.router,
                      ...(config.router.bindings
                          ? {
                                bindings: Object.freeze(
                                    config.router.bindings.map((b) =>
                                        Object.freeze({ ...b }),
                                    ),
                                ),
                            }
                          : {}),
                      ...(config.router.unmatchedQueue !== undefined
                          ? { unmatchedQueue: config.router.unmatchedQueue }
                          : {}),
                  }),
              }
            : {}),
    }

    return Object.freeze(frozen) as Readonly<TConfig>
}
