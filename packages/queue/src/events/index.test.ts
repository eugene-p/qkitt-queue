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

    it('emitLazy skips create when there are no listeners', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const create = vi.fn(() => ({ id: '1' }))

        emitter.emitLazy('job', create)

        expect(create).not.toHaveBeenCalled()
    })

    it('emitLazy builds the payload only when listeners exist', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()
        const create = vi.fn(() => ({ id: 'lazy' }))

        emitter.on('job', handler)
        emitter.emitLazy('job', create)

        expect(create).toHaveBeenCalledOnce()
        expect(handler).toHaveBeenCalledWith({ id: 'lazy' })
    })

    it('hasListeners reflects subscription state', () => {
        const emitter = buildEventEmitter<TestEvents>()
        expect(emitter.hasListeners('job')).toBe(false)

        const off = emitter.on('job', () => {})
        expect(emitter.hasListeners('job')).toBe(true)

        off()
        expect(emitter.hasListeners('job')).toBe(false)
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

    it('once() unsubscribe is safe before firing', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        const unsubscribe = emitter.once('job', handler)
        unsubscribe()
        emitter.emit('job', { id: '1' })

        expect(handler).not.toHaveBeenCalled()
    })

    it('once() unsubscribe is safe after firing', () => {
        const emitter = buildEventEmitter<TestEvents>()
        const handler = vi.fn()

        const unsubscribe = emitter.once('job', handler)
        emitter.emit('job', { id: '1' })
        expect(() => unsubscribe()).not.toThrow()
        expect(handler).toHaveBeenCalledOnce()
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
