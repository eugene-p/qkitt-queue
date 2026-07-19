/**
 * Same multi-queue story via declarative config.
 * Package: @qkitt/queue-config (defineConfig + buildFromConfig)
 */
import { type RouteMessage } from '@qkitt/queue'
import { buildFromConfig, defineConfig } from '@qkitt/queue-config'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'

type Payload = {
  id: string
}

async function main() {
  title(
    '@qkitt/queue-config — with-config',
    'queues=mail,jobs,unrouted  router=on',
  )

  let mailDone = 0
  let jobsDone = 0

  const config = defineConfig({
    queues: {
      mail: {
        worker: {
          run: async (msg: RouteMessage<Payload>) => {
            line('mail', 'handle', `topic=${msg.topic}  id=${msg.data.id}`)
            await sleep(15)
            mailDone += 1
          },
          concurrency: 1,
        },
      },
      jobs: {
        worker: {
          run: async (msg: RouteMessage<Payload>) => {
            line('jobs', 'handle', `topic=${msg.topic}  id=${msg.data.id}`)
            await sleep(15)
            jobsDone += 1
          },
          concurrency: 2,
        },
      },
      unrouted: {},
    },
    router: {
      bindings: [
        { pattern: 'mail.#', queue: 'mail' },
        { pattern: 'jobs.#', queue: 'jobs' },
      ],
      unmatchedQueue: 'unrouted',
    },
  })

  phase('build')
  const system = await buildFromConfig(config)
  line('system', 'ready', `queues=${Object.keys(system.queues).join(',')}`)

  phase('publish')
  const router = system.router!
  line(
    'route',
    'pub',
    `topic=mail.send  matched=${router.publish('mail.send', { id: 'm1' })}`,
  )
  line(
    'route',
    'pub',
    `topic=jobs.run  matched=${router.publish('jobs.run', { id: 'j1' })}`,
  )
  line(
    'route',
    'pub',
    `topic=jobs.run  matched=${router.publish('jobs.run', { id: 'j2' })}`,
  )
  line(
    'route',
    'pub',
    `topic=other.x  matched=${router.publish('other.x', { id: 'x1' })}`,
  )

  await Promise.all([
    waitIdle(system.queues.mail as Parameters<typeof waitIdle>[0]),
    waitIdle(system.queues.jobs as Parameters<typeof waitIdle>[0]),
  ])

  const dlq = system.queues.unrouted
  for (const msg of dlq.toArray() as RouteMessage<Payload>[]) {
    line('dlq', 'hold', `topic=${msg.topic}  id=${msg.data.id}`)
  }

  summary(`mail=${mailDone}  jobs=${jobsDone}  unrouted=${dlq.size()}`)
}

void main()
