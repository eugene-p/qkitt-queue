/**
 * Same loop → dlq filter chain via @qkitt/queue-config.
 * Config fields: worker + loop + dlq on a named queue.
 */
import { getLoopHops } from '@qkitt/queue'
import { buildFromConfig, defineConfig } from '@qkitt/queue-config'
import { line, phase, summary, title, waitIdle } from '../_log'

type Job = {
  id: string
}

const MAX_HOPS = 2

async function main() {
  title(
    '@qkitt/queue-config — with-config-loop-dlq',
    `queues=jobs,failed  max_hops=${MAX_HOPS}`,
  )

  let completed = 0
  let looped = 0
  let deadLettered = 0

  const config = defineConfig({
    queues: {
      jobs: {
        worker: {
          run: async (job: Job) => {
            throw new Error(`fail-${job.id}`)
          },
          concurrency: 1,
        },
        loop: {
          filter: (job, _error, ctx) => {
            if ((ctx.previousHops ?? 0) >= MAX_HOPS) {
              line(
                'loop',
                'stop',
                `job=${(job as Job).id}  previousHops=${ctx.previousHops ?? 0}`,
              )
              return false
            }
            return true
          },
        },
        dlq: {
          queue: 'failed',
          filter: (item) => (getLoopHops(item, 'jobs') ?? 0) >= MAX_HOPS,
        },
      },
      failed: {},
    },
  })

  phase('build')
  const system = await buildFromConfig(config)
  const queue = system.queues.jobs
  const failed = system.queues.failed
  line('system', 'ready', `queues=${Object.keys(system.queues).join(',')}`)

  queue.on('loop:enqueued', ({ item, loopItem }) => {
    looped += 1
    line(
      'loop',
      'retry',
      `job=${(item as Job).id}  hops=${getLoopHops(loopItem, 'jobs')}`,
    )
  })

  queue.on('dlq:enqueued', ({ item, deadLetterItem }) => {
    deadLettered += 1
    line(
      'dlq',
      'sink',
      `job=${(item as Job).id}  hops=${getLoopHops(deadLetterItem, 'jobs')}`,
    )
  })

  queue.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${(item as Job).id}`)
  })

  phase('run')
  queue.enqueue({ id: 'a' })
  queue.enqueue({ id: 'b' })
  line('queue', 'add', 'jobs=a,b')

  await waitIdle(queue as Parameters<typeof waitIdle>[0])

  phase('failed sink')
  for (const item of failed.toArray() as Job[]) {
    line('dlq', 'item', `id=${item.id}  hops=${getLoopHops(item, 'jobs')}`)
  }

  summary(
    `completed=${completed}  looped=${looped}  dead_lettered=${deadLettered}  failed_size=${failed.size()}`,
  )
}

void main()
