import { describe, expect, it, vi } from 'vitest'
import { createMemoryRowStore, whenIdle } from '@qkitt/queue'
import {
    buildFromConfig,
    buildFromConfigSync,
    defineConfig,
} from './from-config'
import { ConfigValidationError } from './errors'

describe('buildFromConfig', () => {
    it('builds a bare named queue', async () => {
        const system = await buildFromConfig({
            queues: { jobs: {} },
        })
        await system.queues.jobs.enqueue(1)
        expect(system.queues.jobs.size()).toBe(1)
        expect(await system.queues.jobs.dequeue()).toBe(1)
    })

    it('wires memory store and hydrate reclaim', async () => {
        const store = createMemoryRowStore<number>()
        const system = await buildFromConfig({
            stores: { db: { impl: store } },
            queues: {
                jobs: { persist: { store: 'db' } },
            },
            hydrate: false,
        })
        await system.queues.jobs.enqueue(42)
        await system.queues.jobs.flush()

        const system2 = await buildFromConfig({
            stores: { db: { impl: store } },
            queues: {
                jobs: { persist: { store: 'db' } },
            },
            hydrate: false,
        })
        await system2.hydrateAll()
        expect(system2.queues.jobs.size()).toBe(1)
        expect(system2.queues.jobs.peek()).toBe(42)
    })

    it('attaches worker and processes items', async () => {
        const seen: number[] = []
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: {
                        run: async (n: number) => {
                            seen.push(n)
                        },
                        autoStart: true,
                    },
                },
            },
        })
        const idle = new Promise<void>((r) => {
            ;(system.queues.jobs.on as (e: string, cb: () => void) => void)(
                'worker:idle',
                () => r(),
            )
        })
        await system.queues.jobs.enqueue(1)
        await idle
        expect(seen).toEqual([1])
    })

    it('forwards all typed worker options', async () => {
        let receivedTrace: unknown
        let receivedTimeoutSignal = false
        const system = buildFromConfigSync({
            queues: {
                jobs: {
                    worker: {
                        run: async (_item: number, context) => {
                            receivedTrace = context?.traceContext
                            receivedTimeoutSignal = context?.signal !== undefined
                        },
                        autoStart: false,
                        timeoutMs: 10_000,
                        traceContext: (item: unknown) => ({ item }),
                        onFailure: 'fail',
                    },
                },
            },
            hydrate: false,
        })

        ;(system.queues.jobs as never as { start: () => void }).start()
        await system.queues.jobs.enqueue(7)
        await whenIdle(system.queues.jobs as never)

        expect(receivedTrace).toEqual({ item: 7 })
        expect(receivedTimeoutSignal).toBe(true)
    })

    it('withLoop requeues failures', async () => {
        let attempts = 0
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: async () => {
                        attempts += 1
                        if (attempts < 2) throw new Error('retry')
                    },
                    loop: true,
                },
            },
        })
        const idle = new Promise<void>((r) => {
            ;(system.queues.jobs.on as (e: string, cb: () => void) => void)(
                'worker:idle',
                () => r(),
            )
        })
        await system.queues.jobs.enqueue({ n: 1 })
        await idle
        expect(attempts).toBe(2)
    })

    it('configures durable retry policy', async () => {
        let attempts = 0
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: async () => {
                        attempts += 1
                        if (attempts === 1) throw new Error('retry')
                    },
                    retry: {
                        maxAttempts: 2,
                        initialDelayMs: 0,
                        maxDelayMs: 0,
                        jitter: 0,
                    },
                },
            },
        })
        await system.queues.jobs.enqueue(1)
        await whenIdle(system.queues.jobs as never)
        expect(attempts).toBe(2)
    })

    it('configures DLQ handoff limits', async () => {
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: async () => {
                        throw new Error('failed')
                    },
                    dlq: { queue: 'dead', maxHandoffAttempts: 1 },
                },
                dead: {},
            },
        })
        await system.queues.jobs.enqueue('bad')
        await whenIdle(system.queues.jobs as never)
        expect(system.queues.dead.toArray()).toEqual(['bad'])
    })

    it('configures observability hooks and metrics', async () => {
        const reports: unknown[] = []
        const system = await buildFromConfig({
            queues: {
                jobs: {
                    worker: async () => {},
                    observability: {
                        onMetrics: (metrics) => reports.push(metrics),
                    },
                },
            },
        })
        await system.queues.jobs.enqueue('ok')
        await whenIdle(system.queues.jobs as never)
        expect(typeof system.queues.jobs.metrics).toBe('function')
        expect(reports.length).toBeGreaterThan(0)
    })

    it('defineConfig rejects snapshot strategy', () => {
        expect(() =>
            defineConfig({
                stores: {
                    db: {
                        adapter: 'memory',
                        strategy: 'snapshot',
                    } as never,
                },
                queues: { q: { persist: { store: 'db' } } },
            }),
        ).toThrow(ConfigValidationError)
    })

    it('buildFromConfigSync is an alias', () => {
        const system = buildFromConfigSync({
            queues: { a: {} },
            hydrate: false,
        })
        expect(system.queues.a).toBeDefined()
    })

    it('rejects unknown store reference', async () => {
        await expect(
            buildFromConfig({
                queues: { q: { persist: { store: 'missing' } } },
            }),
        ).rejects.toBeInstanceOf(ConfigValidationError)
    })

    it('rejects invalid runtime worker policies', () => {
        expect(() =>
            defineConfig({
                queues: {
                    jobs: {
                        worker: {
                            run: () => {},
                            onFailure: 123 as never,
                        },
                    },
                },
            }),
        ).toThrow(ConfigValidationError)
    })

    it('rejects retry without a worker and invalid retry bounds', () => {
        expect(() =>
            defineConfig({ queues: { jobs: { retry: true } } }),
        ).toThrow(ConfigValidationError)
        expect(() =>
            defineConfig({
                queues: {
                    jobs: {
                        worker: () => {},
                        retry: { initialDelayMs: 10, maxDelayMs: 1 },
                    },
                },
            }),
        ).toThrow(ConfigValidationError)
    })

    it('rejects conflicting retry and loop recovery policies', () => {
        expect(() =>
            defineConfig({
                queues: {
                    jobs: {
                        worker: () => {},
                        retry: true,
                        loop: true,
                    },
                },
            }),
        ).toThrow(ConfigValidationError)
        expect(() =>
            defineConfig({
                queues: {
                    jobs: {
                        worker: { run: () => {}, onFailure: 'loop' },
                        retry: true,
                    },
                },
            }),
        ).toThrow(ConfigValidationError)
    })

    it('memory adapter works without strategy field', async () => {
        const system = await buildFromConfig({
            stores: { mem: { adapter: 'memory' } },
            queues: { q: { persist: { store: 'mem' } } },
            hydrate: false,
        })
        await system.queues.q.enqueue('x')
        await system.flushAll()
        expect(system.stores.mem).toBeDefined()
    })

    it('hydrates before auto-start workers claim restored rows', async () => {
        const store = createMemoryRowStore<number>()
        const writer = buildFromConfigSync({
            stores: { db: { impl: store } },
            queues: { jobs: { persist: { store: 'db' } } },
            hydrate: false,
        })
        await writer.queues.jobs.enqueue(42)
        await writer.flushAll()

        const seen: number[] = []
        let started!: () => void
        const startedWorker = new Promise<void>((resolve) => {
            started = resolve
        })
        let release!: () => void
        const releaseWorker = new Promise<void>((resolve) => {
            release = resolve
        })
        const system = await buildFromConfig({
            stores: { db: { impl: store } },
            queues: {
                jobs: {
                    persist: { store: 'db' },
                    worker: async (item: number) => {
                        seen.push(item)
                        started()
                        await releaseWorker
                    },
                },
            },
        })

        await startedWorker
        expect(system.queues.jobs.isProcessing?.()).toBe(true)
        release()
        await whenIdle(system.queues.jobs as never)
        expect(seen).toEqual([42])
    })

    it('sync build requires hydrate: false for durable queues', () => {
        expect(() =>
            buildFromConfigSync({
                stores: { db: { impl: createMemoryRowStore() } },
                queues: { jobs: { persist: { store: 'db' } } },
            }),
        ).toThrow(expect.objectContaining({ code: 'ASYNC_REQUIRED' }))
    })
})
