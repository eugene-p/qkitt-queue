import { describe, expect, it } from 'vitest'
import {
    assertNotHydrating,
    createHydrateGate,
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
})

describe('assertNotHydrating', () => {
    it('throws while the gate is suppressing', async () => {
        const gate = createHydrateGate()
        await gate.run(async () => {
            expect(() => assertNotHydrating(gate)).toThrow(/hydrate/)
        })
        expect(() => assertNotHydrating(gate)).not.toThrow()
    })
})
