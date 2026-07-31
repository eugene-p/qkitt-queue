import {
  formatNs,
  formatOps,
  type TimingResult,
} from './helpers.js'
import {
  formatBytes,
  isGcExposed,
  type MemRow,
} from './memory.js'

/** One library row: throughput (ops/s) plus held-N retained heap. */
export type LibraryResult = TimingResult & {
  heapDelta: number
  rssDelta: number
  held: string
}

export const mergeResult = (
  timing: TimingResult,
  mem: MemRow,
): LibraryResult => {
  if (timing.name !== mem.name) {
    throw new Error(
      `mergeResult: name mismatch timing=${timing.name} mem=${mem.name}`,
    )
  }
  return {
    ...timing,
    heapDelta: mem.heapDelta,
    rssDelta: mem.rssDelta,
    held: mem.held,
  }
}

export const printProgress = (message: string): void => {
  console.log(`  · ${message}`)
}

/** FIFO: one table, all libraries. */
export const printFifoTable = (
  n: number,
  rows: readonly LibraryResult[],
): void => {
  console.log('')
  console.log(`Bare FIFO results — N=${n.toLocaleString()} enqueue+dequeue per op`)
  console.log(
    '  heap Δ = median of seven post-GC samples for a full queue of N; not peak during the ops/s loop',
  )
  console.table(
    rows.map((row) => ({
      library: row.name,
      'ops/s med': formatOps(row.opsPerSecMed),
      'latency med': formatNs(row.latencyMedNs),
      samples: row.samples,
      'heap Δ (held N)': formatBytes(row.heapDelta),
      'heap Δ (B)': row.heapDelta,
    })),
  )
  printGcFootnote(rows)
}

/** Worker matrix: one row per (library × N × concurrency). */
export type WorkerResult = LibraryResult & {
  jobs: number
  concurrency: number
}

/**
 * One table per setup (N × concurrency). jobs/c are the section title, not columns.
 */
export const printWorkerTable = (rows: readonly WorkerResult[]): void => {
  console.log('')
  console.log('Scheduler drain results — one op = enqueue N jobs and drain until finished')
  console.log(
    '  heap Δ = median of seven post-GC samples with N jobs queued (worker paused); not peak during drain',
  )

  // Preserve first-seen setup order from the run.
  const setups: { jobs: number; concurrency: number }[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.jobs}:${row.concurrency}`
    if (seen.has(key)) continue
    seen.add(key)
    setups.push({ jobs: row.jobs, concurrency: row.concurrency })
  }

  for (const setup of setups) {
    const group = rows.filter(
      (row) =>
        row.jobs === setup.jobs && row.concurrency === setup.concurrency,
    )
    console.log('')
    console.log('─'.repeat(64))
    console.log(
      `  ${setup.jobs.toLocaleString()} jobs · concurrency=${setup.concurrency}`,
    )
    console.log('─'.repeat(64))
    console.table(
      group.map((row) => ({
        library: row.name,
        'ops/s med': formatOps(row.opsPerSecMed),
        'latency med': formatNs(row.latencyMedNs),
        samples: row.samples,
        'heap Δ (held N pending)': formatBytes(row.heapDelta),
        'heap Δ (B)': row.heapDelta,
      })),
    )
  }

  printGcFootnote(rows)
}

const printGcFootnote = (
  rows: readonly { heapDelta: number }[],
): void => {
  if (!isGcExposed()) {
    console.log(
      '  tip: scripts pass --expose-gc; re-run via npm run bench for tighter heap Δ',
    )
  }
  if (rows.some((row) => row.heapDelta < 0)) {
    console.log(
      '  note: negative heap Δ is residual GC noise; that cell was under-counted',
    )
  }
}
