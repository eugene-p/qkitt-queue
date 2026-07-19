/**
 * Multi-step job with retries on a flaky middle step.
 * Layers: buildQueue → withWorker; helpers: pipelineWorker + retryWorker
 */
import {
  buildQueue,
  pipelineWorker,
  retryWorker,
  withWorker,
} from '@qkitt/queue'
import { line, phase, sleep, summary, title, waitIdle } from '../_log'

type Job = {
  id: string
  url: string
}

const RETRIES = 3
// First two attempts of the "fetch" step fail, then succeed.
const FAIL_TIMES = 2

async function main() {
  const attemptsByJob = new Map<string, number>()

  title(
    '@qkitt/queue — retry-pipeline',
    `retries=${RETRIES}  fail_first=${FAIL_TIMES}  jobs=2`,
  )

  const run = retryWorker(
    pipelineWorker([
      {
        name: 'validate',
        fn: async (job: Job) => {
          line('step', 'ok', `job=${job.id}  name=validate`)
          return job
        },
      },
      {
        name: 'fetch',
        fn: async (job: Job) => {
          const n = (attemptsByJob.get(job.id) ?? 0) + 1
          attemptsByJob.set(job.id, n)
          if (n <= FAIL_TIMES) {
            line(
              'step',
              'fail',
              `job=${job.id}  name=fetch  attempt=${n}  err=ECONNRESET`,
            )
            throw new Error('ECONNRESET')
          }
          line('step', 'ok', `job=${job.id}  name=fetch  attempt=${n}`)
          await sleep(15)
          return { ...job, body: `body:${job.id}` }
        },
      },
      {
        name: 'save',
        fn: async (payload: Job & { body: string }) => {
          line(
            'step',
            'ok',
            `job=${payload.id}  name=save  body=${payload.body}`,
          )
          return payload
        },
      },
    ]),
    { retries: RETRIES, delay: 20 },
  )

  let completed = 0
  let failed = 0

  const queue = withWorker(buildQueue<Job>(), run, { concurrency: 1 })

  queue.on('worker:completed', ({ item }) => {
    completed += 1
    line('worker', 'done', `job=${item.id}`)
  })

  queue.on('worker:failed', ({ item, error }) => {
    failed += 1
    const msg = error instanceof Error ? error.message : String(error)
    line('worker', 'fail', `job=${item.id}  err=${msg}`)
  })

  phase('run')
  queue.enqueue({ id: 'a', url: 'https://example.com/a' })
  queue.enqueue({ id: 'b', url: 'https://example.com/b' })
  line('queue', 'add', 'jobs=a,b')

  await waitIdle(queue)
  summary(
    `completed=${completed}  failed=${failed}  fetch_attempts_a=${attemptsByJob.get('a') ?? 0}  fetch_attempts_b=${attemptsByJob.get('b') ?? 0}`,
  )
}

void main()
