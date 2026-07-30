import {
  buildQueue,
  createMemoryRowStore,
  whenIdle,
  withWorker,
  type RowRecord,
} from '@qkitt/queue'
import {
  DURABLE_N,
  formatNs,
  formatOps,
  printHeader,
  printNote,
  timeAlone,
  type TimingResult,
} from './helpers.js'

const rowsForHydrate = (n: number): RowRecord<number>[] => {
  const rows = new Array<RowRecord<number>>(n)
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: i + 1,
      item: i,
      availableAt: 0,
      leaseGeneration: null,
      leaseExpiresAt: null,
    }
  }
  return rows
}

/** Accept every row through the durable queue, then settle its write chain. */
const writeAndFlush = async (n: number): Promise<void> => {
  const queue = buildQueue<number>({ store: createMemoryRowStore<number>() })
  for (let i = 0; i < n; i++) {
    await queue.enqueue(i)
  }
  await queue.flush()
}

/** Simulate a fresh process: hydrate existing rows, drain them, then flush acks. */
const hydrateDrainAndFlush = async (n: number): Promise<void> => {
  const base = buildQueue<number>({
    store: createMemoryRowStore(rowsForHydrate(n)),
  })
  await base.hydrate()
  const queue = withWorker(base, async () => {}, {
    concurrency: 4,
    autoStart: false,
  })
  const drained = whenIdle(queue)
  queue.start()
  await drained
  await queue.flush()
}

const printTable = (rows: readonly TimingResult[]): void => {
  console.log('')
  console.table(
    rows.map((row) => ({
      operation: row.name,
      'ops/s med': formatOps(row.opsPerSecMed),
      'latency med': formatNs(row.latencyMedNs),
      samples: row.samples,
    })),
  )
}

/**
 * Regression suite for the queue's durable row lifecycle.
 *
 * MemoryRowStore intentionally removes storage-device latency, so this measures
 * queue bookkeeping and write-chain behavior—not a database or browser store.
 */
export const runDurableBench = async (): Promise<void> => {
  printHeader(`Durable row lifecycle (MemoryRowStore; N=${DURABLE_N.toLocaleString()})`)
  printNote([
    'Internal regression suite; it is not a comparison with external durable systems.',
    `One op writes or restores and drains ${DURABLE_N.toLocaleString()} rows.`,
    'MemoryRowStore removes device I/O so changes reflect queue durability bookkeeping.',
  ])

  const rows = [
    await timeAlone('enqueue + flush', () => writeAndFlush(DURABLE_N), {
      time: 700,
      warmupTime: 150,
    }),
    await timeAlone('hydrate + worker drain + flush', () => hydrateDrainAndFlush(DURABLE_N), {
      time: 700,
      warmupTime: 150,
    }),
  ]

  printTable(rows)
}
