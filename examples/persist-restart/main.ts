/**
 * Survive a "crash": row persist, drop the queue, hydrate and finish work.
 * Layers: buildQueue({ store }) → withWorker
 */
import {
  buildQueue,
  createMemoryRowStore,
  withWorker,
} from '@qkitt/queue'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'

type Job = {
  id: number
}

async function main() {
  const store = createMemoryRowStore<Job>()

  title('@qkitt/queue — persist-restart', 'store=memory-row  jobs=3')

  // phase 1: durable queue only — no worker, so nothing can drain before flush
  phase('phase 1: enqueue + crash')

  const before = buildQueue<Job>({ store })

  for (const id of [1, 2, 3]) {
    await before.enqueue({ id })
    line('queue', 'add', `job=${id}  size=${before.size()}`)
  }

  await before.flush()
  line('persist', 'flush', `store_rows=${store.rows.length}`)
  line('crash', 'drop', 'queue object discarded')

  phase('phase 2: hydrate + drain')

  let completed = 0

  // Hydrate before the worker attaches so autoStart can drain restored rows.
  const restored = buildQueue<Job>({ store })
  line('persist', 'hydrate', `store_rows=${store.rows.length}`)
  await restored.hydrate()
  line('queue', 'ready', `size=${restored.size()}`)

  const after = withWorker(
    restored,
    async (job) => {
      line('worker', 'start', `job=${job.id}`)
      await sleep(20)
      return 'ok'
    },
    { concurrency: 2 },
  )

  after.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${item.id}`)
  })

  await waitIdle(after)
  await after.flush()

  summary(
    `completed=${completed}  queue_size=${after.size()}  store_rows=${store.rows.length}`,
  )
}

void main()
