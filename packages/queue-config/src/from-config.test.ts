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
