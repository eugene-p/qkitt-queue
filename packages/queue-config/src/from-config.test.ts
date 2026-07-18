import { describe, expect, it } from 'vitest'
import {
    createMemoryRowStore,
    createMemorySnapshotStore,
    QueueFullError,
    type RouteMessage,
    type WebStorageLike,
} from '@qkitt/queue'
import { buildFromConfig, buildFromJson } from './from-config'
import {
    defineConfig,
    parseSystemConfig,
    validateSystemConfig,
} from './validate'
import type { SystemConfig } from './types'

const createMemoryWebStorage = (): WebStorageLike => {
    const map = new Map<string, string>()
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value)
        },
        removeItem: (key) => {
            map.delete(key)
        },
    }
}

describe('validateSystemConfig / parseSystemConfig', () => {
    it('accepts a minimal queues-only config', () => {
        const config = validateSystemConfig({
            queues: { jobs: {} },
        })
        expect(config).toEqual({ queues: { jobs: {} } })
    })

    it('parses JSON with store registry + queue refs + router', () => {
        const config = parseSystemConfig(
            JSON.stringify({
                stores: {
                    ordersMem: {
                        adapter: 'memory',
                        strategy: 'snapshot',
                    },
                    auditDisk: {
                        adapter: 'localStorage',
                        strategy: 'row',
                        key: 'app:audit',
                    },
                },
                queues: {
                    orders: {
                        persist: { store: 'ordersMem', autoSave: false },
                    },
                    audit: {
                        persist: { store: 'auditDisk' },
                    },
                },
                router: {
                    bindings: [
                        { pattern: 'orders.#', queue: 'orders' },
                        { pattern: 'orders.created', queue: 'audit' },
                    ],
                },
                hydrate: true,
            }),
        )

        expect(config.stores?.ordersMem).toEqual({
            adapter: 'memory',
            strategy: 'snapshot',
        })
        expect(config.queues.orders?.persist).toEqual({
            store: 'ordersMem',
            autoSave: false,
        })
        expect(config.router?.bindings).toHaveLength(2)
        expect(config.hydrate).toBe(true)
    })

    it('rejects empty queues', () => {
        expect(() => validateSystemConfig({ queues: {} })).toThrow(
            /at least one queue/,
        )
    })

    it('rejects binding to unknown queue', () => {
        expect(() =>
            validateSystemConfig({
                queues: { a: {} },
                router: { bindings: [{ pattern: 'x', queue: 'missing' }] },
            }),
        ).toThrow(/not defined in config.queues/)
    })

    it('rejects unmatchedQueue that is not in queues', () => {
        expect(() =>
            validateSystemConfig({
                queues: { a: {} },
                router: { unmatchedQueue: 'missing' },
            }),
        ).toThrow(/unmatchedQueue.*not defined in config.queues/)
    })

    it('rejects persist.store that is not in stores registry', () => {
        expect(() =>
            validateSystemConfig({
                queues: {
                    a: { persist: { store: 'missing' } },
                },
            }),
        ).toThrow(/not defined in config.stores/)
    })

    it('rejects invalid built-in adapter', () => {
        expect(() =>
            validateSystemConfig({
                stores: {
                    s: { adapter: 'redis', strategy: 'row' },
                },
                queues: {
                    a: { persist: { store: 's' } },
                },
            }),
        ).toThrow(/localStorage/)
    })

    it('requires key for web adapters', () => {
        expect(() =>
            validateSystemConfig({
                stores: {
                    s: { adapter: 'sessionStorage', strategy: 'row' },
                },
                queues: { a: { persist: { store: 's' } } },
            }),
        ).toThrow(/key is required/)
    })

    it('rejects invalid JSON text', () => {
        expect(() => parseSystemConfig('{')).toThrow(/config JSON is invalid/)
    })

    it('rejects worker in data-only JSON validation', () => {
        expect(() =>
            validateSystemConfig({
                queues: {
                    jobs: { worker: async () => undefined },
                },
            }),
        ).toThrow(/only valid in JS config/)
    })

    it('rejects when two queues reference the same persist store', () => {
        expect(() =>
            validateSystemConfig({
                stores: {
                    db: { adapter: 'memory', strategy: 'snapshot' },
                },
                queues: {
                    q1: { persist: { store: 'db' } },
                    q2: { persist: { store: 'db' } },
                },
            }),
        ).toThrow(/Each queue must have a unique store instance/)
    })

    it('rejects store.impl in data-only JSON validation', () => {
        expect(() =>
            validateSystemConfig({
                stores: {
                    s: {
                        strategy: 'row',
                        impl: createMemoryRowStore(),
                    },
                },
                queues: { a: { persist: { store: 's' } } },
            }),
        ).toThrow(/only valid in JS config/)
    })
})

describe('defineConfig', () => {
    it('accepts store registry + imported workers', () => {
        const handle = async (n: number) => n * 2
        const store = createMemoryRowStore<number>()
        const config = defineConfig({
            stores: {
                jobsDb: { strategy: 'row', impl: store },
            },
            queues: {
                jobs: {
                    persist: { store: 'jobsDb' },
                    worker: { run: handle, concurrency: 3, autoStart: false },
                },
            },
        })

        expect(config.stores?.jobsDb).toEqual({
            strategy: 'row',
            impl: store,
        })
        expect(config.queues.jobs.worker).toEqual({
            run: handle,
            concurrency: 3,
            autoStart: false,
        })
    })

    it('rejects partial RowStore impl missing remove/clear', () => {
        expect(() =>
            defineConfig({
                stores: {
                    bad: {
                        strategy: 'row',
                        impl: {
                            loadAll: () => [],
                            insert: () => {},
                        } as never,
                    },
                },
                queues: { q: { persist: { store: 'bad' } } },
            }),
        ).toThrow(/RowStore/)
    })
})

describe('buildFromConfig', () => {
    it('builds plain named queues', async () => {
        const system = await buildFromConfig({
            queues: {
                a: {},
                b: {},
            },
        })

        system.queues.a.enqueue(1)
        system.queues.b.enqueue(2)

        expect(system.queues.a.dequeue()).toBe(1)
        expect(system.queues.b.dequeue()).toBe(2)
        expect(system.router).toBeUndefined()
        expect(system.stores).toEqual({})
    })

    it('wires router bindings to named queues', async () => {
        const system = await buildFromConfig<
            SystemConfig,
            RouteMessage<{ id: number }>
        >({
            queues: {
                created: {},
                all: {},
            },
            router: {
                bindings: [
                    { pattern: 'orders.created', queue: 'created' },
                    { pattern: 'orders.#', queue: 'all' },
                ],
            },
        })

        expect(system.router).toBeDefined()
        const matched = system.router!.publish('orders.created', { id: 9 })
        expect(matched).toBe(2)
        expect(system.queues.created.size()).toBe(1)
        expect(system.queues.all.size()).toBe(1)
        expect(system.queues.created.peek()).toEqual({
            topic: 'orders.created',
            data: { id: 9 },
        })
    })

    it('wires router.unmatchedQueue as unrouted sink', async () => {
        const system = await buildFromConfig<
            SystemConfig,
            RouteMessage<{ id: number }>
        >({
            queues: {
                orders: {},
                unrouted: {},
            },
            router: {
                bindings: [{ pattern: 'orders.#', queue: 'orders' }],
                unmatchedQueue: 'unrouted',
            },
        })

        expect(system.router!.publish('orders.created', { id: 1 })).toBe(1)
        expect(system.queues.unrouted.isEmpty()).toBe(true)

        expect(system.router!.publish('misc.event', { id: 2 })).toBe(0)
        expect(system.queues.unrouted.toArray()).toEqual([
            { topic: 'misc.event', data: { id: 2 } },
        ])
        expect(system.router!.unmatchedCount()).toBe(1)
        expect(system.router!.lastUnmatched()).toEqual({
            topic: 'misc.event',
            data: { id: 2 },
        })
    })

    it('applies snapshot persist via named custom store', async () => {
        const store = createMemorySnapshotStore<string>(['preloaded'])
        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'snapshot', impl: store },
            },
            queues: {
                jobs: {
                    persist: { store: 'jobs' },
                },
            },
        })

        expect(system.stores.jobs).toBe(store)
        expect(system.queues.jobs.toArray()).toEqual(['preloaded'])
        system.queues.jobs.enqueue('next')
        await system.flushAll()
        expect(store.data).toEqual(['preloaded', 'next'])
    })

    it('applies row persist via named custom store', async () => {
        const store = createMemoryRowStore<string>([
            { id: 'r1', item: 'old' },
        ])
        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'row', impl: store },
            },
            queues: {
                jobs: { persist: { store: 'jobs' } },
            },
        })

        expect(system.queues.jobs.toArray()).toEqual(['old'])
        expect(system.queues.jobs.rowIds?.()).toEqual(['r1'])

        system.queues.jobs.enqueue('new')
        await system.flushAll()
        expect(store.rows.map((r) => r.item)).toEqual(['old', 'new'])
    })

    it('builds web snapshot adapter with injected storage', async () => {
        const storage = createMemoryWebStorage()
        storage.setItem('q:snap', JSON.stringify(['from-disk']))

        const system = await buildFromConfig(
            {
                stores: {
                    snap: {
                        adapter: 'localStorage',
                        strategy: 'snapshot',
                        key: 'q:snap',
                    },
                },
                queues: {
                    jobs: { persist: { store: 'snap' } },
                },
            },
            { storage },
        )

        expect(system.queues.jobs.toArray()).toEqual(['from-disk'])
        system.queues.jobs.enqueue('live')
        await system.flushAll()
        expect(JSON.parse(storage.getItem('q:snap')!)).toEqual([
            'from-disk',
            'live',
        ])
    })

    it('skips auto-hydrate when hydrate is false', async () => {
        const store = createMemorySnapshotStore<string>(['hidden'])
        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'snapshot', impl: store },
            },
            queues: {
                jobs: { persist: { store: 'jobs' } },
            },
            hydrate: false,
        })

        expect(system.queues.jobs.toArray()).toEqual([])
        await system.hydrateAll()
        expect(system.queues.jobs.toArray()).toEqual(['hidden'])
    })

    it('rejects custom store that does not match strategy', async () => {
        const rowStore = createMemoryRowStore<string>()
        await expect(
            buildFromConfig({
                stores: {
                    // force a mismatched impl past the type checker
                    jobs: {
                        strategy: 'snapshot',
                        impl: rowStore as unknown as ReturnType<
                            typeof createMemorySnapshotStore
                        >,
                    },
                },
                queues: {
                    jobs: { persist: { store: 'jobs' } },
                },
                hydrate: false,
            }),
        ).rejects.toThrow(/must be a SnapshotStore/)
    })

    it('buildFromJson end-to-end with store registry', async () => {
        const storage = createMemoryWebStorage()
        const system = await buildFromJson(
            JSON.stringify({
                stores: {
                    mail: {
                        adapter: 'localStorage',
                        strategy: 'row',
                        key: 'mail',
                    },
                },
                queues: {
                    inbox: {
                        persist: { store: 'mail' },
                    },
                },
                router: {
                    bindings: [{ pattern: 'mail.#', queue: 'inbox' }],
                },
            }),
            { storage },
        )

        system.router!.publish('mail.send', { to: 'a@b.c' })
        await system.flushAll()
        expect(system.queues.inbox.size()).toBe(1)
        expect(storage.getItem('mail:order')).toBeTruthy()
    })

    it('exposes a frozen config snapshot', async () => {
        const system = await buildFromConfig({
            queues: { a: {} },
        })
        expect(system.config.queues).toEqual({ a: {} })
        expect(() => {
            ;(system.config as { hydrate?: boolean }).hydrate = true
        }).toThrow()
    })

    it('propagates invalid route patterns from the router', async () => {
        await expect(
            buildFromConfig({
                queues: { a: {} },
                router: {
                    bindings: [{ pattern: 'bad..pattern', queue: 'a' }],
                },
            }),
        ).rejects.toThrow(/Invalid route pattern/)
    })

    it('attaches workers from JS config (plain function)', async () => {
        const seen: number[] = []
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: async (n: number) => {
                        seen.push(n)
                        return n
                    },
                },
            },
        })

        expect(system.queues.jobs.isRunning?.()).toBe(true)
        system.queues.jobs.enqueue(1)
        system.queues.jobs.enqueue(2)

        await viWaitFor(() => seen.length === 2)
        expect(seen).toEqual([1, 2])
        expect(system.queues.jobs.isEmpty()).toBe(true)
    })

    it('supports worker options + custom store in one config', async () => {
        const store = createMemoryRowStore<string>()
        const seen: string[] = []
        const system = await buildFromConfig({
            stores: {
                jobsDb: { strategy: 'row', impl: store },
            },
            queues: {
                jobs: {
                    persist: { store: 'jobsDb' },
                    worker: {
                        run: async (item: string) => {
                            seen.push(item)
                        },
                        concurrency: 1,
                        autoStart: false,
                    },
                },
            },
            hydrate: false,
        })

        system.queues.jobs.enqueue('a')
        await system.flushAll()
        expect(store.rows.map((r) => r.item)).toEqual(['a'])
        expect(seen).toEqual([])

        system.queues.jobs.start?.()
        await viWaitFor(() => seen.length === 1)
        expect(seen).toEqual(['a'])
        await system.flushAll()
        expect(store.rows).toEqual([])
    })

    it('rejects shared store definitions across queues', () => {
        expect(() =>
            validateSystemConfig({
                stores: {
                    shared: { adapter: 'memory', strategy: 'row' },
                },
                queues: {
                    a: { persist: { store: 'shared' } },
                    b: { persist: { store: 'shared' } },
                },
            }),
        ).toThrow(/Store "shared" is shared by queues "a" and "b"/)
    })

    it('preserves worker on config snapshot (no JSON strip)', async () => {
        const handle = async () => undefined
        const system = await buildFromConfig({
            queues: { jobs: { worker: handle } },
        })
        expect(system.config.queues.jobs.worker).toBe(handle)
    })
})

describe('buildFromConfig integration', () => {
    it('flushAll no-ops when no persist queues', async () => {
        const system = await buildFromConfig({ queues: { a: {} } })
        await expect(system.flushAll()).resolves.toBeUndefined()
        await expect(system.hydrateAll()).resolves.toBeUndefined()
    })

    it('memory snapshot built-in adapter works', async () => {
        const system = await buildFromConfig({
            stores: {
                jobs: { adapter: 'memory', strategy: 'snapshot' },
            },
            queues: {
                jobs: {
                    persist: { store: 'jobs' },
                },
            },
        })
        system.queues.jobs.enqueue('x')
        await system.flushAll()
        expect(system.queues.jobs.toArray()).toEqual(['x'])
    })

    it('builds a full JS config (stores + workers + router + unmatched)', async () => {
        const handleMail = async (msg: RouteMessage<{ to: string; body: string }>) => ({
            to: msg.data.to,
        })
        const handleAudit = async (_msg: RouteMessage) => {
            void _msg
        }

        const config = defineConfig({
            stores: {
                mailJobs: { adapter: 'memory', strategy: 'row' },
                scratchSnap: { adapter: 'memory', strategy: 'snapshot' },
                auditDb: {
                    strategy: 'row',
                    impl: createMemoryRowStore(),
                },
            },
            queues: {
                mail: {
                    persist: { store: 'mailJobs' },
                    worker: { run: handleMail, concurrency: 2 },
                },
                audit: {
                    persist: { store: 'auditDb' },
                    worker: handleAudit,
                },
                scratch: {
                    persist: { store: 'scratchSnap', autoSave: true },
                },
                ephemeral: {},
                unrouted: {},
            },
            router: {
                bindings: [
                    { pattern: 'mail.send', queue: 'mail' },
                    { pattern: 'mail.#', queue: 'audit' },
                    { pattern: 'orders.#', queue: 'audit' },
                    { pattern: 'debug.#', queue: 'scratch' },
                ],
                unmatchedQueue: 'unrouted',
            },
            hydrate: true,
        })

        const system = await buildFromConfig(config)

        expect(Object.keys(system.stores).sort()).toEqual([
            'auditDb',
            'mailJobs',
            'scratchSnap',
        ])
        expect(system.router).toBeDefined()
        expect(system.queues.mail.isRunning?.()).toBe(true)

        const matched = system.router!.publish('mail.send', {
            to: 'a@b.c',
            body: 'sample',
        })
        // mail.send → mail + audit (mail.#)
        expect(matched).toBe(2)

        await system.flushAll()
        await viWaitFor(
            () =>
                system.queues.mail.isEmpty() &&
                !system.queues.mail.isProcessing?.(),
        )
    })

    it('rejects invalid worker concurrency in JS config', () => {
        expect(() =>
            defineConfig({
                queues: {
                    jobs: {
                        worker: {
                            run: async () => {},
                            concurrency: 0,
                        },
                    },
                },
            }),
        ).toThrow(/concurrency/)

        for (const concurrency of [NaN, Infinity, -1, 1.5]) {
            expect(() =>
                defineConfig({
                    queues: {
                        jobs: {
                            worker: {
                                run: async () => {},
                                concurrency,
                            },
                        },
                    },
                }),
            ).toThrow(/concurrency/)
        }
    })

    it('applies queue maxSize from config', async () => {
        const system = await buildFromConfig({
            queues: {
                jobs: { maxSize: 1 },
            },
        })

        system.queues.jobs.enqueue(1)
        expect(() => system.queues.jobs.enqueue(2)).toThrow(QueueFullError)
    })

    it('rejects invalid maxSize in config', () => {
        expect(() =>
            validateSystemConfig({
                queues: { jobs: { maxSize: 0 } },
            }),
        ).toThrow(/maxSize/)

        for (const maxSize of [NaN, Infinity, -1, 1.5]) {
            expect(() =>
                validateSystemConfig({
                    queues: { jobs: { maxSize } },
                }),
            ).toThrow(/maxSize/)
        }
    })
})

/** Tiny poll helper — avoids depending on fake timers for worker pumps. */
const viWaitFor = async (
    predicate: () => boolean,
    timeoutMs = 500,
): Promise<void> => {
    const start = Date.now()
    const delay = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            const schedule = (
                globalThis as unknown as {
                    setTimeout: (fn: () => void, delay: number) => unknown
                }
            ).setTimeout
            schedule(() => resolve(), ms)
        })

    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting for condition')
        }
        await delay(5)
    }
}
