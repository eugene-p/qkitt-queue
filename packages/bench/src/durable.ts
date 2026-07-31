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
import {
  measureRetainedMedianAsync,
  type MemRow,
} from './memory.js'
import {
  heapTableColumns,
  printGcFootnote,
  printProgress,
} from './report.js'

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

/**
 * Hold N durable rows still pending (not drained). Writes are flushed so the
 * store owns settled row records; the in-memory FIFO still references them.
 */
const holdDurablePending = async (): Promise<unknown> => {
  const store = createMemoryRowStore<number>()
  const queue = buildQueue<number>({ store })
  for (let i = 0; i < DURABLE_N; i++) {
    await queue.enqueue(i)
  }
  await queue.flush()
  if (queue.size() !== DURABLE_N) {
    throw new Error(
      `holdDurablePending: expected size ${DURABLE_N}, got ${queue.size()}`,
    )
  }
  // Keep store + queue alive for the sample.
  return { queue, store }
}

type DurableTimingRow = TimingResult
type DurableHeapRow = MemRow & { pendingN: number }

const printTimingTable = (rows: readonly DurableTimingRow[]): void => {
  console.log('')
  console.log('Throughput')
  console.table(
    rows.map((row) => ({
      operation: row.name,
      'ops/s med': formatOps(row.opsPerSecMed),
      'latency med': formatNs(row.latencyMedNs),
      samples: row.samples,
    })),
  )
}

const printHeapTable = (rows: readonly DurableHeapRow[]): void => {
  console.log('')
  console.log('Retained heap (pending durable rows; not drained)')
  console.log(
    '  heap Δ = median of seven post-GC samples with N rows enqueued + flushed; not peak during ops/s',
  )
  console.table(
    rows.map((row) => ({
      scenario: row.name,
      held: row.held,
      ...heapTableColumns(row.heapDelta, row.pendingN),
    })),
  )
  printGcFootnote(rows)
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
    'Heap Δ holds N enqueued rows after flush (still pending — not drained).',
  ])

  printProgress('enqueue + flush — timing…')
  const timingRows = [
    await timeAlone('enqueue + flush', () => writeAndFlush(DURABLE_N), {
      time: 700,
      warmupTime: 150,
    }),
    await timeAlone('hydrate + worker drain + flush', () => hydrateDrainAndFlush(DURABLE_N), {
      time: 700,
      warmupTime: 150,
    }),
  ]
  printTimingTable(timingRows)

  const heldLabel = `${DURABLE_N.toLocaleString()} durable rows pending (flushed, not drained)`
  printProgress(`retained heap — ${heldLabel}…`)
  const heap = await measureRetainedMedianAsync(
    'enqueued + flush (pending)',
    heldLabel,
    holdDurablePending,
  )
  printHeapTable([{ ...heap, pendingN: DURABLE_N }])
}
