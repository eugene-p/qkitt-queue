/**
 * Survive a "crash": snapshot persist, drop the queue, hydrate and finish work.
 * Layers: buildQueue → withSnapshotPersist → withWorker (worker outermost)
 */
import {
  buildQueue,
  createMemorySnapshotStore,
  withSnapshotPersist,
  withWorker,
} from '@qkitt/queue'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'

type Job = {
  id: number
}

async function main() {
  const store = createMemorySnapshotStore<Job>()

  title('@qkitt/queue — persist-restart', 'store=memory-snapshot  jobs=3')

  // phase 1: persist only — no worker, so nothing can drain before flush
  phase('phase 1: enqueue + crash')

  const before = withSnapshotPersist(buildQueue<Job>(), store)

  for (const id of [1, 2, 3]) {
    before.enqueue({ id })
    line('queue', 'add', `job=${id}  size=${before.size()}`)
  }

  await before.flush()
  line('persist', 'flush', `store_size=${store.data.length}`)
  line('crash', 'drop', 'queue object discarded')

  phase('phase 2: hydrate + drain')

  let completed = 0

  const after = withWorker(
    withSnapshotPersist(buildQueue<Job>(), store),
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

  line('persist', 'hydrate', `store_size=${store.data.length}`)
  await after.hydrate()
  line('queue', 'ready', `size=${after.size()}`)

  await waitIdle(after)
  await after.flush()

  summary(
    `completed=${completed}  queue_size=${after.size()}  store_size=${store.data.length}`,
  )
}

void main()
