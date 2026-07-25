/**
 * Forward worker failures to a distinct dead-letter queue.
 * Layers: buildQueue → withWorker → withDeadLetter (alias: withDlq)
 */
import {
  buildQueue,
  getQueueName,
  withDeadLetter,
  withWorker,
} from '@qkitt/queue'
import { line, phase, summary, title, waitIdle } from '../_log'

type Job = {
  id: string
  payload: string
}

type DeadLetterJob = {
  id: string
  payload: string
  reason: string
  from: string
}

async function main() {
  title('@qkitt/queue — with-dlq', 'source=orders  sink=orders-dlq  jobs=3')

  let completed = 0
  let deadLettered = 0
  let dlqErrors = 0

  const source = withWorker(
    buildQueue<Job>({ name: 'orders' }),
    async (job) => {
      if (job.id === 'bad') {
        throw new Error('invalid-payload')
      }
      line('worker', 'ok', `job=${job.id}`)
    },
    { concurrency: 1 },
  )

  const dlq = buildQueue<DeadLetterJob>({ name: 'orders-dlq' })

  const queue = withDeadLetter(source, dlq, {
    map: (item, error) => ({
      id: item.id,
      payload: item.payload,
      reason: error instanceof Error ? error.message : String(error),
      from: getQueueName(source) ?? 'orders',
    }),
  })

  queue.on('dlq:enqueued', ({ item, deadLetterItem }) => {
    deadLettered += 1
    line(
      'dlq',
      'sink',
      `job=${item.id}  reason=${deadLetterItem.reason}  from=${deadLetterItem.from}`,
    )
  })

  queue.on('dlq:error', ({ item, cause }) => {
    dlqErrors += 1
    const msg = cause instanceof Error ? cause.message : String(cause)
    line('dlq', 'error', `job=${item.id}  err=${msg}`)
  })

  queue.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${item.id}`)
  })

  phase('run')
  queue.enqueue({ id: 'ok-1', payload: 'a' })
  queue.enqueue({ id: 'bad', payload: 'x' })
  queue.enqueue({ id: 'ok-2', payload: 'b' })
  line('queue', 'add', 'jobs=ok-1,bad,ok-2')

  await waitIdle(queue)

  phase('dlq contents')
  for (const item of dlq.toArray()) {
    line(
      'dlq',
      'item',
      `id=${item.id}  reason=${item.reason}  from=${item.from}`,
    )
  }

  summary(
    `completed=${completed}  dead_lettered=${deadLettered}  dlq_errors=${dlqErrors}  dlq_size=${dlq.size()}`,
  )
}

void main()
