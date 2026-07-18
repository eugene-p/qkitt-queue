import { describe, expect, it, vi } from 'vitest'
import { buildQueue } from '../queue/core/queue'
import { buildRouter, type RouteMessage } from './router'

describe('buildRouter', () => {
    it('routes an exact topic into a bound queue', () => {
        const router = buildRouter()
        const queue = buildQueue<RouteMessage<{ id: number }>>()

        router.bind('orders.created', queue)
        const matched = router.publish('orders.created', { id: 1 })

        expect(matched).toBe(1)
        expect(queue.toArray()).toEqual([
            { topic: 'orders.created', data: { id: 1 } },
        ])
    })

    it('supports topic-style wildcards', () => {
        const router = buildRouter()
        const oneLevel = buildQueue<RouteMessage>()
        const multi = buildQueue<RouteMessage>()
        const middle = buildQueue<RouteMessage>()

        router.bind('jobs.*', oneLevel)
        router.bind('jobs.#', multi)
        router.bind('jobs.*.send', middle)

        router.publish('jobs.email', { n: 1 })
        expect(oneLevel.size()).toBe(1)
        expect(multi.size()).toBe(1)
        expect(middle.size()).toBe(0)

        oneLevel.clear()
        multi.clear()

        router.publish('jobs.email.send', { n: 2 })
        expect(oneLevel.size()).toBe(0) // `*` is exactly one segment
        expect(multi.size()).toBe(1)
        expect(middle.size()).toBe(1)

        multi.clear()
        middle.clear()

        router.publish('jobs.email.send.eu', { n: 3 })
        expect(oneLevel.size()).toBe(0)
        expect(multi.size()).toBe(1)
        expect(middle.size()).toBe(0)
    })

    it('fan-outs to every matching binding', () => {
        const router = buildRouter()
        const a = buildQueue<RouteMessage>()
        const b = buildQueue<RouteMessage>()

        router.bind('events.#', a)
        router.bind('events.user.*', b)

        const matched = router.publish('events.user.signup', { ok: true })
        expect(matched).toBe(2)
        expect(a.size()).toBe(1)
        expect(b.size()).toBe(1)
    })

    it('emits router:unmatched when nothing binds', () => {
        const router = buildRouter()
        const unmatched = vi.fn()
        router.on('router:unmatched', unmatched)

        expect(router.publish('orphan.event', 1)).toBe(0)
        expect(unmatched).toHaveBeenCalledWith({
            topic: 'orphan.event',
            data: 1,
            delivered: false,
        })
        expect(router.unmatchedCount()).toBe(1)
        expect(router.lastUnmatched()).toEqual({
            topic: 'orphan.event',
            data: 1,
        })
    })

    it('delivers unrouted publishes to unmatchedTarget', () => {
        const sink = buildQueue<RouteMessage>()
        const router = buildRouter({ unmatchedTarget: sink })
        const unmatched = vi.fn()
        router.on('router:unmatched', unmatched)

        expect(router.publish('no.route.here', { x: 1 })).toBe(0)
        expect(sink.toArray()).toEqual([
            { topic: 'no.route.here', data: { x: 1 } },
        ])
        expect(unmatched).toHaveBeenCalledWith({
            topic: 'no.route.here',
            data: { x: 1 },
            delivered: true,
        })
        expect(router.unmatchedCount()).toBe(1)
    })

    it('does not count the unmatched sink as a matched binding', () => {
        const sink = buildQueue<RouteMessage>()
        const routed = buildQueue<RouteMessage>()
        const router = buildRouter({ unmatchedTarget: sink })
        router.bind('ok.#', routed)

        expect(router.publish('ok.one', 1)).toBe(1)
        expect(sink.isEmpty()).toBe(true)
        expect(router.unmatchedCount()).toBe(0)

        expect(router.publish('miss.one', 2)).toBe(0)
        expect(sink.size()).toBe(1)
        expect(router.unmatchedCount()).toBe(1)
    })

    it('tracks and clears unmatched stats', () => {
        const router = buildRouter()
        router.publish('a.b', 1)
        router.publish('c.d', 2)

        expect(router.unmatchedCount()).toBe(2)
        expect(router.lastUnmatched()).toEqual({ topic: 'c.d', data: 2 })

        router.clearUnmatched()
        expect(router.unmatchedCount()).toBe(0)
        expect(router.lastUnmatched()).toBeUndefined()
    })

    it('setUnmatchedTarget can attach or clear the sink', () => {
        const router = buildRouter()
        const sink = buildQueue<RouteMessage>()

        router.setUnmatchedTarget(sink)
        expect(router.getUnmatchedTarget()).toBe(sink)
        router.publish('x.y', true)
        expect(sink.size()).toBe(1)

        router.setUnmatchedTarget(undefined)
        expect(router.getUnmatchedTarget()).toBeUndefined()
        router.publish('x.z', false)
        expect(sink.size()).toBe(1)
        expect(router.lastUnmatched()).toEqual({ topic: 'x.z', data: false })
    })

    it('emits router:error when unmatchedTarget enqueue throws', () => {
        const router = buildRouter({
            unmatchedTarget: {
                enqueue: () => {
                    throw new Error('sink full')
                },
            },
        })
        const onError = vi.fn()
        const onUnmatched = vi.fn()
        router.on('router:error', onError)
        router.on('router:unmatched', onUnmatched)

        expect(router.publish('gone.away', 1)).toBe(0)
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: 'unmatched',
                topic: 'gone.away',
            }),
        )
        expect(onUnmatched).toHaveBeenCalledWith({
            topic: 'gone.away',
            data: 1,
            delivered: false,
        })
    })

    it('does not route to unmatchedTarget when a matched binding fails to enqueue', () => {
        const sink = buildQueue<RouteMessage>()
        const router = buildRouter({ unmatchedTarget: sink })
        const onUnmatched = vi.fn()
        router.on('router:unmatched', onUnmatched)

        router.bind('orders.#', {
            enqueue: () => {
                throw new Error('queue full')
            },
        })

        expect(router.publish('orders.created', { id: 1 })).toBe(1)
        expect(sink.isEmpty()).toBe(true)
        expect(onUnmatched).not.toHaveBeenCalled()
    })

    it('emits router:published with match count', () => {
        const router = buildRouter()
        const published = vi.fn()
        router.on('router:published', published)

        router.bind('smth.smth.*', buildQueue())
        router.publish('smth.smth.2', { v: 2 })

        expect(published).toHaveBeenCalledWith({
            topic: 'smth.smth.2',
            data: { v: 2 },
            matched: 1,
        })
    })

    it('unbind removes a target or whole pattern', () => {
        const router = buildRouter()
        const a = buildQueue<RouteMessage>()
        const b = buildQueue<RouteMessage>()

        router.bind('x.y', a)
        router.bind('x.y', b)
        router.unbind('x.y', a)
        router.publish('x.y', 1)

        expect(a.isEmpty()).toBe(true)
        expect(b.size()).toBe(1)

        router.unbind('x.y')
        b.clear()
        router.publish('x.y', 2)
        expect(b.isEmpty()).toBe(true)
    })

    it('bind returns an unsubscribe function', () => {
        const router = buildRouter()
        const queue = buildQueue<RouteMessage>()
        const unbind = router.bind('a.b', queue)

        unbind()
        router.publish('a.b', true)
        expect(queue.isEmpty()).toBe(true)
    })

    it('rejects invalid topics and patterns', () => {
        const router = buildRouter()
        const onError = vi.fn()
        router.on('router:error', onError)

        expect(() => router.bind('a.#.b', buildQueue())).toThrow(/Invalid route pattern/)
        expect(() => router.publish('a.*', 1)).toThrow(/Invalid publish topic/)
        expect(onError).toHaveBeenCalled()
    })

    it('works with a plain enqueue target (not only Queue)', () => {
        const router = buildRouter()
        const items: RouteMessage[] = []

        router.bind('metrics.#', {
            enqueue: (item) => {
                items.push(item)
            },
        })

        router.publish('metrics.cpu.used', 0.42)
        expect(items).toEqual([
            { topic: 'metrics.cpu.used', data: 0.42 },
        ])
    })
})
