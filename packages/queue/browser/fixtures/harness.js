/**
 * Page-side helpers for Playwright. Loads built dist ESM and exposes
 * store factories + compare runners on window.__qkitt.
 */
import {
  buildQueue,
  createLocalStorageRowStore,
  createMemoryRowStore,
  createSessionStorageRowStore,
  createWebRowStore,
  withWorker,
} from '/dist/index.js'

const baseRow = (id, item) => ({
  id,
  item,
  availableAt: 0,
  leaseGeneration: null,
  leaseExpiresAt: null,
})

const serializeRows = (rows) =>
  rows.map((row) => ({
    id: row.id,
    item: row.item,
    availableAt: row.availableAt,
    leaseGeneration: row.leaseGeneration,
    leaseExpiresAt: row.leaseExpiresAt,
  }))

/**
 * @param {'none' | 'memory' | 'localStorage' | 'sessionStorage'} kind
 * @param {string} key
 */
const makeStore = (kind, key) => {
  if (kind === 'none') return undefined
  if (kind === 'memory') return createMemoryRowStore()
  if (kind === 'localStorage') return createLocalStorageRowStore(key)
  if (kind === 'sessionStorage') return createSessionStorageRowStore(key)
  throw new Error(`unknown store kind: ${kind}`)
}

/** Best-effort wipe of web-storage keys for a store prefix. */
const wipeStorageKey = (key, nHint = 0) => {
  localStorage.removeItem(`${key}:order`)
  sessionStorage.removeItem(`${key}:order`)
  const limit = Math.max(nHint + 50, 256)
  for (let i = 1; i <= limit; i += 1) {
    localStorage.removeItem(`${key}:row:${i}`)
    sessionStorage.removeItem(`${key}:row:${i}`)
  }
}

/**
 * Time fill / loadAll / clear for one store kind (no worker).
 * `kind: 'none'` is not a store — returns zeros (use drain for bare queue).
 * @param {{ kind: 'none' | 'memory' | 'localStorage' | 'sessionStorage', key: string, n: number, mode?: 'put' | 'putBatch' }} opts
 */
const timeStoreOps = (opts) => {
  const { kind, key, n, mode = 'put' } = opts
  if (kind === 'none') {
    return {
      kind,
      n,
      mode,
      fillMs: 0,
      loadAllMs: 0,
      clearMs: 0,
      loadedCount: n,
    }
  }
  if (kind !== 'memory') wipeStorageKey(key, n)

  const store = makeStore(kind, key)
  store.clear()

  const records = []
  for (let i = 1; i <= n; i += 1) {
    records.push(baseRow(i, { i, note: `item-${i}` }))
  }

  const t0 = performance.now()
  if (mode === 'putBatch' && typeof store.putBatch === 'function') {
    store.putBatch(records)
  } else {
    for (let i = 0; i < records.length; i += 1) {
      store.put(records[i])
    }
  }
  const fillMs = performance.now() - t0

  const t1 = performance.now()
  const loaded = store.loadAll()
  const loadAllMs = performance.now() - t1

  const t2 = performance.now()
  store.clear()
  const clearMs = performance.now() - t2

  return {
    kind,
    n,
    mode,
    fillMs,
    loadAllMs,
    clearMs,
    loadedCount: loaded.length,
  }
}

/**
 * Time enqueue N + drain until N finished with withWorker.
 * kind: none = bare in-memory queue; localStorage / sessionStorage = durable.
 * (memory RowStore is for store-ops / tests — not a separate drain mode.)
 * Sync no-op job body (same idea as packages/bench worker suite).
 * @param {{ kind: 'none' | 'memory' | 'localStorage' | 'sessionStorage', key: string, n: number, concurrency?: number }} opts
 */
const timeDrain = async (opts) => {
  const { kind, key, n, concurrency = 1 } = opts
  if (kind !== 'none' && kind !== 'memory') wipeStorageKey(key, n)

  const store = makeStore(kind, key)
  if (store) store.clear()

  /** @type {ReturnType<typeof withWorker> | undefined} */
  let q

  const t0 = performance.now()

  await new Promise((resolve, reject) => {
    if (n === 0) {
      resolve()
      return
    }

    let finished = 0
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      try {
        q?.stop()
      } catch {
        // ignore stop errors after settle
      }
      if (error !== undefined) reject(error)
      else resolve()
    }

    q = withWorker(
      store !== undefined ? buildQueue({ store }) : buildQueue(),
      async () => {
        // sync no-op job (ack happens after this; count completions, not entry)
      },
      { concurrency },
    )

    // Count after ack/remove so remaining store rows match finished jobs.
    q.on('worker:completed', () => {
      finished += 1
      if (finished === n) finish()
    })

    q.on('worker:pump-error', ({ error }) => {
      finish(error)
    })

    // Fire-and-forget enqueues; persist writes run on the queue write chain.
    ;(async () => {
      for (let i = 0; i < n; i += 1) {
        await q.enqueue(i)
      }
    })().catch((error) => finish(error))
  })

  // Drain any trailing write-chain work before sampling the store.
  if (q) await q.flush()

  const drainMs = performance.now() - t0
  const remaining =
    store !== undefined ? store.loadAll().length : q ? q.size() : 0

  return {
    kind,
    n,
    concurrency,
    drainMs,
    remaining,
  }
}

window.__qkitt = {
  createLocalStorageRowStore,
  createSessionStorageRowStore,
  createMemoryRowStore,
  createWebRowStore,
  buildQueue,
  withWorker,
  baseRow,
  serializeRows,
  makeStore,
  timeStoreOps,
  timeDrain,
  ready: true,
}
