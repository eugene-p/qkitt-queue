/**
 * Same-queue failure loop with hop meta and hop-based delay.
 * Layers: buildQueue({ name }) → withWorker → withLoop
 */
import {
  buildQueue,
  getLoopHops,
  getQueueName,
  withLoop,
  withWorker,
} from '@qkitt/queue'
import { line, phase, summary, title } from '../_log'

type Job = {
  id: string
}

const MAX_HOPS = 2
const JOBS = ['a', 'b'] as const

async function main() {
  title(
    '@qkitt/queue — with-loop',
    `name=jobs  max_hops=${MAX_HOPS}  delay=hops*10ms  jobs=${JOBS.length}`,
  )

  let completed = 0
  let looped = 0
  let dropped = 0

  let settle!: () => void
  const allDone = new Promise<void>((resolve) => {
    settle = resolve
  })

  const queue = withLoop(
    withWorker(
      buildQueue<Job>({ name: 'jobs' }),
      async (job) => {
        const hops = getLoopHops(job, 'jobs')
        // Fail until hop count reaches MAX_HOPS, then succeed.
        if (hops === undefined || hops < MAX_HOPS) {
          throw new Error(`transient-${job.id}`)
        }
        line(
          'worker',
          'ok',
          `job=${job.id}  hops=${hops}  queue=${getQueueName(queue)}`,
        )
      },
      { concurrency: 1 },
    ),
    {
      // 1-based hop count only. Not durable: restart/crash drops pending delays.
      delay: (hops) => 10 * hops,
      filter: (job, _error, ctx) => {
        // Cap re-entry: after MAX_HOPS failures, drop (do not re-enqueue).
        if ((ctx.previousHops ?? 0) >= MAX_HOPS) {
          dropped += 1
          line(
            'loop',
            'drop',
            `job=${job.id}  previousHops=${ctx.previousHops ?? 0}`,
          )
          return false
        }
        return true
      },
    },
  )

  queue.on('worker:requeued', ({ item }) => {
    looped += 1
    line(
      'loop',
      'retry',
      `job=${item.id}  hops=${getLoopHops(item, 'jobs')}`,
    )
  })

  queue.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${item.id}`)
    if (completed >= JOBS.length) settle()
  })

  phase('run')
  for (const id of JOBS) {
    queue.enqueue({ id })
  }
  line('queue', 'add', `jobs=${JOBS.join(',')}`)

  // Do not use whenIdle alone: delayed re-enqueue leaves the queue empty
  // while a timer is pending, so idle can fire before the next hop.
  await allDone
  summary(
    `completed=${completed}  looped=${looped}  dropped=${dropped}  name=${getQueueName(queue)}`,
  )
}

void main()
