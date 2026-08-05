# Composition

This guide turns a plain FIFO into a background-work system one decision at a time. Read it after the package quick start when you need to answer: “what is the next layer for this job?” Stack order: **bare / durable queue → worker → loop / dlq (optional)**.

Begin with `buildQueue` + `withWorker` for work that can stay in one process. Add a store only when unfinished work must survive restart, a helper for behavior inside one worker call, and loop/DLQ only when you have a deliberate policy for a job that keeps failing. For cross-machine delivery, use a distributed system instead.

Persistence is not a decorator: pass `store` into `buildQueue` when you need durability.

[README](../README.md) · [Persistence](./persistence.md) · [Topics & routing](./routing.md) · [Failure routing](./failure-routing.md) · [Lifecycle](./lifecycle.md) · [API](./api.md)

## 1. Bare queue

Use a bare queue when another part of the same process decides when to drain work, or when you want the FIFO primitive without a background worker. For most background jobs, skip straight to [Add a worker](#2-add-a-worker).

```ts
import { buildQueue, QueueFullError } from '@qkitt/queue'

const queue = buildQueue<{ id: string }>()

await queue.enqueue({ id: '1' })
queue.peek()           // { id: '1' }
queue.size()           // 1
await queue.dequeue()  // { id: '1' }
await queue.clear()

const bounded = buildQueue<number>({ maxSize: 100 })
try {
  await bounded.enqueue(1)
} catch (e) {
  if (e instanceof QueueFullError) {
    // drop, wait, or reject
  }
}
```

Mutating methods return `Promise` (bare paths resolve immediately after the in-memory update). Prefer `tryDequeue` / `tryPeek` when `T` may be nullish.

## 2. Add a worker

`withWorker` drains the queue with claim/ack leases and your async function. Defaults: auto-start, concurrency 1.

This is the normal application shape: callers enqueue quickly, while the worker handles slow I/O in the background. Set `concurrency` to the number of jobs your downstream service can safely handle at once—not simply the highest number your CPU can run.

```ts
import { buildQueue, withWorker } from '@qkitt/queue'

type Job = { id: string; url: string }

const queue = withWorker(
  buildQueue<Job>(),
  async (job) => fetch(job.url),
  { concurrency: 4 },
)

queue.on('worker:completed', ({ item, result }) => {
  console.log(item.id, result.status)
})

queue.on('worker:failed', ({ item, error }) => {
  console.error(item.id, error)
})

await queue.enqueue({ id: '1', url: 'https://example.com' })

queue.stop()  // no new items; in-flight finish (does not wait)
// await queue.gracefulStop({ flush: true })  // stop + wait in-flight + optional flush
queue.start()
```

**Failed items are not re-queued by default.** Use [`retryWorker`](#4-worker-helpers) for in-call retries, [dead letter / loop](./failure-routing.md) for failure routing, or handle `worker:failed` yourself.

Drain and shutdown: [Lifecycle](./lifecycle.md).

## 3. Add persistence

Pass a `RowStore` into the constructor — no wrapper layer:

Choose this only when losing jobs on restart is unacceptable. A store adds I/O and operational responsibility, but lets the next process load unfinished rows and continue. In-memory queues are simpler and usually faster when work is safe to discard.

```ts
import {
  buildQueue,
  withWorker,
  createLocalStorageRowStore,
} from '@qkitt/queue'

type Job = { id: string; url: string }

const store = createLocalStorageRowStore<Job>('my-app:jobs')
// Fresh process: hydrate before attaching the worker (hydrate rejects while workers run).
const base = buildQueue<Job>({ store })
await base.hydrate()

const queue = withWorker(
  base,
  async (job) => {
    // handle job
  },
  { concurrency: 2 },
)

await queue.enqueue({ id: '1', url: 'https://example.com' })
await queue.flush()   // wait for pending store writes before exit
```

Built-in durable stores: Web Storage (`localStorage` / `sessionStorage`). For Node or other backends, implement `RowStore` ([Custom stores](./persistence.md#custom-stores)).

### Persist lifecycle

1. Build: `buildQueue({ store })`.
2. `await hydrate()` **before** `withWorker` when restoring after restart (or use `autoStart: false`, hydrate, then `start()`). Hydrate throws `HydrateWhileActiveError` while workers are active or rows are leased.
3. Attach worker / loop / dlq; mutate as usual — durable ops await the write chain.
4. `await flush()` before process exit.

Full detail: [Persistence](./persistence.md).

## 4. Worker helpers

`pipelineWorker` and `retryWorker` return plain worker functions — compose them first, then pass the result to `withWorker`. They do not touch the queue directly.

Use these for behavior of one job attempt. They are not durable scheduling: retries happen inside the active worker call; for a job that should return later or be inspected separately after failure, use [failure routing](./failure-routing.md).

### Retry

```ts
import { retryWorker } from '@qkitt/queue'

const run = retryWorker(
  async (job: Job) => {
    const res = await fetch(job.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },
  {
    retries: 3, // total attempts = retries + 1
    // delay is ms or (attempt) => ms — 1-based attempt only (not the error)
    delay: (attempt) => 100 * 2 ** (attempt - 1),
    shouldRetry: (error) => !(error instanceof TypeError),
  },
)

// shorthand: only a retry count
const run2 = retryWorker(async (n: number) => callApi(n), 2)
```

`retries` = retries **after** the first failure. Total attempts = `retries + 1`.

`delay` uses the shared `DelayPolicy` shape (`number | (attempt: number) => number`). Same shape for [`withLoop` delay](./failure-routing.md#loop-withloop) (hop count instead of attempt). On a durable queue, loop delay is persisted as the row’s `availableAt` timestamp.

| `retries` | Total attempts |
| --- | ---: |
| `0` | 1 |
| `1` | 2 |
| `3` | 4 |

After all attempts fail: `RetryExhaustedError` with `attempts` and `cause`.

### Pipeline

Chain steps — bare functions and/or `{ name, fn, metadata? }`. Each step gets `(input, ctx)` where `ctx` is `{ name, index, metadata }`.

```ts
import { pipelineWorker } from '@qkitt/queue'

const run = pipelineWorker([
  async (id: string) => fetchUser(id),
  async (user) => enrich(user),
  {
    name: 'save',
    metadata: { table: 'users' },
    fn: async (user, ctx) => save(user, ctx.metadata),
  },
])
```

Empty step lists throw at construction. Step failures throw `PipelineStepError`.

Return `pipelineDone(value)` from a step to **finish successfully early** (later steps are not run; the worker resolves with `value`). This is not an error — safe under `retryWorker` (no retry). Use for guards/filters (already done, nothing to send) without threading a skip flag through every step.

```ts
import { pipelineWorker, pipelineDone } from '@qkitt/queue'

type EmailJob = { to: string; body: string; dedupeKey: string }

const run = pipelineWorker([
  async (job: EmailJob) => {
    if (await alreadySent(job.dedupeKey)) {
      return pipelineDone({ status: 'duplicate', key: job.dedupeKey })
    }
    return job
  },
  async (job) => sendEmail(job),
  async (result) => recordSent(result),
])
```

> Heterogeneous step lists often infer as `unknown`. Use `pipelineWorker<In, Out>([…])` when you need a precise result type on `worker:completed`.

```ts
const run = pipelineWorker<string, number>([
  async (id) => fetchUser(id),   // string → User
  async (user) => user.age,      // User → number
])
```

### Compose helpers

```ts
const run = retryWorker(
  pipelineWorker([
    { name: 'validate', fn: async (job: Job) => validate(job) },
    { name: 'deliver', fn: async (job) => deliver(job) },
  ]),
  { retries: 2, delay: 250 },
)
```

## 5. Put it on a queue

```ts
import {
  buildQueue,
  withWorker,
  pipelineWorker,
  retryWorker,
  createLocalStorageRowStore,
} from '@qkitt/queue'

type EmailJob = { to: string; body: string }

const store = createLocalStorageRowStore<EmailJob>('my-app:email')
const run = retryWorker(
  pipelineWorker([
    {
      name: 'validate',
      fn: async (job: EmailJob) => {
        if (!job.to.includes('@')) throw new Error('bad recipient')
        return job
      },
    },
    {
      name: 'send',
      fn: async (job) => {
        await sendEmail(job)
        return job.to
      },
    },
  ]),
  { retries: 3, delay: (n) => 50 * n },
)

const base = buildQueue<EmailJob>({ store })
await base.hydrate()

const queue = withWorker(
  base,
  run,
  { concurrency: 2 },
)

await queue.enqueue({ to: 'you@example.com', body: 'hi' })

queue.on('worker:completed', ({ result }) => console.log('sent to', result))
queue.on('worker:failed', ({ error }) => console.error(error))
```

## 6. Optional: drive from config

Prefer a declarative setup when several named queues and bindings make startup wiring difficult to scan. [`@qkitt/queue-config`](../../queue-config) builds the same stacks from a JS/JSON object; it is optional, not a requirement for using the core:

```ts
import { defineConfig, buildFromConfig } from '@qkitt/queue-config'

const system = await buildFromConfig(
  defineConfig({
    queues: {
      jobs: { worker: { run: handleJob, concurrency: 2 } },
    },
  }),
)
```

See that package’s README for schema and API.

## Events

Every layer is typed. `on` returns an unsubscribe function. The emitter also works standalone via `buildEventEmitter` (see [API](./api.md#events-standalone)).

| Layer | Events |
| --- | --- |
| Queue | `queue:enqueued`, `queue:dequeued`, `queue:emptied`, `queue:cleared` |
| Worker | `worker:started`, `worker:completed`, `worker:failed`, `worker:requeued`, `worker:dropped`, `worker:idle`, `worker:pump-error` |
| Dead letter | `dlq:enqueued`, `dlq:error` |
| Loop | `loop:enqueued`, `loop:meta-override`, `loop:error` |
| Router | `router:bound`, `router:unbound`, `router:published`, `router:unmatched`, `router:error` |
| Persist | `persist:loaded`, `persist:lease-expired`, `persist:id-space-low`, `persist:error` |

Events cost nothing when nobody is subscribed.

## Notes & pitfalls

**Durable mode is constructor options, not a wrapper.**

```ts
// right
withWorker(buildQueue<T>({ store }), run)

// removed in 0.8 — no withPersist decorator
// withPersist(buildQueue<T>(), store)
```

**Await `hydrate()` after restart** when using a store, so restored rows become claimable. Call `flush()` before process exit so pending durable writes are not cut off mid-flight.

```ts
const queue = buildQueue<T>({ store })
await queue.hydrate()
await queue.enqueue(item)
await queue.flush()
```

**Nullish payloads need `tryDequeue()` / `tryPeek()`.** Plain `dequeue()` and `peek()` return `undefined` for both "empty" and a queued `undefined` — fine for most types, but use the `try*` variants when `T` includes `null` or `undefined`:

```ts
const q = buildQueue<string | undefined>()
await q.enqueue(undefined)

await q.dequeue()     // undefined — the item, or an empty queue?
await q.tryDequeue()  // { value: undefined } — item present; undefined means empty
```

**Failed items are not re-queued.** Prefer [failure routing](./failure-routing.md) or handle `worker:failed` yourself:

```ts
queue.on('worker:failed', ({ item, error }) => {
  // log, alert, or re-enqueue manually
})
```

**Web Storage is not multi-tab safe and does not provide database transactions.**
Its generation manifest keeps reloads coherent across interrupted row cleanup;
prefer one owning tab, or a real DB, when durability is shared.
