/**
 * Same-queue failure loop with hop meta on a named queue.
 * Layers: buildQueue({ name }) → withWorker → withLoop
 */
import {
  buildQueue,
  getLoopHops,
  getQueueName,
  withLoop,
  withWorker,
} from '@qkitt/queue'
import { line, phase, summary, title, waitIdle } from '../_log'

type Job = {
  id: string
}

const MAX_HOPS = 2

async function main() {
  title(
    '@qkitt/queue — with-loop',
    `name=jobs  max_hops=${MAX_HOPS}  jobs=2`,
  )

  let completed = 0
  let looped = 0
  let dropped = 0

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

  queue.on('loop:enqueued', ({ item, loopItem }) => {
    looped += 1
    line(
      'loop',
      'retry',
      `job=${item.id}  hops=${getLoopHops(loopItem, 'jobs')}`,
    )
  })

  queue.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${item.id}`)
  })

  phase('run')
  queue.enqueue({ id: 'a' })
  queue.enqueue({ id: 'b' })
  line('queue', 'add', 'jobs=a,b')

  await waitIdle(queue)
  summary(
    `completed=${completed}  looped=${looped}  dropped=${dropped}  name=${getQueueName(queue)}`,
  )
}

void main()
