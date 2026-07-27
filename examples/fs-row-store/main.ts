/**
 * File-backed row store: persist, drop the queue, hydrate and finish work.
 * Layers: buildQueue({ store }) → withWorker
 */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildQueue, withWorker } from '@qkitt/queue'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'
import { createFsRowStore } from './create-fs-row-store'

type Job = {
  id: number
}

async function main() {
  const dataDir = join(dirname(fileURLToPath(import.meta.url)), '.data')
  const filePath = join(dataDir, 'queue.json')
  const store = createFsRowStore<Job>(filePath)

  title('@qkitt/queue — fs-row-store', `path=${filePath}`)

  // Clean slate so re-runs are deterministic
  await rm(dataDir, { recursive: true, force: true })

  phase('phase 1: enqueue + crash (file survives)')

  const before = buildQueue<Job>({ store })

  for (const id of [1, 2, 3]) {
    await before.enqueue({ id })
    line('queue', 'add', `job=${id}  size=${before.size()}`)
  }

  await before.flush()
  line('persist', 'flush', 'wrote rows to disk')
  line('crash', 'drop', 'queue object discarded — only the file remains')

  phase('phase 2: hydrate from file + drain')

  let completed = 0

  // Hydrate before the worker attaches so autoStart can drain restored rows.
  const restored = buildQueue<Job>({ store })
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
    `completed=${completed}  queue_size=${after.size()}  file=${filePath}`,
  )

  await rm(dataDir, { recursive: true, force: true })
}

void main()
