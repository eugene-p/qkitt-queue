import { buildQueue, whenIdle, withWorker } from '@qkitt/queue'
import {
  WORKLOAD_BYTES,
  WORKLOAD_N,
  formatNs,
  formatOps,
  printHeader,
  printNote,
  timeAlone,
  type TimingResult,
} from './helpers.js'
import { measureRetainedMedian, type MemRow } from './memory.js'
import {
  heapTableColumns,
  printGcFootnote,
  printProgress,
} from './report.js'

const makePayloads = (n: number): Uint8Array[] => {
  const payloads = new Array<Uint8Array>(n)
  for (let i = 0; i < n; i++) {
    const body = new Uint8Array(WORKLOAD_BYTES)
    body[0] = i & 0xff
    body[WORKLOAD_BYTES - 1] = (i >>> 8) & 0xff
    payloads[i] = body
  }
  return payloads
}

/**
 * Hold a full burst backlog: fresh payloads + paused worker (autoStart false).
 * Allocation is inside the sample so total heap includes job bodies.
 */
const holdBurstPending = (): unknown => {
  const queue = withWorker(
    buildQueue<Uint8Array>(),
    async () => undefined,
    { concurrency: 4, autoStart: false },
  )
  const payloads = makePayloads(WORKLOAD_N)
  for (const body of payloads) queue.enqueue(body)
  if (queue.size() !== WORKLOAD_N) {
    throw new Error(
      `holdBurstPending: expected size ${WORKLOAD_N}, got ${queue.size()}`,
    )
  }
  return queue
}

type WorkloadTimingRow = TimingResult
type WorkloadHeapRow = MemRow & { pendingN: number }

const printTimingTable = (rows: readonly WorkloadTimingRow[]): void => {
  console.log('')
  console.log('Throughput')
  console.table(
    rows.map((row) => ({
      scenario: row.name,
      'ops/s med': formatOps(row.opsPerSecMed),
      'latency med': formatNs(row.latencyMedNs),
      samples: row.samples,
    })),
  )
}

const printHeapTable = (rows: readonly WorkloadHeapRow[]): void => {
  console.log('')
  console.log('Retained heap (burst pending; worker paused)')
  console.log(
    '  heap Δ = median of seven post-GC samples with N jobs queued; includes 1 KiB bodies + bookkeeping',
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
 * Product-shaped, qkitt-only scenarios. These are regression checks rather
 * than peer comparisons: payload allocation happens before timing and the
 * worker reads the bytes so the queue carries real references.
 */
export const runWorkloadBench = async (): Promise<void> => {
  const payloads = makePayloads(WORKLOAD_N)
  let checksum = 0

  const runBurst = async (): Promise<void> => {
    const queue = withWorker(
      buildQueue<Uint8Array>(),
      async (body) => {
        checksum += body[0]! + body[WORKLOAD_BYTES - 1]!
        await Promise.resolve()
      },
      { concurrency: 4, autoStart: false },
    )
    for (const body of payloads) queue.enqueue(body)
    const drained = whenIdle(queue)
    queue.start()
    await drained
  }

  const runSteady = async (): Promise<void> => {
    const queue = withWorker(
      buildQueue<Uint8Array>(),
      async (body) => {
        checksum += body[0]! + body[WORKLOAD_BYTES - 1]!
        await Promise.resolve()
      },
      { concurrency: 4 },
    )
    for (let start = 0; start < payloads.length; start += 100) {
      const end = Math.min(start + 100, payloads.length)
      for (let i = start; i < end; i++) queue.enqueue(payloads[i]!)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await whenIdle(queue)
  }

  printHeader(
    `Workload shapes (qkitt only; ${WORKLOAD_N.toLocaleString()} × ${WORKLOAD_BYTES / 1024} KiB jobs)`,
  )
  printNote([
    'Regression scenarios, not peer comparisons.',
    'Payloads are allocated before timing; workers read payload bytes and yield once.',
    'Burst starts after all jobs are accepted. Steady producer yields after each 100-job batch.',
    'Heap Δ samples a fresh burst backlog (worker paused) so total and per-job include bodies.',
  ])

  printProgress('burst drain, c=4 — timing…')
  const timingRows = [
    await timeAlone('burst drain, c=4', runBurst, {
      time: 700,
      warmupTime: 150,
    }),
    await timeAlone('steady producer, c=4', runSteady, {
      time: 700,
      warmupTime: 150,
    }),
  ]
  if (checksum === Number.MIN_SAFE_INTEGER) throw new Error('unreachable')
  printTimingTable(timingRows)

  const heldLabel = `${WORKLOAD_N.toLocaleString()} × ${WORKLOAD_BYTES / 1024} KiB pending (worker paused)`
  printProgress(`retained heap — ${heldLabel}…`)
  const heap = measureRetainedMedian(
    'burst pending',
    heldLabel,
    holdBurstPending,
  )
  printHeapTable([{ ...heap, pendingN: WORKLOAD_N }])
}
