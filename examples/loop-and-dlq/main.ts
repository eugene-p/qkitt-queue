/**
 * Chain withLoop + withDlq via complementary filters.
 * Layers: buildQueue({ name }) → withWorker → withLoop → withDlq
 *
 * Both layers listen to worker:failed independently. Without filters,
 * every failure would re-enter and dead-letter (duplicates in the sink).
 * Complementary filters: loop while hops < MAX, dlq when hops >= MAX.
 */
import {
  buildQueue,
  getLoopHops,
  withDlq,
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
    '@qkitt/queue — loop-and-dlq',
    `name=jobs  max_hops=${MAX_HOPS}  sink=failed`,
  )

  let completed = 0
  let looped = 0
  let deadLettered = 0

  const failed = buildQueue<Job>({ name: 'failed' })

  const queue = withDlq(
    withLoop(
      withWorker(
        buildQueue<Job>({ name: 'jobs' }),
        async (job) => {
          // Always fail so hop / dlq path is visible.
          throw new Error(`fail-${job.id}`)
        },
        { concurrency: 1 },
      ),
      {
        filter: (job, _error, ctx) => {
          if ((ctx.previousHops ?? 0) >= MAX_HOPS) {
            line(
              'loop',
              'stop',
              `job=${job.id}  previousHops=${ctx.previousHops ?? 0}`,
            )
            return false
          }
          return true
        },
      },
    ),
    failed,
    {
      filter: (item) => (getLoopHops(item, 'jobs') ?? 0) >= MAX_HOPS,
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

  queue.on('dlq:enqueued', ({ item, deadLetterItem }) => {
    deadLettered += 1
    line(
      'dlq',
      'sink',
      `job=${item.id}  hops=${getLoopHops(deadLetterItem, 'jobs')}`,
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

  phase('failed sink')
  for (const item of failed.toArray()) {
    line('dlq', 'item', `id=${item.id}  hops=${getLoopHops(item, 'jobs')}`)
  }

  summary(
    `completed=${completed}  looped=${looped}  dead_lettered=${deadLettered}  failed_size=${failed.size()}`,
  )
}

void main()
