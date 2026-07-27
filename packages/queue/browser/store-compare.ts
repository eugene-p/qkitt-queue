/**
 * Illustrative bare vs durable wall times in headless Chromium.
 * Not a formal peer bench — machine-dependent orientation only.
 *
 * Sections:
 *   1) store ops — put / loadAll / clear on RowStore (memory vs localStorage)
 *   2) drain — withWorker enqueue N + drain:
 *        none = bare buildQueue() (in-memory only)
 *        memory = buildQueue({ store: createMemoryRowStore() })
 *        localStorage = durable Web Storage rows
 *
 * Usage (from packages/queue after build + chromium install):
 *   npx tsx browser/store-compare.ts
 *   npm run compare:stores
 */
import { chromium, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.QKITT_BROWSER_PORT ?? 4173)
const host = process.env.QKITT_BROWSER_HOST ?? '127.0.0.1'
const baseURL = `http://${host}:${port}`

type StoreOpsRow = {
  kind: string
  n: number
  mode: string
  fillMs: number
  loadAllMs: number
  clearMs: number
  loadedCount: number
}

type DrainRow = {
  kind: string
  n: number
  concurrency: number
  drainMs: number
  remaining: number
}

type QkittApi = {
  ready?: boolean
  timeStoreOps: (o: {
    kind: string
    key: string
    n: number
    mode: string
  }) => StoreOpsRow
  timeDrain: (o: {
    kind: string
    key: string
    n: number
    concurrency: number
  }) => Promise<DrainRow>
}

const STORE_NS = [1_000, 5_000] as const
/** Drain is heavier with localStorage; keep modest N × concurrency matrix. */
const DRAIN_NS = [1_000, 5_000] as const
const DRAIN_CONCURRENCIES = [1, 4] as const
/** Store-only section (no bare queue). */
const STORE_KINDS = ['memory', 'localStorage'] as const
/** Drain: bare mem vs in-process row store vs Web Storage. */
const DRAIN_KINDS = ['none', 'memory', 'localStorage'] as const

const waitForServer = async (url: string, timeoutMs = 30_000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server not ready: ${url}`)
}

const startServer = async (): Promise<ChildProcess> => {
  const child = spawn(process.execPath, [path.join(__dirname, 'static-server.mjs')], {
    env: {
      ...process.env,
      QKITT_BROWSER_PORT: String(port),
      QKITT_BROWSER_HOST: host,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  try {
    await waitForServer(`${baseURL}/harness.html`)
  } catch (error) {
    child.kill()
    throw new Error(
      `static server failed: ${error instanceof Error ? error.message : error}\n${stderr}`,
    )
  }
  return child
}

const formatMs = (ms: number): string =>
  ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`

const openHarness = async (page: Page): Promise<void> => {
  await page.goto(`${baseURL}/harness.html`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __qkitt?: { ready?: boolean } }).__qkitt?.ready ===
      true,
  )
}

const runStoreOps = async (page: Page): Promise<StoreOpsRow[]> => {
  const results: StoreOpsRow[] = []
  for (const n of STORE_NS) {
    for (const kind of STORE_KINDS) {
      await page.evaluate(
        ({ kind: k, n: count }) => {
          const api = (window as unknown as { __qkitt: QkittApi }).__qkitt
          api.timeStoreOps({
            kind: k,
            key: `qkitt-cmp-warm-${k}`,
            n: Math.min(100, count),
            mode: 'put',
          })
        },
        { kind, n },
      )

      const row = await page.evaluate(
        ({ kind: k, n: count }) => {
          const api = (window as unknown as { __qkitt: QkittApi }).__qkitt
          return api.timeStoreOps({
            kind: k,
            key: `qkitt-cmp-${k}-${count}`,
            n: count,
            mode: 'put',
          })
        },
        { kind, n },
      )
      results.push(row)
    }
  }
  return results
}

const runDrain = async (page: Page): Promise<DrainRow[]> => {
  const results: DrainRow[] = []
  for (const n of DRAIN_NS) {
    for (const concurrency of DRAIN_CONCURRENCIES) {
      for (const kind of DRAIN_KINDS) {
        // Warm with a small drain so first sample is less cold-cache biased.
        await page.evaluate(
          async ({ kind: k, concurrency: c }) => {
            const api = (window as unknown as { __qkitt: QkittApi }).__qkitt
            await api.timeDrain({
              kind: k,
              key: `qkitt-drain-warm-${k}`,
              n: 50,
              concurrency: c,
            })
          },
          { kind, concurrency },
        )

        const row = await page.evaluate(
          async ({ kind: k, n: count, concurrency: c }) => {
            const api = (window as unknown as { __qkitt: QkittApi }).__qkitt
            return api.timeDrain({
              kind: k,
              key: `qkitt-drain-${k}-${count}-c${c}`,
              n: count,
              concurrency: c,
            })
          },
          { kind, n, concurrency },
        )
        results.push(row)
      }
    }
  }
  return results
}

const printStoreOps = (rows: StoreOpsRow[]): void => {
  console.log('')
  console.log('=== Store ops (RowStore only) ===')
  console.log('  put N · loadAll · clear — no worker')
  console.log('')

  for (const n of STORE_NS) {
    const group = rows.filter((r) => r.n === n)
    console.log('─'.repeat(64))
    console.log(`  N=${n.toLocaleString()} · mode=put`)
    console.log('─'.repeat(64))
    console.table(
      group.map((r) => ({
        store: r.kind,
        fill: formatMs(r.fillMs),
        loadAll: formatMs(r.loadAllMs),
        clear: formatMs(r.clearMs),
        loaded: r.loadedCount,
      })),
    )
  }
}

const labelKind = (kind: string): string => {
  if (kind === 'none') return 'bare (no store)'
  if (kind === 'memory') return 'memory RowStore'
  if (kind === 'localStorage') return 'localStorage'
  return kind
}

const printDrain = (rows: DrainRow[]): void => {
  console.log('')
  console.log('=== Worker drain (mem vs persist) ===')
  console.log(
    '  one cycle = enqueue N + drain until N finished (sync no-op job)',
  )
  console.log(
    '  bare = buildQueue() · memory = RowStore in RAM · localStorage = Web Storage',
  )
  console.log('')

  // One table per N × concurrency (jobs/c in the title, like packages/bench).
  const setups: { n: number; concurrency: number }[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.n}:${row.concurrency}`
    if (seen.has(key)) continue
    seen.add(key)
    setups.push({ n: row.n, concurrency: row.concurrency })
  }

  for (const setup of setups) {
    const group = rows.filter(
      (r) => r.n === setup.n && r.concurrency === setup.concurrency,
    )
    console.log('─'.repeat(64))
    console.log(
      `  ${setup.n.toLocaleString()} jobs · concurrency=${setup.concurrency}`,
    )
    console.log('─'.repeat(64))
    console.table(
      group.map((r) => ({
        mode: labelKind(r.kind),
        drain: formatMs(r.drainMs),
        remaining: r.remaining,
      })),
    )
  }
}

const main = async (): Promise<void> => {
  console.log('@qkitt/queue browser mem vs persist')
  console.log(`Node ${process.version} · ${baseURL}`)
  console.log('Illustrative only — not a peer bench; varies by machine/browser')

  const server = await startServer()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await openHarness(page)

    const storeRows = await runStoreOps(page)
    for (const row of storeRows) {
      if (row.loadedCount !== row.n) {
        throw new Error(
          `store ${row.kind} N=${row.n}: loadAll count ${row.loadedCount} !== ${row.n}`,
        )
      }
    }
    printStoreOps(storeRows)

    const drainRows = await runDrain(page)
    for (const row of drainRows) {
      if (row.remaining !== 0) {
        throw new Error(
          `drain ${row.kind} N=${row.n} c=${row.concurrency}: remaining ${row.remaining}`,
        )
      }
    }
    printDrain(drainRows)
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
