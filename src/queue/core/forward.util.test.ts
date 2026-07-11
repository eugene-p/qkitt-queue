import { describe, expect, it, vi } from 'vitest'
import { forwardQueue } from './forward.util'
import {
    hasQueueLayer,
    markQueueLayer,
    PERSIST_LAYER,
    WORKER_LAYER,
} from './layers.util'
import { buildQueue } from './queue'

describe('forwardQueue', () => {
    it('forwards base queue methods', () => {
        const base = buildQueue<number>()
        base.enqueue(1)

        const wrapped = forwardQueue(base, { tag: 'x' as const })

        expect(wrapped.tag).toBe('x')
        expect(wrapped.size()).toBe(1)
        expect(wrapped.dequeue()).toBe(1)
    })

    it('lets extra override base methods', () => {
        const base = buildQueue<string>()
        const enqueue = vi.fn((item: string) => {
            base.enqueue(item)
        })

        const wrapped = forwardQueue(base, { enqueue })
        wrapped.enqueue('a')

        expect(enqueue).toHaveBeenCalledWith('a')
        expect(base.toArray()).toEqual(['a'])
    })

    it('preserves extras already on the inner queue', () => {
        const base = buildQueue<number>()
        const inner = forwardQueue(base, {
            flush: async () => undefined,
            tag: 'inner' as const,
        })

        const outer = forwardQueue(inner, {
            start: () => undefined,
        })

        expect(outer.tag).toBe('inner')
        expect(typeof outer.flush).toBe('function')
        expect(typeof outer.start).toBe('function')
    })

    it('reapplies non-enumerable layer brands from the inner queue', () => {
        const base = buildQueue<number>()
        const branded = markQueueLayer(
            markQueueLayer(base, PERSIST_LAYER),
            WORKER_LAYER,
        )
        const outer = forwardQueue(branded, { start: () => undefined })

        expect(hasQueueLayer(outer, PERSIST_LAYER)).toBe(true)
        expect(hasQueueLayer(outer, WORKER_LAYER)).toBe(true)
    })
})
