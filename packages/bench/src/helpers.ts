import { Bench } from 'tinybench'

/** Items per FIFO round (enqueue then dequeue all). */
export const FIFO_N = 50_000

/**
 * Worker drain matrix (2×2 = 4 cells).
 * Corners only: small vs large backlog × serial vs modest concurrency.
 */
export const WORKER_JOB_COUNTS = [1_000, 10_000] as const
export const WORKER_CONCURRENCIES = [1, 4] as const

/** Rows per durable lifecycle round. Kept lower because every mutation writes. */
export const DURABLE_N = 5_000

/** Workload-shaped scenarios: enough jobs to exercise a sustained pump. */
export const WORKLOAD_N = 5_000
export const WORKLOAD_BYTES = 1_024

export type TimingResult = {
  name: string
  /** Median full-cycle throughput (ops/s). One op = one bench iteration. */
  opsPerSecMed: number
  /** Median latency of one iteration (ns). */
  latencyMedNs: number
  samples: number
}

export const printHeader = (title: string): void => {
  console.log('')
  console.log(`=== ${title} ===`)
  console.log('')
}

export const printNote = (lines: readonly string[]): void => {
  for (const line of lines) {
    console.log(`  ${line}`)
  }
  console.log('')
}

/**
 * Time a single task in isolation (own Bench instance).
 * Prefer one library at a time so long runs do not interleave heap noise.
 */
export const timeAlone = async (
  name: string,
  fn: () => unknown | Promise<unknown>,
  options: { time: number; warmupTime: number },
): Promise<TimingResult> => {
  const bench = new Bench({
    time: options.time,
    warmupTime: options.warmupTime,
  })
  bench.add(name, fn)
  await bench.run()
  const task = bench.tasks[0]
  const result = task?.result
  if (!result || result.error) {
    throw result?.error ?? new Error(`timeAlone(${name}): no result`)
  }
  // tinybench latency is in ms; convert median to ns for display.
  const latencyMedMs = result.latency.p50 ?? result.latency.mean
  const opsPerSecMed = result.throughput.p50 ?? result.throughput.mean
  return {
    name,
    opsPerSecMed: Math.round(opsPerSecMed),
    latencyMedNs: Math.round(latencyMedMs * 1e6),
    samples: result.latency.samples.length,
  }
}

export const formatOps = (ops: number): string =>
  ops.toLocaleString('en-US')

export const formatNs = (ns: number): string => {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)} µs`
  return `${ns} ns`
}
