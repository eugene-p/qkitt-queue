import { buildQueue, withWorker } from '@qkitt/queue'
import { queue as asyncQueue } from 'async'
import fastq from 'fastq'
import PQueue from 'p-queue'
import { Bench } from 'tinybench'
import {
  printHeader,
  WORKER_CONCURRENCIES,
  WORKER_JOB_COUNTS,
} from './helpers.js'
import { measureRetained, printMemoryTable } from './memory.js'

/** Sync no-op job body shared across libraries (fairness). */
const syncNoop = (): void => {}

/**
 * Drain `@qkitt/queue` by counting finished jobs inside the worker fn.
 *
 * Intentionally does **not** wait on `worker:idle`: peers complete via
 * Promise.all / task callbacks (N jobs ran), not an idle event. Counting in
 * the worker matches that model and proves every enqueued job was processed
 * even if the idle event were wrong or late.
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
          // Count even if the job body throws (mirrors processItem still finishing).
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

/**
 * Promise API so the worker yields (sync callback workers recurse and blow
 * the stack at a few thousand jobs).
 */
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

/**
 * Yield via queueMicrotask so the job body matches the async workers used by
 * the other libraries (a sync `cb()` would skip that hop and stack deeply).
 */
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

/**
 * Hold N pending jobs without running them (fair retained-memory compare).
 * Workers stay paused / autoStart false so the queue is full of work.
 */
const holdPendingQkitt = (n: number, concurrency: number): unknown => {
  const q = withWorker(
    buildQueue<number>(),
    async () => {
      syncNoop()
    },
    { concurrency, autoStart: false },
  )
  for (let i = 0; i < n; i++) q.enqueue(i)
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
  return q
}

const holdPendingPQueue = (n: number, concurrency: number): unknown => {
  const q = new PQueue({ concurrency, autoStart: false })
  for (let i = 0; i < n; i++) {
    void q.add(async () => {
      syncNoop()
    })
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
  return q
}

/**
 * Worker drain: enqueue N sync-no-op jobs and wait until idle.
 * Sweeps job counts × concurrencies; same N and concurrency for every library.
 * After timing, reports retained heap with N jobs still pending (paused).
 */
export const runWorkerBench = async (): Promise<void> => {
  for (const jobCount of WORKER_JOB_COUNTS) {
    for (const concurrency of WORKER_CONCURRENCIES) {
      printHeader(
        `Worker drain (${jobCount.toLocaleString()} jobs, concurrency=${concurrency})`,
      )

      const bench = new Bench({ time: 800, warmupTime: 150 })

      bench
        .add('@qkitt/queue withWorker', async () => {
          await drainQkitt(jobCount, concurrency)
        })
        .add('fastq', async () => {
          await drainFastq(jobCount, concurrency)
        })
        .add('p-queue', async () => {
          await drainPQueue(jobCount, concurrency)
        })
        .add('async.queue', async () => {
          await drainAsyncQueue(jobCount, concurrency)
        })

      await bench.run()
      console.table(bench.table())

      printMemoryTable([
        measureRetained('@qkitt/queue withWorker', () =>
          holdPendingQkitt(jobCount, concurrency),
        ),
        measureRetained('fastq', () => holdPendingFastq(jobCount, concurrency)),
        measureRetained('p-queue', () =>
          holdPendingPQueue(jobCount, concurrency),
        ),
        measureRetained('async.queue', () =>
          holdPendingAsyncQueue(jobCount, concurrency),
        ),
      ])
    }
  }
}
