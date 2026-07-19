/**
 * Concurrent job drain — backlog processed with a fixed concurrency.
 * Layers: buildQueue → withWorker
 */
import { buildQueue, withWorker } from '@qkitt/queue'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'

type Job = {
  id: number
  ms: number
}

const CONCURRENCY = 2
const JOBS: Job[] = [
  { id: 1, ms: 40 },
  { id: 2, ms: 60 },
  { id: 3, ms: 30 },
  { id: 4, ms: 50 },
  { id: 5, ms: 20 },
]

async function main() {
  title(
    '@qkitt/queue — worker-drain',
    `concurrency=${CONCURRENCY}  jobs=${JOBS.length}`,
  )

  let completed = 0
  let failed = 0

  const queue = withWorker(
    buildQueue<Job>(),
    async (job) => {
      line(
        'worker',
        'start',
        `job=${job.id}  active=${queue.activeCount()}  ms=${job.ms}`,
      )
      await sleep(job.ms)
      return 'ok'
    },
    { concurrency: CONCURRENCY },
  )

  queue.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${item.id}  active=${queue.activeCount()}`)
  })

  queue.on('worker:failed', ({ item, error }) => {
    failed += 1
    const msg = error instanceof Error ? error.message : String(error)
    line('worker', 'fail', `job=${item.id}  err=${msg}`)
  })

  phase('run')
  for (const job of JOBS) {
    queue.enqueue(job)
    line('queue', 'add', `job=${job.id}  size=${queue.size()}`)
  }

  await waitIdle(queue)
  summary(`completed=${completed}  failed=${failed}`)
}

void main()
