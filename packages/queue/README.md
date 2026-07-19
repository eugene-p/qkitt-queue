# @qkitt/queue

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue.svg)](https://www.npmjs.com/package/@qkitt/queue)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](https://github.com/eugene-p/qkitt-queue/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Fast, composable in-process queues for TypeScript.

Layers you can stack: bare queue, concurrent worker, optional persistence, topic routing. Worker helpers (`retryWorker`, `pipelineWorker`) return functions you pass to `withWorker`. Zero runtime dependencies. ESM only. Node.js 18+.

Bare queue is FIFO (enqueue at the tail, dequeue from the head).

**[API reference](#api-reference)** · [Composition](#composition) · [Benchmarks](#benchmarks-summary)

## Install

```bash
npm install @qkitt/queue
```

```ts
import {
  buildQueue,
  withWorker,
  withSnapshotPersist,
  withRowPersist,
  pipelineWorker,
  retryWorker,
  buildRouter,
  createMemorySnapshotStore,
  createMemoryRowStore,
} from '@qkitt/queue'
```

Or by area: `@qkitt/queue/queue`, `/worker`, `/router`, `/persist`, `/events`.

Runnable scenarios (worker, retry, persist, router): [`examples/`](../../examples) in the monorepo.

## Composition

Add layers as needed.

### 1. Bare queue

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

### 2. Add a worker

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

queue.stop()  // no new items; in-flight finish
queue.start()
```

Failed items are not re-queued. Use `retryWorker` (below) or handle `worker:failed`.

### 3. Add persistence

Stack order matters: **persist wraps the bare queue; worker is outermost** so `dequeue` goes through the store.

```ts
import {
  buildQueue,
  withWorker,
  withSnapshotPersist,
  createMemorySnapshotStore,
} from '@qkitt/queue'

const store = createMemorySnapshotStore<Job>()
const queue = withWorker(
  withSnapshotPersist(buildQueue<Job>(), store),
  async (job) => handle(job),
  { concurrency: 2 },
)

await queue.hydrate() // load from store before accepting work
queue.enqueue({ id: '1', url: '…' })
await queue.flush()   // wait for pending saves
```

Row-style persist (insert/remove per item) uses the same stack rule — wrap a `RowRecord` queue, then the worker:

```ts
import {
  buildQueue,
  withRowPersist,
  withWorker,
  createMemoryRowStore,
  type RowRecord,
} from '@qkitt/queue'

const store = createMemoryRowStore<Job>()
const queue = withWorker(
  withRowPersist(buildQueue<RowRecord<Job>>(), store),
  async (job) => handle(job),
)

await queue.hydrate()
```

### 4. Worker helpers

`pipelineWorker` and `retryWorker` build **worker functions**. They do not touch the queue. Compose them, then pass the result to `withWorker`.

**Retry**

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
    delay: (attempt) => 100 * 2 ** (attempt - 1),
    shouldRetry: (error) => !(error instanceof TypeError),
  },
)

// shorthand: only a retry count
const run2 = retryWorker(async (n: number) => callApi(n), 2)
```

After all attempts fail: `RetryExhaustedError` with `attempts` and `cause`.

**Pipeline**

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

Empty step lists throw at construction. Step failures throw `PipelineStepError`. Heterogeneous step lists cannot infer end-to-end types — use `pipelineWorker<In, Out>([...])` when you need a precise result type.

**Compose helpers**

```ts
const run = retryWorker(
  pipelineWorker([
    { name: 'validate', fn: async (job: Job) => validate(job) },
    { name: 'deliver', fn: async (job) => deliver(job) },
  ]),
  { retries: 2, delay: 250 },
)
```

### 5. Put it on a queue

```ts
import {
  buildQueue,
  withWorker,
  withRowPersist,
  pipelineWorker,
  retryWorker,
  createMemoryRowStore,
  type RowRecord,
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
  withRowPersist(buildQueue<RowRecord<EmailJob>>(), store),
  run,
  { concurrency: 2 },
)

await queue.hydrate()
queue.enqueue({ to: 'you@example.com', body: 'hi' })

queue.on('worker:completed', ({ result }) => console.log('sent to', result))
queue.on('worker:failed', ({ error }) => console.error(error))
```

### 6. Optional: drive from config

Same stacks can be declared in a config object via **[`@qkitt/queue-config`](../queue-config)**:

```bash
npm install @qkitt/queue @qkitt/queue-config
```

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

## Topics & routing

Publish on topics; bind queues with MQTT/AMQP-style patterns (`*`, `#`).

| Pattern | Matches |
| --- | --- |
| `orders.created` | Exact topic |
| `orders.*` | One segment (`orders.created`, not `orders.a.b`) |
| `orders.#` | Zero or more trailing segments |
| `#` | Everything |

Wildcards are only valid as a whole segment (`orders*`, `ord#` are rejected).

```ts
import { buildQueue, buildRouter, withWorker, type RouteMessage } from '@qkitt/queue'

type Order = { id: number; total: number }

const router = buildRouter()
const created = buildQueue<RouteMessage<Order>>()
const allOrders = buildQueue<RouteMessage>()

router.bind('orders.created', created)
router.bind('orders.#', allOrders)

withWorker(created, async ({ topic, data }) => {
  console.log(topic, data.id, data.total)
})

router.publish('orders.created', { id: 1, total: 42 })
// both queues get { topic, data }

const unbind = router.bind('jobs.*', buildQueue())
unbind()
```

**Unmatched** publishes can go to a sink queue. The sink is not a match — `publish` still returns `0`.

```ts
const unrouted = buildQueue<RouteMessage>()
const router = buildRouter({ unmatchedTarget: unrouted })

router.publish('no.binding', { id: 1 })
router.unmatchedCount()
router.lastUnmatched()
router.clearUnmatched() // stats only
router.setUnmatchedTarget(unrouted) // or undefined to clear
```

If a matched binding’s `enqueue` throws, `publish` still counts that binding as matched and does not deliver to the unmatched sink (see `router:error`).

## Persistence

Two strategies:

| | Snapshot | Row |
| --- | --- | --- |
| Writes | Full list rewrite | Insert/remove per op |
| Good for | Simple backends, small queues | DB-style stores |
| Failed write | `persist:error`; memory unchanged | Failed insert rolls back that row; failed remove/clear error only (hydrate to resync) |
| Wait | `flush()` or `persist()` | `flush()` |

`enqueue` / `dequeue` / `clear` stay sync; store I/O runs on a serialized write chain. Concurrent mutations during `hydrate` throw `QueueHydratingError`. A second concurrent `hydrate()` rejects.

### Snapshot

```ts
const store = createMemorySnapshotStore<string>()
const queue = withSnapshotPersist(buildQueue<string>(), store)

await queue.hydrate()
queue.enqueue('a')    // auto-saves by default
await queue.persist() // manual save
await queue.flush()
```

### Row

```ts
const store = createMemoryRowStore<string>()
const queue = withRowPersist(buildQueue<RowRecord<string>>(), store)
// optional: { createId: () => crypto.randomUUID() }

await queue.hydrate()
queue.enqueue('job-1')
await queue.flush()
queue.rowIds()
queue.replaceAll(['x', 'y']) // clears store and reinserts with fresh ids
await queue.flush()
```

Row ids from `createId` / `loadAll` must be unique non-empty strings (not whitespace-only).

### Browser storage

```ts
import {
  withSnapshotPersist,
  withRowPersist,
  createLocalStorageSnapshotStore,
  createLocalStorageRowStore,
  type RowRecord,
} from '@qkitt/queue'

const snap = withSnapshotPersist(
  buildQueue<{ id: string }>(),
  createLocalStorageSnapshotStore('my-app:queue'),
)
await snap.hydrate()

const rows = withRowPersist(
  buildQueue<RowRecord<{ id: string }>>(),
  createLocalStorageRowStore('my-app:jobs'),
)
await rows.hydrate()
```

Also: `createSessionStorageSnapshotStore`, `createSessionStorageRowStore`.

Web Storage is not multi-tab safe or transactional. Prefer one owning tab, or a real DB, when durability is shared.

### Custom stores

```ts
type SnapshotStore<T> = {
  load: () => readonly T[] | Promise<readonly T[]>
  save: (items: readonly T[]) => void | Promise<void>
}

type RowStore<T> = {
  loadAll: () => readonly { id: string; item: T }[] | Promise<...>
  insert: (record: { id: string; item: T }) => void | Promise<void>
  remove: (id: string) => void | Promise<void>
  clear: () => void | Promise<void>
}
```

## Events

Every layer is typed. `on` / `once` both return an unsubscribe function. The emitter also works standalone via `buildEventEmitter` (see [API](#api-reference)).

| Layer | Events |
| --- | --- |
| Queue | `queue:enqueued`, `queue:dequeued`, `queue:emptied`, `queue:cleared` |
| Worker | `worker:started`, `worker:completed`, `worker:failed`, `worker:idle`, `worker:pump-error` |
| Router | `router:bound`, `router:unbound`, `router:published`, `router:unmatched`, `router:error` |
| Snapshot | `persist:loaded`, `persist:saved`, `persist:error` |
| Row | `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error` |

Events cost nothing when nobody is subscribed.

## Benchmarks (summary)

In-process peers only (not Redis job systems). Full tables, environment, and method: monorepo [root README § Benchmarks](../../README.md#benchmarks). Re-run: [`packages/bench`](../bench) (`npm run bench` from repo root).

Worker drain measures concurrent jobs and retained memory under a backlog. Bare `buildQueue` is comparable to dedicated queue structures and much faster than naive `Array#shift`.

**Worker drain** — 10 000 no-op jobs (ops/s · pending-job heap)

| Library | c=1 | c=4 | heap Δ (c=1) |
| --- | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **457** | **451** | **239 KiB** |
| fastq | 90 | 86 | 6.81 MiB |
| async.queue | 133 | 180 | 4.96 MiB |
| p-queue | 57 | 57 | 11.04 MiB |

**Bare queue** — 50 000 enqueue + dequeue (ops/s median · retained heap)

| Library | ops/s | heap Δ |
| --- | ---: | ---: |
| **@qkitt/queue** `buildQueue` | 1,016 | 1.19 MiB |
| denque | 1,307 | 1.43 MiB |
| yocto-queue | 1,657 | 1.92 MiB |
| native `Array` push/shift | 6 | 1.18 MiB |

Relative numbers (Node 22, Windows laptop, 2026-07-19). Re-run before drawing absolute conclusions.

---

## API reference

### `buildQueue`

```ts
buildQueue<T>(options?: BuildQueueOptions): Queue<T>
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxSize` | `number` | — | Safe integer ≥ 1. `enqueue` / `replaceAll` throw `QueueFullError` when full. |

**Methods**

| Method | Returns | Description |
| --- | --- | --- |
| `enqueue(item)` | `void` | Add to tail |
| `dequeue()` | `T \| undefined` | Remove head (`undefined` if empty; ambiguous when `T` may be `undefined`) |
| `peek()` | `T \| undefined` | Head without removing (same ambiguity as `dequeue`) |
| `tryDequeue()` | `QueueSlot<T> \| undefined` | Remove head as `{ value }` or `undefined` if empty (nullish payloads OK) |
| `tryPeek()` | `QueueSlot<T> \| undefined` | Peek as `{ value }` or `undefined` if empty |
| `size()` | `number` | Item count |
| `isEmpty()` | `boolean` | |
| `clear()` | `void` | Remove all; emits `queue:cleared` |
| `replaceAll(items)` | `void` | Replace contents without queue events (used by persist hydrate) |
| `toArray()` | `T[]` | Snapshot head → tail |
| `on` / `once` | `() => void` | Subscribe; return unsubscribe |
| `emit` | | Internal / advanced |

`null` / `undefined` are valid payloads. Prefer `tryDequeue` / `tryPeek` when `T` may be nullish so emptiness is structural (`undefined` return) rather than inferred from the value.

**Errors:** `QueueFullError` (`maxSize`).

**Events**

| Event | Payload |
| --- | --- |
| `queue:enqueued` | `{ item, size }` |
| `queue:dequeued` | `{ item, size }` |
| `queue:emptied` | `undefined` |
| `queue:cleared` | `{ removed }` |

---

### `withWorker`

```ts
withWorker<T, R>(
  queue: Queue<T>,
  worker: WorkerFn<T, R>,
  options?: WithWorkerOptions,
): QueueWithWorker<T, R>
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `concurrency` | `number` | `1` | Safe integer ≥ 1 |
| `autoStart` | `boolean` | `true` | If `false`, no pump until `start()` |

**Controls** (added to the queue)

| Method | Description |
| --- | --- |
| `start()` | Begin taking items |
| `stop()` | Stop taking new items; in-flight finish |
| `isRunning()` | Whether the pump may take work |
| `isProcessing()` | Any in-flight items |
| `activeCount()` | In-flight count |

Inner extras (`flush`, `hydrate`, …) are preserved when the queue is already decorated.

**Events**

| Event | Payload | When |
| --- | --- | --- |
| `worker:started` | `{ item }` | Before run |
| `worker:completed` | `{ item, result }` | Resolved |
| `worker:failed` | `{ item, error }` | Rejected |
| `worker:idle` | `undefined` | Empty and nothing in flight |
| `worker:pump-error` | `{ error }` | Unexpected `tryDequeue` failure (worker stops) |

The pump uses `tryDequeue` so nullish payloads are processed. While a stacked persist layer is hydrating, `tryDequeue` throws `QueueHydratingError`; the pump waits for the post-hydrate kick. Other unexpected dequeue failures emit `worker:pump-error` and stop the worker — call `start()` after fixing the cause.

---

### `withSnapshotPersist`

```ts
withSnapshotPersist<T>(
  queue: Queue<T>,
  store: SnapshotStore<T>,
  options?: SnapshotPersistOptions,
): QueueWithSnapshotPersist<T>
```

| Option | Type | Default |
| --- | --- | --- |
| `autoSave` | `boolean` | `true` |

**Added methods:** `hydrate()`, `persist()`, `flush()`.

**Events:** `persist:loaded`, `persist:saved`, `persist:error` (`operation`: `'load' | 'save'`).

**Errors:** `QueueHydratingError` on concurrent mutation during hydrate.

---

### `withRowPersist`

```ts
withRowPersist<T>(
  queue: Queue<RowRecord<T>>,
  store: RowStore<T>,
  options?: RowPersistOptions,
): QueueWithRowPersist<T>
```

| Option | Type | Default |
| --- | --- | --- |
| `createId` | `() => string` | Library default (nanoid-style) |

Public API still enqueues plain `T`; the inner queue holds `{ id, item }` records.

**Added methods:** `hydrate()`, `flush()`, `rowIds()`.

**Events:** `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error`.

Throws if a worker is already attached (wrong stack order).

---

### `retryWorker`

```ts
retryWorker<T, R>(
  worker: WorkerFn<T, R>,
  options: RetryOptions | number,
): WorkerFn<T, R>
```

| Option | Type | Notes |
| --- | --- | --- |
| `retries` | `number` | Safe integer ≥ 0; total attempts = `retries + 1` |
| `delay` | `number \| (attempt, error) => number` | Finite ms ≥ 0; attempt is 1-based |
| `shouldRetry` | `(error, attempt) => boolean` | Default: always retry |

Passing a number is shorthand for `{ retries: n }`.

**Errors:** `RetryExhaustedError` (`attempts`, `cause`).

---

### `pipelineWorker`

```ts
pipelineWorker<T, R = unknown>(steps: readonly PipelineStep[]): WorkerFn<T, R>
```

Each step is `StepFn` or `{ name, fn, metadata? }`. Bare functions get names like `step[0]`.

**Errors:** `PipelineStepError` (`stepName`, `stepIndex`, `metadata`, `cause`). Empty `steps` throws at construction.

---

### `buildRouter`

```ts
buildRouter(options?: BuildRouterOptions): Router
```

| Option | Type | Notes |
| --- | --- | --- |
| `unmatchedTarget` | `{ enqueue(msg) }` | Sink for unmatched publishes |

**Methods:** `bind(pattern, target)` → unbind fn, `unbind(pattern, target?)`, `publish(topic, data)` → match count, `unmatchedCount()`, `lastUnmatched()`, `clearUnmatched()`, `setUnmatchedTarget(target?)`, `on` / `once` / `emit`.

**Helpers:** `matchTopic`, `isValidPattern`, `isValidTopic`, constants `SINGLE_WILDCARD`, `MULTI_WILDCARD`, `TOPIC_SEPARATOR`.

**Events**

| Event | Payload |
| --- | --- |
| `router:bound` | `{ pattern }` |
| `router:unbound` | `{ pattern, removed }` |
| `router:published` | `{ topic, data, matched }` |
| `router:unmatched` | `{ topic, data, delivered }` |
| `router:error` | `{ operation, error, topic?, pattern? }` |

---

### Stores

| Factory | Strategy |
| --- | --- |
| `createMemorySnapshotStore<T>()` | Snapshot |
| `createMemoryRowStore<T>()` | Row |
| `createLocalStorageSnapshotStore(key, options?)` | Snapshot |
| `createLocalStorageRowStore(key, options?)` | Row |
| `createSessionStorageSnapshotStore(key, options?)` | Snapshot |
| `createSessionStorageRowStore(key, options?)` | Row |
| `createWebSnapshotStore` / `createWebRowStore` | Custom `WebStorageLike` |

**Errors:** `StorageCodecError` on bad JSON in web stores.

---

### Events (standalone)

```ts
import { buildEventEmitter } from '@qkitt/queue'
// or '@qkitt/queue/events'

const bus = buildEventEmitter<{ 'app:ready': undefined }>()
bus.on('app:ready', () => {})
```

Also: `createTypedEmit`, types `EventEmitter`, `EventMap`, `EventCallback`, `MergeEventMaps`.

---

### Types (selected)

| Type | Role |
| --- | --- |
| `Queue<T>` | Bare queue surface |
| `QueueWithWorker<T, R>` | Queue + worker controls |
| `QueueWithSnapshotPersist<T>` / `QueueWithRowPersist<T>` | Persist-decorated queues |
| `WorkerFn<T, R>` | `(item) => R \| Promise<R>` |
| `WorkerControls` | `start` / `stop` / … |
| `WithWorkerOptions`, `BuildQueueOptions` | Options objects |
| `RowRecord<T>`, `RowStore<T>`, `SnapshotStore<T>` | Persist contracts |
| `RouteMessage<T>`, `Router`, `Binding` | Router |
| `RetryOptions`, `PipelineStep`, `PipelineStepContext` | Worker helpers |

Internals (`*.util`, codecs, write chain) are not part of the public contract.

## Package layout

| Subpath | Exports |
| --- | --- |
| `@qkitt/queue` | Everything |
| `@qkitt/queue/queue` | `buildQueue`, `withWorker`, persist wrappers, … |
| `@qkitt/queue/worker` | `pipelineWorker`, `retryWorker`, related errors/types |
| `@qkitt/queue/router` | `buildRouter`, match helpers |
| `@qkitt/queue/persist` | Memory + Web Storage stores |
| `@qkitt/queue/events` | `buildEventEmitter`, … |

Companion: [`@qkitt/queue-config`](../queue-config) — declarative `defineConfig` / `buildFromConfig`.

`@qkitt/queue/worker` is worker **helpers**. The queue worker decorator (`withWorker`) lives under `@qkitt/queue/queue`. Same split for persist: adapters under `/persist`, wrappers under `/queue`.

## License

[ISC](./LICENSE)
