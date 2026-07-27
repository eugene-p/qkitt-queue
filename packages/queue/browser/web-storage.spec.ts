import { expect, test, type Page } from '@playwright/test'

type Harness = {
  ready: boolean
  createLocalStorageRowStore: (key: string) => Store
  createSessionStorageRowStore: (key: string) => Store
  createMemoryRowStore: () => Store
  createWebRowStore: (opts: {
    key: string
    storage?: Storage
  }) => Store
  baseRow: (id: number, item: unknown) => Row
  serializeRows: (rows: Row[]) => Row[]
}

type Row = {
  id: number
  item: unknown
  availableAt: number
  leaseGeneration: number | null
  leaseExpiresAt: number | null
}

type Store = {
  put: (row: Row) => void
  loadAll: () => Row[]
  remove: (id: number) => void
  clear: () => void
  putBatch?: (rows: Row[]) => void
  removeBatch?: (ids: number[]) => void
  replaceAll?: (rows: Row[]) => void
}

declare global {
  interface Window {
    __qkitt: Harness
  }
}

const waitHarness = async (page: Page): Promise<void> => {
  await page.goto('/harness.html')
  await page.waitForFunction(() => window.__qkitt?.ready === true)
}

test.describe('web storage (real browser Storage)', () => {
  test('createLocalStorageRowStore round-trips full rows', async ({
    page,
  }) => {
    await waitHarness(page)

    const rows = await page.evaluate(() => {
      const { createLocalStorageRowStore, baseRow, serializeRows } =
        window.__qkitt
      const key = 'qkitt-it-local'
      const store = createLocalStorageRowStore(key)
      store.clear()
      store.put({
        id: 1,
        item: 'job',
        availableAt: 10,
        leaseGeneration: 2,
        leaseExpiresAt: 100,
      })
      store.put(baseRow(2, { n: 2 }))
      return serializeRows(store.loadAll())
    })

    expect(rows).toEqual([
      {
        id: 1,
        item: 'job',
        availableAt: 10,
        leaseGeneration: 2,
        leaseExpiresAt: 100,
      },
      {
        id: 2,
        item: { n: 2 },
        availableAt: 0,
        leaseGeneration: null,
        leaseExpiresAt: null,
      },
    ])
  })

  test('createSessionStorageRowStore round-trips', async ({ page }) => {
    await waitHarness(page)

    const rows = await page.evaluate(() => {
      const { createSessionStorageRowStore, baseRow, serializeRows } =
        window.__qkitt
      const store = createSessionStorageRowStore('qkitt-it-session')
      store.clear()
      store.put(baseRow(7, 's'))
      return serializeRows(store.loadAll())
    })

    expect(rows).toEqual([
      {
        id: 7,
        item: 's',
        availableAt: 0,
        leaseGeneration: null,
        leaseExpiresAt: null,
      },
    ])
  })

  test('putBatch, removeBatch, replaceAll, clear', async ({ page }) => {
    await waitHarness(page)

    const result = await page.evaluate(() => {
      const { createLocalStorageRowStore, baseRow, serializeRows } =
        window.__qkitt
      const store = createLocalStorageRowStore('qkitt-it-batch')
      store.clear()
      store.putBatch?.([baseRow(1, 'a'), baseRow(2, 'b'), baseRow(3, 'c')])
      const afterPut = serializeRows(store.loadAll())
      store.removeBatch?.([1, 3])
      const afterRemove = serializeRows(store.loadAll())
      store.replaceAll?.([baseRow(9, 'z')])
      const afterReplace = serializeRows(store.loadAll())
      store.clear()
      const afterClear = serializeRows(store.loadAll())
      return { afterPut, afterRemove, afterReplace, afterClear }
    })

    expect(result.afterPut.map((r) => r.id)).toEqual([1, 2, 3])
    expect(result.afterRemove.map((r) => r.id)).toEqual([2])
    expect(result.afterReplace).toEqual([
      {
        id: 9,
        item: 'z',
        availableAt: 0,
        leaseGeneration: null,
        leaseExpiresAt: null,
      },
    ])
    expect(result.afterClear).toEqual([])
  })

  test('localStorage survives page reload', async ({ page }) => {
    await waitHarness(page)

    await page.evaluate(() => {
      const { createLocalStorageRowStore, baseRow } = window.__qkitt
      const store = createLocalStorageRowStore('qkitt-it-reload')
      store.clear()
      store.put(baseRow(1, 'before-reload'))
      store.put({
        id: 2,
        item: { ok: true },
        availableAt: 5,
        leaseGeneration: 1,
        leaseExpiresAt: 50,
      })
    })

    await page.reload()
    await page.waitForFunction(() => window.__qkitt?.ready === true)

    const rows = await page.evaluate(() => {
      const { createLocalStorageRowStore, serializeRows } = window.__qkitt
      const store = createLocalStorageRowStore('qkitt-it-reload')
      return serializeRows(store.loadAll())
    })

    expect(rows).toEqual([
      {
        id: 1,
        item: 'before-reload',
        availableAt: 0,
        leaseGeneration: null,
        leaseExpiresAt: null,
      },
      {
        id: 2,
        item: { ok: true },
        availableAt: 5,
        leaseGeneration: 1,
        leaseExpiresAt: 50,
      },
    ])
  })

  test('createWebRowStore uses injected Storage', async ({ page }) => {
    await waitHarness(page)

    const rows = await page.evaluate(() => {
      const { createWebRowStore, baseRow, serializeRows } = window.__qkitt
      const store = createWebRowStore({
        key: 'qkitt-it-web',
        storage: sessionStorage,
      })
      store.clear()
      store.put(baseRow(3, 'via-web'))
      return serializeRows(store.loadAll())
    })

    expect(rows).toEqual([
      {
        id: 3,
        item: 'via-web',
        availableAt: 0,
        leaseGeneration: null,
        leaseExpiresAt: null,
      },
    ])
  })

  test('memory store works in the same page context', async ({ page }) => {
    await waitHarness(page)

    const rows = await page.evaluate(() => {
      const { createMemoryRowStore, baseRow, serializeRows } = window.__qkitt
      const store = createMemoryRowStore()
      store.put(baseRow(1, 'm'))
      return serializeRows(store.loadAll())
    })

    expect(rows).toEqual([
      {
        id: 1,
        item: 'm',
        availableAt: 0,
        leaseGeneration: null,
        leaseExpiresAt: null,
      },
    ])
  })
})
