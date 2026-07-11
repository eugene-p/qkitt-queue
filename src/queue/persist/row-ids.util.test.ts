import { describe, expect, it } from 'vitest'
import { createRowIdList } from './row-ids.util'

describe('createRowIdList', () => {
    it('tracks push/shift in FIFO order', () => {
        const list = createRowIdList()
        list.push('a')
        list.push('b')
        expect(list.live()).toEqual(['a', 'b'])
        expect(list.liveCount()).toBe(2)
        expect(list.shift()).toBe('a')
        expect(list.live()).toEqual(['b'])
        expect(list.shift()).toBe('b')
        expect(list.shift()).toBeUndefined()
        expect(list.liveCount()).toBe(0)
    })

    it('reset replaces live ids', () => {
        const list = createRowIdList()
        list.push('x')
        list.reset(['1', '2'])
        expect(list.live()).toEqual(['1', '2'])
        list.reset([])
        expect(list.live()).toEqual([])
    })
})
