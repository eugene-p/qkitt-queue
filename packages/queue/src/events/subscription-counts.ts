import type { EventCallback } from './index'

type LooseOn = (
    eventName: string,
    callback: EventCallback<unknown>,
) => () => void

/**
 * Integer listener counts for skip-payload emit paths.
 * `counts` slots are live ints for hot-path reads; `wrapOn` tracks subscribe/unsubscribe.
 */
export const createSubscriptionCounts = <
    const M extends Record<string, string>,
>(
    eventBySlot: M,
): {
    counts: { [P in keyof M]: number }
    wrapOn: <On>(on: On) => On
} => {
    const counts = {} as { [P in keyof M]: number }
    const slotByEvent = new Map<string, keyof M>()

    for (const slot of Object.keys(eventBySlot) as (keyof M)[]) {
        counts[slot] = 0
        slotByEvent.set(eventBySlot[slot], slot)
    }

    const wrapOn = <On>(on: On): On => {
        const base = on as unknown as LooseOn
        const wrapped: LooseOn = (eventName, callback) => {
            const unsubscribe = base(eventName, callback)
            const slot = slotByEvent.get(eventName)
            if (slot === undefined) return unsubscribe
            counts[slot] += 1
            return () => {
                unsubscribe()
                counts[slot] -= 1
            }
        }
        return wrapped as On
    }

    return { counts, wrapOn }
}
