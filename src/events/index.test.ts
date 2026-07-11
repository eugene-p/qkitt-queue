import { describe, expect, it, vi } from 'vitest'
import { buildEventEmitter, createTypedEmit } from './index'

type TestEvents = {
    job: { id: string }
    drained: void
    error: Error
}

describe('buildEventEmitter', () => {
    it('subscribes and emits typed payloads', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        emitter.on('job', handler)
        emitter.emit('job', { id: '1' })

        expect(handler).toHaveBeenCalledOnce()
        expect(handler).toHaveBeenCalledWith({ id: '1' })
    })

    it('returns an unsubscribe function from on()', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        const unsubscribe = emitter.on('job', handler)
        unsubscribe()
        emitter.emit('job', { id: '1' })

        expect(handler).not.toHaveBeenCalled()
    })

    it('once() fires only once', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        emitter.once('job', handler)
        emitter.emit('job', { id: '1' })
        emitter.emit('job', { id: '2' })

        expect(handler).toHaveBeenCalledOnce()
        expect(handler).toHaveBeenCalledWith({ id: '1' })
    })

    it('off() without a callback removes all listeners for that event', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const a = vi.fn()
        const b = vi.fn()

        emitter.on('job', a)
        emitter.on('job', b)
        emitter.off('job')
        emitter.emit('job', { id: '1' })

        expect(a).not.toHaveBeenCalled()
        expect(b).not.toHaveBeenCalled()
        expect(emitter.listenerCount('job')).toBe(0)
    })

    it('off() with a callback removes only that listener', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const a = vi.fn()
        const b = vi.fn()

        emitter.on('job', a)
        emitter.on('job', b)
        emitter.off('job', a)
        emitter.emit('job', { id: '1' })

        expect(a).not.toHaveBeenCalled()
        expect(b).toHaveBeenCalledOnce()
    })

    it('does not throw when off() targets a missing event or listener', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        expect(() => emitter.off('job')).not.toThrow()
        expect(() => emitter.off('job', handler)).not.toThrow()
    })

    it('clear() removes all listeners', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const job = vi.fn()
        const drained = vi.fn()

        emitter.on('job', job)
        emitter.on('drained', drained)
        emitter.clear()
        emitter.emit('job', { id: '1' })
        emitter.emit('drained', undefined)

        expect(job).not.toHaveBeenCalled()
        expect(drained).not.toHaveBeenCalled()
        expect(emitter.eventNames()).toEqual([])
    })

    it('snapshots listeners so mid-emit mutation is safe', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const late = vi.fn()
        const early = vi.fn(() => {
            emitter.on('job', late)
        })

        emitter.on('job', early)
        emitter.emit('job', { id: '1' })

        expect(early).toHaveBeenCalledOnce()
        expect(late).not.toHaveBeenCalled()

        emitter.emit('job', { id: '2' })
        expect(late).toHaveBeenCalledOnce()
        expect(late).toHaveBeenCalledWith({ id: '2' })
    })

    it('listenerCount and eventNames report current state', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        expect(emitter.listenerCount('job')).toBe(0)
        expect(emitter.eventNames()).toEqual([])

        emitter.on('job', handler)
        emitter.on('drained', vi.fn())

        expect(emitter.listenerCount('job')).toBe(1)
        expect(emitter.eventNames()).toEqual(expect.arrayContaining(['job', 'drained']))
    })

    it('expand() widens the event map on the same instance', () => {
        type Extra = {
            progress: { percent: number }
            cancelled: void
        }

        const base = buildEventEmitter<TestEvents>()
        const jobHandler = vi.fn()
        const progressHandler = vi.fn()

        base.on('job', jobHandler)

        const expanded = base.expand<Extra>()

        // Same runtime instance — existing listeners stay attached.
        expect(expanded).toBe(base)
        expect(expanded.listenerCount('job')).toBe(1)

        expanded.on('progress', progressHandler)
        expanded.emit('job', { id: '1' })
        expanded.emit('progress', { percent: 50 })

        expect(jobHandler).toHaveBeenCalledWith({ id: '1' })
        expect(progressHandler).toHaveBeenCalledWith({ percent: 50 })
        expect(expanded.eventNames()).toEqual(
            expect.arrayContaining(['job', 'progress']),
        )
    })

    it('expand() can be chained', () => {
        const emitter = buildEventEmitter<{ a: number }>()
            .expand<{ b: string }>()
            .expand<{ c: boolean }>()

        const a = vi.fn()
        const b = vi.fn()
        const c = vi.fn()

        emitter.on('a', a)
        emitter.on('b', b)
        emitter.on('c', c)

        emitter.emit('a', 1)
        emitter.emit('b', 'x')
        emitter.emit('c', true)

        expect(a).toHaveBeenCalledWith(1)
        expect(b).toHaveBeenCalledWith('x')
        expect(c).toHaveBeenCalledWith(true)
    })

    it('createTypedEmit bridges loose emit to a typed event map', () => {
        const raw = vi.fn()
        const emit = createTypedEmit<TestEvents>(raw)

        emit('job', { id: '9' })
        expect(raw).toHaveBeenCalledWith('job', { id: '9' })
    })

    it('isolates listener errors so later listeners still run', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const second = vi.fn()

        emitter.on('job', () => {
            throw new Error('listener failed')
        })
        emitter.on('job', second)

        expect(() => emitter.emit('job', { id: '1' })).not.toThrow()
        expect(second).toHaveBeenCalledWith({ id: '1' })
    })
})
