import { describe, expect, it, vi } from 'vitest'
import { buildQueue, QueueFullError } from './queue'

describe('buildQueue', () => {
    it('enqueues and dequeues in FIFO order', () => {
        const queue = buildQueue<number>()

        queue.enqueue(1)
        queue.enqueue(2)
        queue.enqueue(3)

        expect(queue.size()).toBe(3)
        expect(queue.dequeue()).toBe(1)
        expect(queue.dequeue()).toBe(2)
        expect(queue.dequeue()).toBe(3)
        expect(queue.dequeue()).toBeUndefined()
        expect(queue.isEmpty()).toBe(true)
    })

    it('peek returns the head without removing it', () => {
        const queue = buildQueue<string>()

        expect(queue.peek()).toBeUndefined()

        queue.enqueue('a')
        queue.enqueue('b')

        expect(queue.peek()).toBe('a')
        expect(queue.size()).toBe(2)
        expect(queue.dequeue()).toBe('a')
        expect(queue.peek()).toBe('b')
    })

    it('toArray returns a snapshot from head to tail', () => {
        const queue = buildQueue<number>()

        queue.enqueue(1)
        queue.enqueue(2)

        const snapshot = queue.toArray()
        expect(snapshot).toEqual([1, 2])

        snapshot.push(3)
        expect(queue.toArray()).toEqual([1, 2])
    })

    it('emits queue:enqueued with item and size', () => {
        const queue = buildQueue<string>()
        const handler = vi.fn()

        queue.on('queue:enqueued', handler)
        queue.enqueue('x')
        queue.enqueue('y')

        expect(handler).toHaveBeenCalledTimes(2)
        expect(handler).toHaveBeenNthCalledWith(1, { item: 'x', size: 1 })
        expect(handler).toHaveBeenNthCalledWith(2, { item: 'y', size: 2 })
    })

    it('emits queue:dequeued and queue:emptied when the last item is removed', () => {
        const queue = buildQueue<number>()
        const dequeued = vi.fn()
        const emptied = vi.fn()

        queue.on('queue:dequeued', dequeued)
        queue.on('queue:emptied', emptied)

        queue.enqueue(10)
        queue.enqueue(20)

        expect(queue.dequeue()).toBe(10)
        expect(dequeued).toHaveBeenLastCalledWith({ item: 10, size: 1 })
        expect(emptied).not.toHaveBeenCalled()

        expect(queue.dequeue()).toBe(20)
        expect(dequeued).toHaveBeenLastCalledWith({ item: 20, size: 0 })
        expect(emptied).toHaveBeenCalledOnce()
    })

    it('does not emit queue:emptied when dequeue is called on an empty queue', () => {
        const queue = buildQueue<number>()
        const emptied = vi.fn()

        queue.on('queue:emptied', emptied)
        expect(queue.dequeue()).toBeUndefined()

        expect(emptied).not.toHaveBeenCalled()
    })

    it('clear removes all items and emits queue:cleared', () => {
        const queue = buildQueue<number>()
        const cleared = vi.fn()

        queue.on('queue:cleared', cleared)
        queue.enqueue(1)
        queue.enqueue(2)
        queue.clear()

        expect(queue.isEmpty()).toBe(true)
        expect(queue.size()).toBe(0)
        expect(cleared).toHaveBeenCalledWith({ removed: 2 })
    })

    it('clear is a no-op when already empty', () => {
        const queue = buildQueue<number>()
        const cleared = vi.fn()

        queue.on('queue:cleared', cleared)
        queue.clear()

        expect(cleared).not.toHaveBeenCalled()
    })

    it('once and off work for queue events', () => {
        const queue = buildQueue<number>()
        const onceHandler = vi.fn()
        const offHandler = vi.fn()

        queue.once('queue:enqueued', onceHandler)
        const unsub = queue.on('queue:enqueued', offHandler)

        queue.enqueue(1)
        unsub()
        queue.enqueue(2)

        expect(onceHandler).toHaveBeenCalledOnce()
        expect(offHandler).toHaveBeenCalledOnce()
    })

    it('replaceAll sets items without emitting queue events', () => {
        const queue = buildQueue<number>()
        const enqueued = vi.fn()
        const cleared = vi.fn()
        queue.on('queue:enqueued', enqueued)
        queue.on('queue:cleared', cleared)

        queue.enqueue(1)
        enqueued.mockClear()

        queue.replaceAll([9, 8, 7])

        expect(queue.toArray()).toEqual([9, 8, 7])
        expect(enqueued).not.toHaveBeenCalled()
        expect(cleared).not.toHaveBeenCalled()
        expect(queue.dequeue()).toBe(9)
        expect(queue.dequeue()).toBe(8)
        expect(queue.dequeue()).toBe(7)
    })

    it('throws QueueFullError when maxSize is exceeded', () => {
        const queue = buildQueue<number>({ maxSize: 2 })
        queue.enqueue(1)
        queue.enqueue(2)

        expect(() => queue.enqueue(3)).toThrow(QueueFullError)
        expect(queue.toArray()).toEqual([1, 2])
        expect(() => queue.replaceAll([1, 2, 3])).toThrow(QueueFullError)
    })

    it('rejects invalid maxSize', () => {
        expect(() => buildQueue({ maxSize: 0 })).toThrow(/maxSize/)
        expect(() => buildQueue({ maxSize: NaN })).toThrow(/maxSize/)
        expect(() => buildQueue({ maxSize: Infinity })).toThrow(/maxSize/)
        expect(() => buildQueue({ maxSize: -1 })).toThrow(/maxSize/)
        expect(() => buildQueue({ maxSize: 1.5 })).toThrow(/maxSize/)
    })

    it('preserves order after many dequeues', () => {
        const queue = buildQueue<number>()
        for (let i = 0; i < 100; i += 1) {
            queue.enqueue(i)
        }
        for (let i = 0; i < 80; i += 1) {
            expect(queue.dequeue()).toBe(i)
        }
        expect(queue.toArray()).toEqual(
            Array.from({ length: 20 }, (_, i) => i + 80),
        )
        expect(queue.size()).toBe(20)
    })
})
