/**
 * Drain vs shutdown: whenIdle (full empty) vs gracefulStop (in-flight only).
 * Layers: buildQueue → withWorker
 */
import {
  buildQueue,
  gracefulStop,
  whenIdle,
  withWorker,
} from '@qkitt/queue'
import { line, phase, sleep, summary, title } from '../_log'

type Job = {
  id: number
  ms: number
}

async function main() {
  title('@qkitt/queue — lifecycle', 'whenIdle + gracefulStop')

  // --- phase 1: drain everything currently queued ---
  phase('whenIdle — full drain')

  let drained = 0
  const drainQueue = withWorker(
    buildQueue<Job>(),
    async (job) => {
      line('worker', 'run', `job=${job.id}  ms=${job.ms}`)
      await sleep(job.ms)
      drained += 1
    },
    { concurrency: 2 },
  )

  for (const job of [
    { id: 1, ms: 25 },
    { id: 2, ms: 35 },
    { id: 3, ms: 20 },
  ]) {
    await drainQueue.enqueue(job)
    line('queue', 'add', `job=${job.id}`)
  }

  await whenIdle(drainQueue)
  line('idle', 'done', `drained=${drained}  size=${drainQueue.size()}`)

  // --- phase 2: SIGTERM-style stop — finish in-flight, keep remainder ---
  phase('gracefulStop — in-flight only')

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let finished = 0

  const queue = withWorker(
    buildQueue<Job>(),
    async (job) => {
      line(
        'worker',
        'start',
        `job=${job.id}  active=${queue.activeCount()}`,
      )
      await gate
      finished += 1
      line('worker', 'done', `job=${job.id}`)
    },
    { concurrency: 1 },
  )

  await queue.enqueue({ id: 10, ms: 0 })
  await queue.enqueue({ id: 11, ms: 0 })
  await queue.enqueue({ id: 12, ms: 0 })
  line('queue', 'add', 'jobs=10,11,12  (10 in-flight, 11–12 waiting)')
  await sleep(0)

  line(
    'stop',
    'begin',
    `running=${queue.isRunning()}  processing=${queue.isProcessing()}  size=${queue.size()}`,
  )

  const stopping = gracefulStop(queue)
  release()
  await stopping

  line(
    'stop',
    'done',
    `running=${queue.isRunning()}  size=${queue.size()}  finished=${finished}`,
  )
  line(
    'note',
    'left',
    'remainder stayed queued — not a full drain; use whenIdle for that',
  )

  summary(
    `whenIdle drained=${drained}  gracefulStop finished=${finished}  remaining=${queue.size()}`,
  )
}

void main()
