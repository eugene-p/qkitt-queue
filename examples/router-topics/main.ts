/**
 * Publish on topics; route into separate worker queues (exact + wildcard).
 * Layers: buildQueue → withWorker; buildRouter + bind / publish
 */
import {
  buildQueue,
  buildRouter,
  withWorker,
  type RouteMessage,
} from '@qkitt/queue'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'

type Payload = {
  id: string
}

async function main() {
  title(
    '@qkitt/queue — router-topics',
    'bindings=mail.send, metrics.#  unmatched=dlq',
  )

  let mailDone = 0
  let metricsDone = 0
  let unmatched = 0

  const mail = withWorker(
    buildQueue<RouteMessage<Payload>>(),
    async (msg) => {
      line('mail', 'handle', `topic=${msg.topic}  id=${msg.data.id}`)
      await sleep(15)
      mailDone += 1
    },
    { concurrency: 1 },
  )

  const metrics = withWorker(
    buildQueue<RouteMessage<Payload>>(),
    async (msg) => {
      line('metrics', 'handle', `topic=${msg.topic}  id=${msg.data.id}`)
      await sleep(10)
      metricsDone += 1
    },
    { concurrency: 2 },
  )

  const dlq = buildQueue<RouteMessage>()

  const router = buildRouter({ unmatchedTarget: dlq })
  router.bind('mail.send', mail)
  router.bind('metrics.#', metrics)

  router.on('router:published', ({ topic, matched }) => {
    line('route', 'pub', `topic=${topic}  matched=${matched}`)
  })

  router.on('router:unmatched', ({ topic, delivered }) => {
    unmatched += 1
    line('route', 'miss', `topic=${topic}  delivered=${delivered}`)
  })

  phase('publish')
  router.publish('mail.send', { id: 'm1' })
  router.publish('metrics.pageview', { id: 'v1' })
  router.publish('metrics.click', { id: 'c1' })
  router.publish('orders.created', { id: 'o1' }) // no binding → dlq

  await Promise.all([waitIdle(mail), waitIdle(metrics)])

  for (const msg of dlq.toArray()) {
    line(
      'dlq',
      'hold',
      `topic=${msg.topic}  id=${String((msg.data as Payload).id)}`,
    )
  }

  summary(
    `mail=${mailDone}  metrics=${metricsDone}  unmatched=${unmatched}  dlq_size=${dlq.size()}`,
  )
}

void main()
