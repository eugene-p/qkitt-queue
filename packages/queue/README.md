<img src="https://raw.githubusercontent.com/eugene-p/qkitt-queue/main/assets/logo.svg" alt="qkitt-queue" width="150" height="150">

# @qkitt/queue

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue.svg)](https://www.npmjs.com/package/@qkitt/queue)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Fast, composable in-process queues for TypeScript — zero runtime dependencies.

Layers you can stack: bare queue (FIFO), concurrent worker, optional persistence, topic routing. Worker helpers (`retryWorker`, `pipelineWorker`) return functions you pass to `withWorker`. ESM only. Runs in Node.js 20+ and modern browsers. Requires TypeScript 4.7+ with `moduleResolution` set to `bundler`, `node16`, or `nodenext`.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

**[API reference](#api-reference)** · [Recipes](#recipes) · [Composition](#composition) · [Topics & routing](#topics--routing) · [Persistence](#persistence) · [Waiting for drain](#waiting-for-drain) · [Package layout](#package-layout) · [Benchmarks](#benchmark-summary)

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

Subpath exports are available by area: `@qkitt/queue/queue`, `/worker`, `/router`, `/persist`, `/events`. See [Package layout](#package-layout) for what each subpath exports.

Runnable scenarios (worker, retry, persist, router): [`examples/`](../../examples) in the monorepo.

## Recipes

| Task | Jump to |
| --- | --- |
| Concurrent jobs | [`buildQueue` + `withWorker`](#2-add-a-worker), [Waiting for drain](#waiting-for-drain) |
| Retries / multi-step | [`retryWorker` + `pipelineWorker`](#4-worker-helpers) |
| Survive restart (snapshot) | [§3 Add persistence](#3-add-persistence), [Persist lifecycle](#persist-lifecycle) |
| DB-style row persist | [Row](#row) |
| Topic fan-out | [Topics & routing](#topics--routing) |
| Declarative multi-queue | [`@qkitt/queue-config`](../queue-config) |

When stacks grow (many queues, router, stores), prefer [`@qkitt/queue-config`](../queue-config) over deep nesting.

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

**Failed items are not re-queued.** Use [`retryWorker`](#4-worker-helpers) for in-call retries, or handle `worker:failed` and re-enqueue yourself if you need a dead-letter path.

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
// Stack: bare → persist → worker (persist inside, worker outside)
const queue = withWorker(
  withSnapshotPersist(buildQueue<Job>(), store),
  async (job) => handle(job),
  { concurrency: 2 },
)

await queue.hydrate() // load from store before accepting work
queue.enqueue({ id: '1', url: '…' })
await queue.flush()   // wait for pending saves before exit
```

#### Persist lifecycle

1. Build stack: bare → persist → worker (**persist inside, worker outside**).
2. `await queue.hydrate()` before enqueue / before expecting workers to process restored items.
3. Mutate as usual — `enqueue` / `dequeue` stay sync.
4. `await queue.flush()` before process exit. Snapshot auto-save may debounce; `flush` promotes pending writes.

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

The inner queue stores `RowRecord<T>` (`{ id, item }`) so the store can key by id. The public surface is still `T` — you enqueue plain jobs, never a `RowRecord` yourself.

### 4. Worker helpers

`pipelineWorker` and `retryWorker` return plain worker functions — compose them first, then pass the result to `withWorker`. They do not touch the queue directly.

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

`retries` = retries **after** the first failure. Total attempts = `retries + 1`.

| `retries` | Total attempts |
| --- | ---: |
| `0` | 1 |
| `1` | 2 |
| `3` | 4 |

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

Prefer a declarative setup? [`@qkitt/queue-config`](../queue-config) builds the same queue → persist → worker stacks from a JS/JSON object:

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

**Unmatched** publishes can go to a sink queue. `publish` returns the number of **bindings** that matched — the unmatched sink is not a binding, so the return value stays `0` even when the sink enqueues. Use `router:unmatched` (`delivered`) or the sink queue's `size()` for sink metrics.

Workers on router-bound queues receive `{ topic, data }` (a `RouteMessage`), not the bare payload.

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

| Call | When |
| --- | --- |
| Auto-save (default) | After mutations; coalesced (microtask or `autoSaveDebounceMs`) |
| `flush()` | Wait until pending auto-saves / in-flight writes settle — **shutdown path** |
| `persist()` | Explicit full snapshot write **now**; never debounced |

Row has no `persist()`; use `flush()` to await the insert/remove/clear chain.

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

Every layer is typed. `on` returns an unsubscribe function. The emitter also works standalone via `buildEventEmitter` (see [API](#api-reference)).

| Layer | Events |
| --- | --- |
| Queue | `queue:enqueued`, `queue:dequeued`, `queue:emptied`, `queue:cleared` |
| Worker | `worker:started`, `worker:completed`, `worker:failed`, `worker:idle`, `worker:pump-error` |
| Router | `router:bound`, `router:unbound`, `router:published`, `router:unmatched`, `router:error` |
| Snapshot | `persist:loaded`, `persist:saved`, `persist:error` |
| Row | `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error` |

Events cost nothing when nobody is subscribed.

## Waiting for drain

No built-in idle wait — use `worker:idle` directly:

```ts
function whenIdle(queue: {
  on: (event: 'worker:idle', cb: () => void) => () => void
  isEmpty: () => boolean
  isProcessing: () => boolean
}): Promise<void> {
  return new Promise((resolve) => {
    const off = queue.on('worker:idle', () => {
      off()
      resolve()
    })
    if (queue.isEmpty() && !queue.isProcessing()) {
      off()
      resolve()
    }
  })
}

// usage
queue.enqueue(job)
await whenIdle(queue)
```

Resolves when the queue is empty and nothing is in flight. A later `enqueue` starts work again. Prefer this over busy-polling `isProcessing`.

## Notes & pitfalls

**Stack order matters.** Persist wraps the bare queue; worker is outermost. **Persist inside, worker outside.**

```ts
// wrong — withRowPersist throws (worker already attached)
withRowPersist(withWorker(buildQueue<RowRecord<T>>(), run), store)

// right
withWorker(withRowPersist(buildQueue<RowRecord<T>>(), store), run)
```

**Await `hydrate()` before enqueue** when using persist, or mutations throw `QueueHydratingError`. Call `flush()` before process exit so debounced writes are not lost.

```ts
const queue = withSnapshotPersist(buildQueue<T>(), store)
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

**Failed items are not re-queued.** Use `retryWorker` or handle the event:

```ts
queue.on('worker:failed', ({ item, error }) => {
  // log, alert, or re-enqueue manually
})
```

**Web Storage is not multi-tab safe or transactional.** Prefer one owning tab, or a real DB, when durability is shared.

## Benchmark summary

In-process peers only. Full tables and setup in the [root README](../../README.md#benchmarks). Re-run: [`packages/bench`](../bench) (`npm run bench` from repo root).

Worker drain measures concurrent jobs and retained memory under a backlog. Bare `buildQueue` is in the same range as dedicated queue structures with lower retained memory, and beats `Array#shift` by two orders of magnitude.

**Worker drain** — 10 000 no-op jobs (ops/s · pending-job heap)

| Library | c=1 | c=4 | heap Δ (c=1) |
| --- | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **622** | **635** | **243 KiB** |
| fastq | 109 | 106 | 6.82 MiB |
| async.queue | 185 | 213 | 5.00 MiB |
| p-queue | 82 | 78 | 10.84 MiB |

**Bare queue** — 50 000 enqueue + dequeue (ops/s median · retained heap)

| Library | ops/s | heap Δ |
| --- | ---: | ---: |
| **@qkitt/queue** `buildQueue` | 1,467 | 1.19 MiB |
| denque | 1,849 | 1.36 MiB |
| yocto-queue | 2,361 | 1.92 MiB |
| native `Array` push/shift | 7 | 1.18 MiB |

Relative numbers (Node 22, Windows laptop, 2026-07-19). YMMV.

---

## API reference

The sections above show composition patterns; the reference below covers every public signature.

**Primary (most apps):** `buildQueue`, `withWorker`, `retryWorker`, `pipelineWorker`, `pipelineDone`, `withSnapshotPersist`, `withRowPersist`, memory/web store factories, `buildRouter`, common types (`Queue`, `WorkerFn`, `RowRecord`, `RouteMessage`, store interfaces).

Everything else (`tryDequeue` / `tryPeek` / `QueueSlot`, `replaceAll`, `emit`, `createId`) is for specialized use — see individual entries below.

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
| `tryDequeue()` | `QueueSlot<T> \| undefined` | Nullish-safe: `{ value }` or `undefined` if empty |
| `tryPeek()` | `QueueSlot<T> \| undefined` | Nullish-safe peek |
| `size()` | `number` | Item count |
| `isEmpty()` | `boolean` | |
| `clear()` | `void` | Remove all; emits `queue:cleared` |
| `replaceAll(items)` | `void` | Silent replace (no queue events). Used by persist hydrate — not a substitute for looping `enqueue`. |
| `toArray()` | `T[]` | Snapshot head → tail |
| `on` | `() => void` | Subscribe; returns unsubscribe |
| `emit` | | Advanced; prefer domain methods so invariants hold |

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

Methods added by inner layers (e.g. `flush`, `hydrate`) remain accessible on the decorated queue.

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
| `autoSaveDebounceMs` | `number` | `0` (microtask coalesce) |

When `autoSave` is true, burst mutations are coalesced: `0` (default) schedules one save per microtask; `> 0` waits that many ms after the last mutation. See [Snapshot: `persist` vs `flush`](#snapshot) for when to call which.

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

Requires `buildQueue<RowRecord<T>>()`. The decorated surface is `QueueWithRowPersist<T>` — you enqueue plain `T`; the inner queue holds `{ id, item }` records.

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
pipelineDone<T>(value: T): PipelineDone<T>
```

Each step is `StepFn` or `{ name, fn, metadata? }`. Bare functions get names like `step[0]`.

**Early exit:** `return pipelineDone(value)` from a step — remaining steps are skipped; the worker **resolves** with `value` (marker is unwrapped). Not a failure; `retryWorker` will not retry.

**Errors:** `PipelineStepError` (`stepName`, `stepIndex`, `metadata`, `cause`). Empty `steps` throws at construction.

---

### `buildRouter`

```ts
buildRouter(options?: BuildRouterOptions): Router
```

| Option | Type | Notes |
| --- | --- | --- |
| `unmatchedTarget` | `{ enqueue(msg) }` | Sink for unmatched publishes |

**Methods:** `bind(pattern, target)` → unbind fn, `unbind(pattern, target?)`, `publish(topic, data)` → matched binding count (unmatched sink excluded), `unmatchedCount()`, `lastUnmatched()`, `clearUnmatched()`, `setUnmatchedTarget(target?)`, `on` / `emit`.

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
| `QueueSlot<T>` | `{ value: T }` — structural wrapper for `tryDequeue` / `tryPeek` |
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

**Default:** import from `@qkitt/queue`. Subpaths are optional for bundle splitting or narrower imports.

| Subpath | Exports | Does *not* contain |
| --- | --- | --- |
| `@qkitt/queue` | Everything | — |
| `@qkitt/queue/queue` | `buildQueue`, `withWorker`, persist wrappers | Store adapters |
| `@qkitt/queue/worker` | `pipelineWorker`, `pipelineDone`, `retryWorker`, related errors/types | `withWorker` |
| `@qkitt/queue/router` | `buildRouter`, router types | — |
| `@qkitt/queue/persist` | Memory + Web Storage stores | `withRowPersist` / `withSnapshotPersist` |
| `@qkitt/queue/events` | `buildEventEmitter`, … | — |

Companion: [`@qkitt/queue-config`](../queue-config) — declarative `defineConfig` / `buildFromConfig`.

`@qkitt/queue/worker` is worker **helpers** only. The queue worker decorator (`withWorker`) lives under `@qkitt/queue/queue`. Same split for persist: adapters under `/persist`, wrappers under `/queue`.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration guidance.

## License

[ISC](./LICENSE)
