import { describe, expect, it } from 'vitest'
import {
    assertNotHydrating,
    createHydrateGate,
    QueueHydratingError,
} from './hydrate-gate.util'

describe('createHydrateGate', () => {
    it('suppresses only while run is active', async () => {
        const gate = createHydrateGate()
        expect(gate.isSuppressing()).toBe(false)

        await gate.run(async () => {
            expect(gate.isSuppressing()).toBe(true)
        })

        expect(gate.isSuppressing()).toBe(false)
    })

    it('clears suppress flag when run throws', async () => {
        const gate = createHydrateGate()

        await expect(
            gate.run(async () => {
                throw new Error('load failed')
            }),
        ).rejects.toThrow('load failed')

        expect(gate.isSuppressing()).toBe(false)
    })

    it('rejects a second concurrent run without clearing the first', async () => {
        const gate = createHydrateGate()
        let release!: () => void
        const hold = new Promise<void>((resolve) => {
            release = resolve
        })

        const first = gate.run(async () => {
            await hold
            return 'ok'
        })

        await Promise.resolve()
        expect(gate.isSuppressing()).toBe(true)

        await expect(gate.run(async () => 'nope')).rejects.toThrow(
            /hydrate already in progress/,
        )
        // First invocation still owns the gate.
        expect(gate.isSuppressing()).toBe(true)

        release()
        await expect(first).resolves.toBe('ok')
        expect(gate.isSuppressing()).toBe(false)
    })
})

describe('assertNotHydrating', () => {
    it('throws QueueHydratingError while the gate is suppressing', async () => {
        const gate = createHydrateGate()
        await gate.run(async () => {
            expect(() => assertNotHydrating(gate)).toThrow(QueueHydratingError)
        })
        expect(() => assertNotHydrating(gate)).not.toThrow()
    })
})
