import { buildQueue, withWorker } from '@qkitt/queue'
import { queue as asyncQueue } from 'async'
import fastq from 'fastq'
import PQueue from 'p-queue'
import {
  printHeader,
  printNote,
  timeAlone,
  WORKER_CONCURRENCIES,
  WORKER_JOB_COUNTS,
} from './helpers.js'
import { measureRetainedStable, tryGc } from './memory.js'
import {
  mergeResult,
  printProgress,
  printWorkerTable,
  type WorkerResult,
} from './report.js'

/** Sync no-op job body shared across libraries (fairness). */
const syncNoop = (): void => {}

/**
 * Drain `@qkitt/queue` by counting finished jobs inside the worker fn.
 * Not `worker:idle` — peers complete on N jobs finished, same idea.
 */
const drainQkitt = (n: number, concurrency: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (n === 0) {
      resolve()
      return
    }

    let finished = 0
    let settled = false

    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      q.stop()
      if (error !== undefined) reject(error)
      else resolve()
    }

    const q = withWorker(
      buildQueue<number>(),
      async () => {
        try {
          syncNoop()
        } finally {
          finished += 1
          if (finished === n) finish()
        }
      },
      { concurrency },
    )

    q.on('worker:pump-error', ({ error }) => {
      finish(error)
    })

    for (let i = 0; i < n; i++) q.enqueue(i)
  })

const drainFastq = async (n: number, concurrency: number): Promise<void> => {
  const q = fastq.promise(async () => {
    syncNoop()
  }, concurrency)
  const tasks: Promise<unknown>[] = []
  for (let i = 0; i < n; i++) {
    tasks.push(q.push(i))
  }
  await Promise.all(tasks)
}

const drainPQueue = async (n: number, concurrency: number): Promise<void> => {
  const q = new PQueue({ concurrency })
  const tasks: Promise<void>[] = []
  for (let i = 0; i < n; i++) {
    tasks.push(
      q.add(async () => {
        syncNoop()
      }),
    )
  }
  await Promise.all(tasks)
}

const drainAsyncQueue = (n: number, concurrency: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (n === 0) {
      resolve()
      return
    }

    let remaining = n
    const q = asyncQueue((_task: number, cb) => {
      queueMicrotask(() => {
        try {
          syncNoop()
          cb()
        } catch (error) {
          cb(error as Error)
        }
      })
    }, concurrency)

    q.error((err) => {
      if (err) reject(err)
    })

    for (let i = 0; i < n; i++) {
      q.push(i, (err) => {
        if (err) {
          reject(err)
          return
        }
        remaining -= 1
        if (remaining === 0) resolve()
      })
    }
  })

/** Hold N pending jobs; worker not processing (fair retained-memory compare). */
const holdPendingQkitt = (n: number, concurrency: number): unknown => {
  const q = withWorker(
    buildQueue<number>(),
    async () => {
      syncNoop()
    },
    { concurrency, autoStart: false },
  )
  for (let i = 0; i < n; i++) q.enqueue(i)
  if (q.size() !== n) {
    throw new Error(`holdPendingQkitt: expected size ${n}, got ${q.size()}`)
  }
  return q
}

const holdPendingFastq = (n: number, concurrency: number): unknown => {
  const q = fastq.promise(async () => {
    syncNoop()
  }, concurrency)
  q.pause()
  for (let i = 0; i < n; i++) {
    void q.push(i)
  }
  if (q.length() !== n) {
    throw new Error(`holdPendingFastq: expected length ${n}, got ${q.length()}`)
  }
  return q
}

const holdPendingPQueue = (n: number, concurrency: number): unknown => {
  const q = new PQueue({ concurrency, autoStart: false })
  for (let i = 0; i < n; i++) {
    void q.add(async () => {
      syncNoop()
    })
  }
  if (q.size !== n) {
    throw new Error(`holdPendingPQueue: expected size ${n}, got ${q.size}`)
  }
  return q
}

const holdPendingAsyncQueue = (n: number, concurrency: number): unknown => {
  const q = asyncQueue((_task: number, cb) => {
    queueMicrotask(() => {
      syncNoop()
      cb()
    })
  }, concurrency)
  q.pause()
  for (let i = 0; i < n; i++) {
    q.push(i)
  }
  if (q.length() !== n) {
    throw new Error(
      `holdPendingAsyncQueue: expected length ${n}, got ${q.length()}`,
    )
  }
  return q
}

type WorkerCase = {
  name: string
  drain: (n: number, concurrency: number) => Promise<void>
  hold: (n: number, concurrency: number) => unknown
}

const WORKER_CASES: WorkerCase[] = [
  {
    name: '@qkitt/queue withWorker',
    drain: drainQkitt,
    hold: holdPendingQkitt,
  },
  {
    name: 'fastq',
    drain: drainFastq,
    hold: holdPendingFastq,
  },
  {
    name: 'p-queue',
    drain: drainPQueue,
    hold: holdPendingPQueue,
  },
  {
    name: 'async.queue',
    drain: drainAsyncQueue,
    hold: holdPendingAsyncQueue,
  },
]

/**
 * Worker drain: each (library × N × concurrency) cell measured alone.
 * ops/s and heap Δ answer different questions (drain speed vs size while pending).
 */
export const runWorkerBench = async (): Promise<void> => {
  printHeader('Worker drain (per library × N × concurrency)')
  printNote([
    'Cells run one at a time (library × N × concurrency; no interleaving).',
    'ops/s  — median throughput; one op = enqueue N jobs and drain until all finished.',
    'heap Δ — retained heap with N jobs still queued (worker paused / not draining).',
    'ops/s drains the queue each iteration, so heap Δ is measured on a paused fill (not peak mid-drain).',
  ])

  const results: WorkerResult[] = []
  const cells =
    WORKER_JOB_COUNTS.length *
    WORKER_CONCURRENCIES.length *
    WORKER_CASES.length
  let step = 0

  for (const jobs of WORKER_JOB_COUNTS) {
    for (const concurrency of WORKER_CONCURRENCIES) {
      for (const c of WORKER_CASES) {
        step += 1
        const cell = `N=${jobs.toLocaleString()} c=${concurrency}`
        const label = `[${step}/${cells}] ${c.name} (${cell})`
        const heldLabel = `${jobs.toLocaleString()} pending jobs (worker paused)`

        printProgress(`${label} — timing…`)
        tryGc()
        const timing = await timeAlone(
          c.name,
          () => c.drain(jobs, concurrency),
          { time: 800, warmupTime: 150 },
        )

        printProgress(`${label} — memory (${heldLabel})…`)
        const mem = measureRetainedStable(c.name, heldLabel, () =>
          c.hold(jobs, concurrency),
        )

        results.push({
          ...mergeResult(timing, mem),
          jobs,
          concurrency,
        })
      }
    }
  }

  printWorkerTable(results)
}
