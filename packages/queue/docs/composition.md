# Composition

Add layers as needed. Stack order: **bare → persist (optional) → worker → loop / dlq (optional)**.

[README](../README.md) · [Persistence](./persistence.md) · [Topics & routing](./routing.md) · [Failure routing](./failure-routing.md) · [Lifecycle](./lifecycle.md) · [API](./api.md)

## 1. Bare queue

```ts
import { buildQueue, QueueFullError } from '@qkitt/queue'

const queue = buildQueue<{ id: string }>()

queue.enqueue({ id: '1' })
queue.peek()    // { id: '1' }
queue.size()    // 1
queue.dequeue() // { id: '1' }
queue.clear()

const bounded = buildQueue<number>({ maxSize: 100 })
try {
  bounded.enqueue(1)
} catch (e) {
  if (e instanceof QueueFullError) {
    // drop, wait, or reject
  }
}
```

## 2. Add a worker

`withWorker` drains the queue with your async function. Defaults: auto-start, concurrency 1.

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

queue.enqueue({ id: '1', url: 'https://example.com' })

queue.stop()  // no new items; in-flight finish (does not wait)
// await queue.gracefulStop({ flush: true })  // stop + wait in-flight + optional flush
queue.start()
```

**Failed items are not re-queued.** Use [`retryWorker`](#4-worker-helpers) for in-call retries, [dead letter / loop](./failure-routing.md) for failure routing, or handle `worker:failed` yourself.

Drain and shutdown: [Lifecycle](./lifecycle.md).

## 3. Add persistence

Stack order matters: **persist wraps the bare queue; worker is outermost** so `dequeue` goes through the store.

```ts
import {
  buildQueue,
  withWorker,
  withPersist,
  createMemorySnapshotStore,
} from '@qkitt/queue'

type Job = { id: string; url: string }

const store = createMemorySnapshotStore<Job>()
// Stack: bare → persist → worker (persist inside, worker outside)
const queue = withWorker(
  withPersist(buildQueue<Job>(), store),
  async (job) => {
    // handle job
  },
  { concurrency: 2 },
)

await queue.hydrate() // load from store before accepting work
queue.enqueue({ id: '1', url: 'https://example.com' })
await queue.flush()   // wait for pending saves before exit
```

Built-ins: memory and Web Storage. For something else, implement `SnapshotStore` or `RowStore` and pass that instance instead ([Custom stores](./persistence.md#custom-stores)).

### Persist lifecycle

1. Build stack: bare → persist → worker (**persist inside, worker outside**).
2. `await queue.hydrate()` before enqueue / before expecting workers to process restored items.
3. Mutate as usual — `enqueue` / `dequeue` stay sync.
4. `await queue.flush()` before process exit. Snapshot auto-save may debounce; `flush` promotes pending writes.

Row-style persist (insert/remove per item) uses the same stack rule:

```ts
import {
  buildQueue,
  withPersist,
  withWorker,
  createMemoryRowStore,
} from '@qkitt/queue'

type Job = { id: string }

const store = createMemoryRowStore<Job>()
const queue = withWorker(
  withPersist(buildQueue<Job>(), store),
  async (job) => {
    // handle job
  },
)

await queue.hydrate()
```

The strategy is inferred from the store's method shape — `load`/`save` selects snapshot; `loadAll`/`insert`/`remove`/`clear` selects row. The public surface is `T` — you enqueue plain jobs; row ids are managed internally.

Full detail: [Persistence](./persistence.md).

## 4. Worker helpers

`pipelineWorker` and `retryWorker` return plain worker functions — compose them first, then pass the result to `withWorker`. They do not touch the queue directly.

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

`delay` uses the shared `DelayPolicy` shape (`number | (attempt: number) => number`). Same shape for [`withLoop` delay](./failure-routing.md#loop-withloop) (hop count instead of attempt). Loop delay is process-local only: restart or crash loses items still waiting to re-enqueue (see that guide’s disclaimer).

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
  withPersist,
  pipelineWorker,
  retryWorker,
  createMemoryRowStore,
} from '@qkitt/queue'

type EmailJob = { to: string; body: string }

const store = createMemoryRowStore<EmailJob>()
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

const queue = withWorker(
  withPersist(buildQueue<EmailJob>(), store),
  run,
  { concurrency: 2 },
)

await queue.hydrate()
queue.enqueue({ to: 'you@example.com', body: 'hi' })

queue.on('worker:completed', ({ result }) => console.log('sent to', result))
queue.on('worker:failed', ({ error }) => console.error(error))
```

## 6. Optional: drive from config

Prefer a declarative setup? [`@qkitt/queue-config`](../../queue-config) builds the same queue → persist → worker stacks from a JS/JSON object:

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
| Worker | `worker:started`, `worker:completed`, `worker:failed`, `worker:idle`, `worker:pump-error` |
| Dead letter | `dlq:enqueued`, `dlq:error` |
| Loop | `loop:enqueued`, `loop:meta-override`, `loop:error` |
| Router | `router:bound`, `router:unbound`, `router:published`, `router:unmatched`, `router:error` |
| Snapshot | `persist:loaded`, `persist:saved`, `persist:error` |
| Row | `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error` |

Events cost nothing when nobody is subscribed.

## Notes & pitfalls

**Stack order matters.** Persist wraps the bare queue; worker is outermost. **Persist inside, worker outside.**

```ts
// wrong — withPersist throws (worker already attached)
withPersist(withWorker(buildQueue<T>(), run), store)

// right
withWorker(withPersist(buildQueue<T>(), store), run)
```

**Await `hydrate()` before enqueue** when using persist, or mutations throw `QueueHydratingError`. Call `flush()` before process exit so debounced writes are not lost.

```ts
const queue = withPersist(buildQueue<T>(), store)
queue.enqueue(item)      // throws QueueHydratingError
await queue.hydrate()
queue.enqueue(item)      // fine
```

**Nullish payloads need `tryDequeue()` / `tryPeek()`.** Plain `dequeue()` and `peek()` return `undefined` for both "empty" and a queued `undefined` — fine for most types, but use the `try*` variants when `T` includes `null` or `undefined`:

```ts
const q = buildQueue<string | undefined>()
q.enqueue(undefined)

q.dequeue()       // undefined — the item, or an empty queue?
q.tryDequeue()    // { value: undefined } — item present; undefined means empty
```

**Failed items are not re-queued.** Prefer [failure routing](./failure-routing.md) or handle `worker:failed` yourself:

```ts
queue.on('worker:failed', ({ item, error }) => {
  // log, alert, or re-enqueue manually
})
```

**Web Storage is not multi-tab safe or transactional.** Prefer one owning tab, or a real DB, when durability is shared.
