import { buildQueue, whenIdle, withWorker } from '@qkitt/queue'
import { queue as asyncQueue } from 'async'
import fastq from 'fastq'
import PQueue from 'p-queue'
import {
  PAYLOAD_WORKER_BYTES,
  PAYLOAD_WORKER_CONCURRENCY,
  PAYLOAD_WORKER_N,
  formatNs,
  formatOps,
  printHeader,
  printNote,
  timeAlone,
  type TimingResult,
} from './helpers.js'
import { formatBytes, measureRetainedMedian, type MemRow } from './memory.js'
import { printProgress } from './report.js'

type PayloadJob = {
  id: string
  kind: 'email.send'
  attempt: number
  tenantId: string
  body: string
}

const makeBody = (seed: number): string => {
  const chars = new Array<number>(PAYLOAD_WORKER_BYTES)
  for (let i = 0; i < chars.length; i += 1) {
    chars[i] = 97 + ((seed * 17 + i * 13) % 26)
  }
  return String.fromCharCode(...chars)
}

const makePayloads = (): PayloadJob[] =>
  Array.from({ length: PAYLOAD_WORKER_N }, (_, i) => ({
    id: `job-${i}`,
    kind: 'email.send',
    attempt: 1,
    tenantId: `tenant-${i % 32}`,
    body: makeBody(i),
  }))

let checksum = 0

/** Validate the complete payload body while reading the job envelope. */
const doWork = (job: PayloadJob): void => {
  let hash = job.id.length + job.kind.length + job.tenantId.length + job.attempt
  for (let i = 0; i < job.body.length; i += 1) {
    hash = Math.imul(hash ^ job.body.charCodeAt(i), 16_777_619)
  }
  checksum = (checksum + hash) >>> 0
}

const drainQkitt = (jobs: readonly PayloadJob[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const q = withWorker(
      buildQueue<PayloadJob>(),
      async (job) => {
        doWork(job)
        await Promise.resolve()
      },
      { concurrency: PAYLOAD_WORKER_CONCURRENCY, autoStart: false },
    )
    q.on('worker:pump-error', ({ error }) => reject(error))
    for (const job of jobs) q.enqueue(job)
    const drained = whenIdle(q)
    q.start()
    void drained.then(resolve, reject)
  })

const drainFastq = (jobs: readonly PayloadJob[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const q = fastq<PayloadJob>((job, done) => {
      queueMicrotask(() => {
        try {
          doWork(job)
          done(null)
        } catch (error) {
          done(error as Error)
        }
      })
    }, PAYLOAD_WORKER_CONCURRENCY)
    q.error((error) => {
      if (error) reject(error)
    })
    q.drain = resolve
    q.pause()
    for (const job of jobs) q.push(job)
    q.resume()
  })

const drainPQueue = (jobs: readonly PayloadJob[]): Promise<void> => {
  const q = new PQueue({
    concurrency: PAYLOAD_WORKER_CONCURRENCY,
    autoStart: false,
  })
  for (const job of jobs) {
    void q.add(async () => {
      doWork(job)
      await Promise.resolve()
    })
  }
  const drained = q.onIdle()
  q.start()
  return drained
}

const drainAsyncQueue = (jobs: readonly PayloadJob[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const q = asyncQueue((job: PayloadJob, done) => {
      queueMicrotask(() => {
        try {
          doWork(job)
          done()
        } catch (error) {
          done(error as Error)
        }
      })
    }, PAYLOAD_WORKER_CONCURRENCY)
    q.error((error) => {
      if (error) reject(error)
    })
    q.drain(() => resolve())
    q.pause()
    for (const job of jobs) q.push(job)
    q.resume()
  })

const holdQkitt = (): unknown => {
  const q = withWorker(buildQueue<PayloadJob>(), async () => undefined, {
    concurrency: PAYLOAD_WORKER_CONCURRENCY,
    autoStart: false,
  })
  for (const job of makePayloads()) q.enqueue(job)
  if (q.size() !== PAYLOAD_WORKER_N) throw new Error('qkitt hold: wrong size')
  return q
}

const holdFastq = (): unknown => {
  const q = fastq<PayloadJob>(() => undefined, PAYLOAD_WORKER_CONCURRENCY)
  q.pause()
  for (const job of makePayloads()) q.push(job)
  if (q.length() !== PAYLOAD_WORKER_N) throw new Error('fastq hold: wrong size')
  return q
}

const holdPQueue = (): unknown => {
  const q = new PQueue({
    concurrency: PAYLOAD_WORKER_CONCURRENCY,
    autoStart: false,
  })
  for (const job of makePayloads()) {
    void q.add(async () => {
      doWork(job)
      await Promise.resolve()
    })
  }
  if (q.size !== PAYLOAD_WORKER_N) throw new Error('p-queue hold: wrong size')
  return q
}

const holdAsyncQueue = (): unknown => {
  const q = asyncQueue<PayloadJob>(() => undefined, PAYLOAD_WORKER_CONCURRENCY)
  q.pause()
  for (const job of makePayloads()) q.push(job)
  if (q.length() !== PAYLOAD_WORKER_N) {
    throw new Error('async.queue hold: wrong size')
  }
  return q
}

type PayloadCase = {
  name: string
  run: () => Promise<void>
  hold: () => unknown
}

const cases = (jobs: readonly PayloadJob[]): PayloadCase[] => [
  { name: '@qkitt/queue withWorker', run: () => drainQkitt(jobs), hold: holdQkitt },
  { name: 'fastq', run: () => drainFastq(jobs), hold: holdFastq },
  { name: 'p-queue', run: () => drainPQueue(jobs), hold: holdPQueue },
  { name: 'async.queue', run: () => drainAsyncQueue(jobs), hold: holdAsyncQueue },
]

type PayloadResult = TimingResult & MemRow

const printTable = (rows: readonly PayloadResult[]): void => {
  console.log('')
  console.table(
    rows.map((row) => ({
      library: row.name,
      'ops/s med': formatOps(row.opsPerSecMed),
      'latency med': formatNs(row.latencyMedNs),
      samples: row.samples,
      'heap Δ total': formatBytes(row.heapDelta),
      'heap Δ / item': formatBytes(Math.round(row.heapDelta / PAYLOAD_WORKER_N)),
    })),
  )
}

/** A peer comparison with job-shaped payloads and a small async worker task. */
export const runPayloadWorkerBench = async (): Promise<void> => {
  const jobs = makePayloads()
  printHeader(
    `Payload worker drain (${PAYLOAD_WORKER_N.toLocaleString()} × ${PAYLOAD_WORKER_BYTES / 1024} KiB jobs, c=${PAYLOAD_WORKER_CONCURRENCY})`,
  )
  printNote([
    'Timing uses preallocated job objects; payload allocation is outside timing.',
    'Each worker reads job fields, hashes the full 1 KiB body, then yields once.',
    'One op enqueues all jobs and drains them; this is closer to application work than the async no-op scheduler matrix.',
    'Heap Δ holds a newly allocated full backlog, so total and per-item values include payloads plus runner bookkeeping.',
  ])

  const rows: PayloadResult[] = []
  for (const c of cases(jobs)) {
    printProgress(`${c.name} — timing…`)
    const timing = await timeAlone(c.name, c.run, { time: 800, warmupTime: 150 })
    printProgress(`${c.name} — memory (full payload backlog)…`)
    const memory = measureRetainedMedian(
      c.name,
      `${PAYLOAD_WORKER_N.toLocaleString()} payload jobs (worker paused)`,
      c.hold,
    )
    rows.push({ ...timing, ...memory })
  }
  if (checksum === Number.MIN_SAFE_INTEGER) throw new Error('unreachable')
  printTable(rows)
}
