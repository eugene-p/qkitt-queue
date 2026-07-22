import { describe, expect, it, vi } from 'vitest'
import {
    createMemoryRowStore,
    createMemorySnapshotStore,
    QueueFullError,
    type JsonCodec,
    type RouteMessage,
    type SnapshotStore,
    type WebStorageLike,
} from '@qkitt/queue'
import { ConfigValidationError } from './errors'
import {
    buildFromConfig,
    buildFromConfigSync,
    buildFromJson,
} from './from-config'
import { isObjectLike, isPlainObject } from './parse.util'
import {
    defineConfig,
    parseSystemConfig,
    validateJsConfig,
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

const expectConfigError = (
    fn: () => unknown,
    code: ConfigValidationError['code'],
    message?: RegExp,
): void => {
    try {
        fn()
        expect.fail('expected ConfigValidationError')
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError)
        expect((error as ConfigValidationError).code).toBe(code)
        if (message) {
            expect((error as ConfigValidationError).message).toMatch(message)
        }
    }
}

describe('isPlainObject / isObjectLike', () => {
    it('accepts plain objects and null-prototype objects', () => {
        expect(isPlainObject({})).toBe(true)
        expect(isPlainObject(Object.create(null))).toBe(true)
    })

    it('rejects arrays, null, and built-in objects', () => {
        expect(isPlainObject([])).toBe(false)
        expect(isPlainObject(null)).toBe(false)
        expect(isPlainObject(new Date())).toBe(false)
        expect(isPlainObject(new Map())).toBe(false)
        expect(isPlainObject(new Set())).toBe(false)
        expect(isPlainObject(/re/)).toBe(false)
    })

    it('isObjectLike accepts class instances and plain objects', () => {
        class Box {}
        expect(isObjectLike({})).toBe(true)
        expect(isObjectLike(new Box())).toBe(true)
        expect(isObjectLike([])).toBe(false)
        expect(isObjectLike(null)).toBe(false)
    })
})

describe('validateSystemConfig / parseSystemConfig', () => {
    it('accepts a minimal queues-only config', () => {
        const config = validateSystemConfig({
            queues: { jobs: {} },
        })
        expect(config).toEqual({ queues: { jobs: {} } })
    })

    it('rejects Date where a config object is expected', () => {
        expectConfigError(
            () => validateSystemConfig(new Date() as unknown as SystemConfig),
            'INVALID_TYPE',
            /config must be an object/,
        )
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

    it('rejects empty queues with EMPTY_QUEUES code', () => {
        expectConfigError(
            () => validateSystemConfig({ queues: {} }),
            'EMPTY_QUEUES',
            /at least one queue/,
        )
    })

    it('rejects binding to unknown queue with UNKNOWN_QUEUE code', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    queues: { a: {} },
                    router: { bindings: [{ pattern: 'x', queue: 'missing' }] },
                }),
            'UNKNOWN_QUEUE',
        )
    })

    it('rejects unmatchedQueue that is not in queues', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    queues: { a: {} },
                    router: { unmatchedQueue: 'missing' },
                }),
            'UNKNOWN_QUEUE',
            /unmatchedQueue/,
        )
    })

    it('rejects persist.store that is not in stores registry', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    queues: {
                        a: { persist: { store: 'missing' } },
                    },
                }),
            'STORE_NOT_FOUND',
        )
    })

    it('rejects invalid built-in adapter', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        s: { adapter: 'redis', strategy: 'row' },
                    },
                    queues: {
                        a: { persist: { store: 's' } },
                    },
                }),
            'INVALID_ADAPTER',
            /localStorage/,
        )
    })

    it('requires key for web adapters', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        s: { adapter: 'sessionStorage', strategy: 'row' },
                    },
                    queues: { a: { persist: { store: 's' } } },
                }),
            'KEY_REQUIRED',
            /key is required/,
        )
    })

    it('rejects invalid JSON text', () => {
        expectConfigError(
            () => parseSystemConfig('{'),
            'INVALID_JSON',
            /config JSON is invalid/,
        )
    })

    it('rejects worker in data-only JSON validation', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    queues: {
                        jobs: { worker: async () => undefined },
                    },
                }),
            'JS_ONLY_FIELD',
            /only valid in JS config/,
        )
    })

    it('rejects when two queues reference the same persist store', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        db: { adapter: 'memory', strategy: 'snapshot' },
                    },
                    queues: {
                        q1: { persist: { store: 'db' } },
                        q2: { persist: { store: 'db' } },
                    },
                }),
            'SHARED_STORE',
            /unique store instance/,
        )
    })

    it('rejects store.impl in data-only JSON validation', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        s: {
                            strategy: 'row',
                            impl: createMemoryRowStore(),
                        },
                    },
                    queues: { a: { persist: { store: 's' } } },
                }),
            'JS_ONLY_FIELD',
            /only valid in JS config/,
        )
    })
})

describe('defineConfig / validateJsConfig', () => {
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

    it('returns the same object reference (in-place validation)', () => {
        const input = {
            queues: { jobs: {} },
            extra: 1,
        }
        const result = validateJsConfig(input as typeof input & SystemConfig)
        expect(result).toBe(input)
    })

    it('rejects partial RowStore impl missing remove/clear', () => {
        expectConfigError(
            () =>
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
            'INVALID_IMPL',
            /RowStore/,
        )
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

    it('builds sessionStorage adapter path with injected storage', async () => {
        const storage = createMemoryWebStorage()
        storage.setItem('sess:snap', JSON.stringify(['session-item']))

        const system = await buildFromConfig(
            {
                stores: {
                    sess: {
                        adapter: 'sessionStorage',
                        strategy: 'snapshot',
                        key: 'sess:snap',
                    },
                },
                queues: {
                    jobs: { persist: { store: 'sess' } },
                },
            },
            { storage },
        )

        expect(system.queues.jobs.toArray()).toEqual(['session-item'])
        system.queues.jobs.enqueue('more')
        await system.flushAll()
        expect(JSON.parse(storage.getItem('sess:snap')!)).toEqual([
            'session-item',
            'more',
        ])
    })

    it('builds sessionStorage row adapter with injected storage', async () => {
        const storage = createMemoryWebStorage()
        const system = await buildFromConfig(
            {
                stores: {
                    sess: {
                        adapter: 'sessionStorage',
                        strategy: 'row',
                        key: 'sess:rows',
                    },
                },
                queues: {
                    jobs: { persist: { store: 'sess' } },
                },
            },
            { storage },
        )

        system.queues.jobs.enqueue('row-a')
        await system.flushAll()
        expect(storage.getItem('sess:rows:order')).toBeTruthy()
        expect(system.queues.jobs.size()).toBe(1)
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
        ).rejects.toMatchObject({
            name: 'ConfigValidationError',
            code: 'INVALID_IMPL',
        })
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

    it('exposes a frozen config snapshot (top-level and nested persist)', async () => {
        const system = await buildFromConfig({
            stores: {
                db: { adapter: 'memory', strategy: 'snapshot' },
            },
            queues: {
                jobs: {
                    persist: { store: 'db', autoSave: true },
                },
            },
            hydrate: false,
        })

        expect(system.config.queues.jobs.persist).toEqual({
            store: 'db',
            autoSave: true,
        })

        expect(() => {
            ;(system.config as { hydrate?: boolean }).hydrate = true
        }).toThrow()

        expect(() => {
            // Nested plain data must be frozen (was a shallow-freeze bug).
            ;(system.config.queues.jobs.persist as { autoSave: boolean }).autoSave =
                false
        }).toThrow()

        expect(() => {
            ;(system.config.stores!.db as { adapter: string }).adapter = 'localStorage'
        }).toThrow()
    })

    it('does not freeze live custom store impl on config snapshot', async () => {
        const store = createMemorySnapshotStore<string>([])
        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'snapshot', impl: store },
            },
            queues: {
                jobs: { persist: { store: 'jobs' } },
            },
            hydrate: false,
        })

        // impl must remain a live mutable store
        store.save(['ok'])
        expect(store.data).toEqual(['ok'])
        expect(system.config.stores!.jobs).toMatchObject({
            strategy: 'snapshot',
            impl: store,
        })
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

        await vi.waitFor(() => {
            expect(seen).toEqual([1, 2])
        })
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
        await vi.waitFor(() => {
            expect(seen).toEqual(['a'])
        })
        await system.flushAll()
        expect(store.rows).toEqual([])
    })

    it('rejects shared store definitions across queues', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        shared: { adapter: 'memory', strategy: 'row' },
                    },
                    queues: {
                        a: { persist: { store: 'shared' } },
                        b: { persist: { store: 'shared' } },
                    },
                }),
            'SHARED_STORE',
            /Store "shared" is shared by queues "a" and "b"/,
        )
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
    it('flushAll / persistAll no-op when no persist queues', async () => {
        const system = await buildFromConfig({ queues: { a: {} } })
        await expect(system.flushAll()).resolves.toBeUndefined()
        await expect(system.persistAll()).resolves.toBeUndefined()
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

    it('memory row built-in adapter works', async () => {
        const system = await buildFromConfig({
            stores: {
                jobs: { adapter: 'memory', strategy: 'row' },
            },
            queues: {
                jobs: { persist: { store: 'jobs' } },
            },
        })
        system.queues.jobs.enqueue('x')
        await system.flushAll()
        expect(system.queues.jobs.toArray()).toEqual(['x'])
        expect(system.queues.jobs.rowIds?.().length).toBe(1)
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
        await vi.waitFor(() => {
            expect(system.queues.mail.isEmpty()).toBe(true)
            expect(system.queues.mail.isProcessing?.()).toBe(false)
        })
    })

    it('rejects invalid worker concurrency in JS config', () => {
        expectConfigError(
            () =>
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
            'INVALID_TYPE',
            /concurrency/,
        )

        for (const concurrency of [NaN, Infinity, -1, 1.5]) {
            expectConfigError(
                () =>
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
                'INVALID_TYPE',
            )
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
        expectConfigError(
            () =>
                validateSystemConfig({
                    queues: { jobs: { maxSize: 0 } },
                }),
            'INVALID_TYPE',
            /maxSize/,
        )

        for (const maxSize of [NaN, Infinity, -1, 1.5]) {
            expectConfigError(
                () =>
                    validateSystemConfig({
                        queues: { jobs: { maxSize } },
                    }),
                'INVALID_TYPE',
            )
        }
    })
})

/**
 * Contract / drift guard: exercise the @qkitt/queue surface that
 * queue-config wires together. If peer APIs rename or drop methods,
 * these fail before consumers do.
 */
describe('queue peer API contract (integration)', () => {
    it('exposes core Queue methods on configured queues', async () => {
        const system = await buildFromConfig({
            queues: { jobs: { maxSize: 10 } },
        })
        const q = system.queues.jobs

        expect(typeof q.enqueue).toBe('function')
        expect(typeof q.dequeue).toBe('function')
        expect(typeof q.peek).toBe('function')
        expect(typeof q.size).toBe('function')
        expect(typeof q.isEmpty).toBe('function')
        expect(typeof q.toArray).toBe('function')
        expect(typeof q.clear).toBe('function')

        q.enqueue('a')
        q.enqueue('b')
        expect(q.size()).toBe(2)
        expect(q.peek()).toBe('a')
        expect(q.toArray()).toEqual(['a', 'b'])
        expect(q.dequeue()).toBe('a')
        q.clear()
        expect(q.isEmpty()).toBe(true)
    })

    it('accepts autoSaveDebounceMs on snapshot persist config', () => {
        const config = validateSystemConfig({
            stores: {
                mem: { adapter: 'memory', strategy: 'snapshot' },
            },
            queues: {
                jobs: {
                    persist: {
                        store: 'mem',
                        autoSave: true,
                        autoSaveDebounceMs: 50,
                    },
                },
            },
        })
        expect(config.queues.jobs?.persist).toEqual({
            store: 'mem',
            autoSave: true,
            autoSaveDebounceMs: 50,
        })
    })

    it('rejects invalid autoSaveDebounceMs in persist config', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        mem: { adapter: 'memory', strategy: 'snapshot' },
                    },
                    queues: {
                        jobs: {
                            persist: {
                                store: 'mem',
                                autoSaveDebounceMs: -1,
                            },
                        },
                    },
                }),
            'INVALID_TYPE',
            /autoSaveDebounceMs/,
        )
    })

    it('exposes snapshot persist helpers from withPersist', async () => {
        const system = await buildFromConfig({
            stores: {
                snap: { adapter: 'memory', strategy: 'snapshot' },
            },
            queues: {
                jobs: { persist: { store: 'snap', autoSave: false } },
            },
            hydrate: false,
        })
        const q = system.queues.jobs

        expect(typeof q.hydrate).toBe('function')
        expect(typeof q.persist).toBe('function')
        expect(typeof q.flush).toBe('function')

        q.enqueue('x')
        await q.persist!()
        const again = await buildFromConfig({
            stores: {
                snap: { adapter: 'memory', strategy: 'snapshot' },
            },
            queues: {
                jobs: { persist: { store: 'snap' } },
            },
            hydrate: false,
        })
        // new memory store — empty until hydrate of same store instance;
        // contract check is method presence + flushAll path
        await system.flushAll()
        expect(system.queues.jobs.toArray()).toEqual(['x'])
        void again
    })

    it('exposes row persist helpers from withPersist', async () => {
        const system = await buildFromConfig({
            stores: {
                rows: { adapter: 'memory', strategy: 'row' },
            },
            queues: {
                jobs: { persist: { store: 'rows' } },
            },
        })
        const q = system.queues.jobs

        expect(typeof q.hydrate).toBe('function')
        expect(typeof q.flush).toBe('function')
        expect(typeof q.rowIds).toBe('function')

        q.enqueue('r1')
        await q.flush!()
        expect(q.rowIds!().length).toBe(1)
    })

    it('exposes worker controls from withWorker', async () => {
        const seen: number[] = []
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: {
                        run: async (n: number) => {
                            seen.push(n)
                        },
                        autoStart: false,
                    },
                },
            },
        })
        const q = system.queues.jobs

        expect(typeof q.start).toBe('function')
        expect(typeof q.stop).toBe('function')
        expect(typeof q.isRunning).toBe('function')
        expect(typeof q.isProcessing).toBe('function')
        expect(q.isRunning!()).toBe(false)

        q.enqueue(1)
        q.start!()
        expect(q.isRunning!()).toBe(true)
        await vi.waitFor(() => {
            expect(seen).toEqual([1])
        })
        q.stop!()
        expect(q.isRunning!()).toBe(false)
    })

    it('exposes router methods used by config wiring', async () => {
        const system = await buildFromConfig<
            SystemConfig,
            RouteMessage<number>
        >({
            queues: { a: {}, sink: {} },
            router: {
                bindings: [{ pattern: 't.#', queue: 'a' }],
                unmatchedQueue: 'sink',
            },
        })

        const router = system.router!
        expect(typeof router.publish).toBe('function')
        expect(typeof router.bind).toBe('function')
        expect(typeof router.unmatchedCount).toBe('function')
        expect(typeof router.lastUnmatched).toBe('function')

        expect(router.publish('t.one', 1)).toBe(1)
        expect(system.queues.a.peek()).toEqual({ topic: 't.one', data: 1 })

        expect(router.publish('other', 2)).toBe(0)
        expect(router.unmatchedCount()).toBe(1)
        expect(router.lastUnmatched()).toEqual({ topic: 'other', data: 2 })
    })

    it('wires all three built-in adapters in one system', async () => {
        const storage = createMemoryWebStorage()
        const system = await buildFromConfig(
            {
                stores: {
                    mem: { adapter: 'memory', strategy: 'snapshot' },
                    local: {
                        adapter: 'localStorage',
                        strategy: 'row',
                        key: 'c:local',
                    },
                    sess: {
                        adapter: 'sessionStorage',
                        strategy: 'snapshot',
                        key: 'c:sess',
                    },
                },
                queues: {
                    qMem: { persist: { store: 'mem' } },
                    qLocal: { persist: { store: 'local' } },
                    qSess: { persist: { store: 'sess' } },
                },
            },
            { storage },
        )

        system.queues.qMem.enqueue('m')
        system.queues.qLocal.enqueue('l')
        system.queues.qSess.enqueue('s')
        await system.flushAll()

        expect(system.queues.qMem.toArray()).toEqual(['m'])
        expect(system.queues.qLocal.toArray()).toEqual(['l'])
        expect(system.queues.qSess.toArray()).toEqual(['s'])
        expect(storage.getItem('c:local:order')).toBeTruthy()
        expect(storage.getItem('c:sess')).toBeTruthy()
    })
})

describe('audit fixes (impl, persistOptions, validation, sync)', () => {
    it('accepts class-based SnapshotStore impl', async () => {
        class ClassSnap implements SnapshotStore<string> {
            data: string[] = ['classed']
            load = () => this.data
            save = (items: readonly string[]) => {
                this.data = [...items]
            }
        }
        const impl = new ClassSnap()
        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'snapshot', impl },
            },
            queues: {
                jobs: { persist: { store: 'jobs' } },
            },
        })
        expect(system.queues.jobs.toArray()).toEqual(['classed'])
        system.queues.jobs.enqueue('next')
        await system.flushAll()
        expect(impl.data).toEqual(['classed', 'next'])
    })

    it('preserves store persistOptions.autoSave when queue omits it', async () => {
        const store = createMemorySnapshotStore<string>([], {
            autoSave: false,
        })

        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'snapshot', impl: store },
            },
            queues: {
                jobs: { persist: { store: 'jobs' } },
            },
            hydrate: false,
        })

        system.queues.jobs.enqueue('y')
        // autoSave:false on store must be preserved — nothing written yet
        expect(store.data).toEqual([])
        // flush drains pending auto-saves only; explicit persist writes
        await system.flushAll()
        expect(store.data).toEqual([])
        await system.persistAll()
        expect(store.data).toEqual(['y'])
    })

    it('queue autoSave overrides store persistOptions', async () => {
        const store = createMemorySnapshotStore<string>([], {
            autoSave: false,
        })

        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'snapshot', impl: store },
            },
            queues: {
                jobs: {
                    persist: { store: 'jobs', autoSave: true },
                },
            },
            hydrate: false,
        })

        system.queues.jobs.enqueue('auto')
        await vi.waitFor(() => {
            expect(store.data).toEqual(['auto'])
        })
    })

    it('rejects autoSave on row persist config', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        r: { adapter: 'memory', strategy: 'row' },
                    },
                    queues: {
                        q: { persist: { store: 'r', autoSave: false } },
                    },
                }),
            'INVALID_FIELD',
            /autoSave is only valid for snapshot/,
        )
    })

    it('rejects autoSaveDebounceMs on row persist config', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        r: { adapter: 'memory', strategy: 'row' },
                    },
                    queues: {
                        q: {
                            persist: {
                                store: 'r',
                                autoSaveDebounceMs: 10,
                            },
                        },
                    },
                }),
            'INVALID_FIELD',
            /autoSaveDebounceMs is only valid for snapshot/,
        )
    })

    it('rejects createId on snapshot persist config', () => {
        expectConfigError(
            () =>
                defineConfig({
                    stores: {
                        s: { adapter: 'memory', strategy: 'snapshot' },
                    },
                    queues: {
                        q: {
                            persist: {
                                store: 's',
                                createId: () => 'x',
                            },
                        },
                    },
                }),
            'INVALID_FIELD',
            /createId is only valid for row/,
        )
    })

    it('rejects createId in data-only JSON validation', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        r: { adapter: 'memory', strategy: 'row' },
                    },
                    queues: {
                        q: {
                            persist: {
                                store: 'r',
                                createId: () => 'x',
                            },
                        },
                    },
                }),
            'JS_ONLY_FIELD',
            /createId/,
        )
    })

    it('applies createId for row persist from config', async () => {
        let n = 0
        const store = createMemoryRowStore<string>()
        const system = await buildFromConfig({
            stores: {
                jobs: { strategy: 'row', impl: store },
            },
            queues: {
                jobs: {
                    persist: {
                        store: 'jobs',
                        createId: () => `custom-${++n}`,
                    },
                },
            },
            hydrate: false,
        })

        system.queues.jobs.enqueue('a')
        system.queues.jobs.enqueue('b')
        await system.flushAll()
        expect(system.queues.jobs.rowIds?.()).toEqual([
            'custom-1',
            'custom-2',
        ])
        expect(store.rows.map((r) => r.id)).toEqual([
            'custom-1',
            'custom-2',
        ])
    })

    it('rejects unused stores', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        used: { adapter: 'memory', strategy: 'row' },
                        orphan: { adapter: 'memory', strategy: 'snapshot' },
                    },
                    queues: {
                        q: { persist: { store: 'used' } },
                    },
                }),
            'UNUSED_STORE',
            /orphan/,
        )
    })

    it('rejects duplicate web storage keys', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        a: {
                            adapter: 'localStorage',
                            strategy: 'row',
                            key: 'same',
                        },
                        b: {
                            adapter: 'localStorage',
                            strategy: 'snapshot',
                            key: 'same',
                        },
                    },
                    queues: {
                        q1: { persist: { store: 'a' } },
                        q2: { persist: { store: 'b' } },
                    },
                }),
            'DUPLICATE_STORAGE_KEY',
            /same/,
        )
    })

    it('allows same key on different web adapters', () => {
        const config = validateSystemConfig({
            stores: {
                a: {
                    adapter: 'localStorage',
                    strategy: 'row',
                    key: 'shared-name',
                },
                b: {
                    adapter: 'sessionStorage',
                    strategy: 'snapshot',
                    key: 'shared-name',
                },
            },
            queues: {
                q1: { persist: { store: 'a' } },
                q2: { persist: { store: 'b' } },
            },
        })
        expect(config.stores?.a).toBeDefined()
        expect(config.stores?.b).toBeDefined()
    })

    it('buildFromConfigSync works without hydrate', () => {
        const system = buildFromConfigSync({
            queues: { a: {}, b: {} },
        })
        system.queues.a.enqueue(1)
        expect(system.queues.a.dequeue()).toBe(1)
    })

    it('buildFromConfigSync throws ASYNC_REQUIRED when hydrate needed', () => {
        expectConfigError(
            () =>
                buildFromConfigSync({
                    stores: {
                        s: { adapter: 'memory', strategy: 'snapshot' },
                    },
                    queues: {
                        q: { persist: { store: 's' } },
                    },
                }),
            'ASYNC_REQUIRED',
            /hydrate/,
        )
    })

    it('buildFromConfigSync works with hydrate: false and persist', () => {
        const system = buildFromConfigSync({
            stores: {
                s: { adapter: 'memory', strategy: 'row' },
            },
            queues: {
                q: { persist: { store: 's' } },
            },
            hydrate: false,
        })
        system.queues.q.enqueue('x')
        expect(system.queues.q.size()).toBe(1)
    })

    it('applies web snapshot codec from store config', async () => {
        const storage = createMemoryWebStorage()
        const codec: JsonCodec<string[]> = {
            serialize: (items) => `WRAP:${JSON.stringify(items)}`,
            deserialize: (raw) => {
                expect(raw.startsWith('WRAP:')).toBe(true)
                return JSON.parse(raw.slice(5)) as string[]
            },
        }
        storage.setItem('q:codec', 'WRAP:["pre"]')

        const system = await buildFromConfig(
            {
                stores: {
                    snap: {
                        adapter: 'localStorage',
                        strategy: 'snapshot',
                        key: 'q:codec',
                        codec,
                    },
                },
                queues: {
                    jobs: {
                        persist: { store: 'snap', autoSave: false },
                    },
                },
            },
            { storage },
        )

        expect(system.queues.jobs.toArray()).toEqual(['pre'])
        system.queues.jobs.enqueue('live')
        await system.persistAll()
        expect(storage.getItem('q:codec')).toBe('WRAP:["pre","live"]')
    })

    it('rejects codec on memory adapter', () => {
        expectConfigError(
            () =>
                defineConfig({
                    stores: {
                        m: {
                            adapter: 'memory',
                            strategy: 'snapshot',
                            codec: {
                                serialize: () => '[]',
                                deserialize: () => [],
                            },
                        },
                    },
                    queues: {
                        q: { persist: { store: 'm' } },
                    },
                }),
            'INVALID_FIELD',
            /codec is only valid for localStorage/,
        )
    })

    it('rejects codec in JSON validation', () => {
        expectConfigError(
            () =>
                validateSystemConfig({
                    stores: {
                        s: {
                            adapter: 'localStorage',
                            strategy: 'snapshot',
                            key: 'k',
                            codec: {
                                serialize: () => '[]',
                                deserialize: () => [],
                            },
                        },
                    },
                    queues: {
                        q: { persist: { store: 's' } },
                    },
                }),
            'JS_ONLY_FIELD',
            /codec/,
        )
    })

    it('skipValidate trusts a pre-validated config', async () => {
        const config = defineConfig({
            queues: { jobs: {} },
        })
        const system = await buildFromConfig(config, { skipValidate: true })
        system.queues.jobs.enqueue(1)
        expect(system.queues.jobs.dequeue()).toBe(1)
    })
})
