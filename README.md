# @qkitt/queue

A small, typed **FIFO queue toolkit** for TypeScript: compose queues with workers, retries, pipelines, topic routing, and optional persistence.

Zero runtime dependencies. Event-driven. Designed to stay readable and stackable.

## Features

- **Typed FIFO queue** — `enqueue` / `dequeue` / `peek` with lifecycle events
- **Workers** — process items with concurrency, start/stop, and idle detection
- **Retries** — wrap any worker with backoff and `shouldRetry`
- **Pipelines** — chain steps so each step’s output feeds the next
- **Topic router** — MQTT/AMQP-style patterns (`*`, `#`) into queues
- **Persistence** — snapshot or row-level stores (memory, `localStorage` / `sessionStorage`)
- **JS config** — declare queues, persistence, router bindings, and imported workers in one module (JSON subset still supported)
- **Events everywhere** — typed `on` / `once` / `off` / `emit` with `expand()` for composition

## Install

```bash
npm install @qkitt/queue
```

**Requirements:** Node.js **18+** (see `engines`). **ESM only** — `"type": "module"`, no CommonJS/`require` build.

Zero runtime dependencies (TypeScript + Vitest + tsup are dev-only). Published entry is compiled ESM + declarations under `dist/` (`import` / `types`). Tree-shaking friendly (`sideEffects: false`).

```ts
import {
  buildQueue,
  withWorker,
  pipeline,
  withRetry,
  buildRouter,
  withRowPersist,
  withSnapshotPersist,
  createMemoryRowStore,
  createMemorySnapshotStore,
  createLocalStorageRowStore,
  createLocalStorageSnapshotStore,
  buildFromConfig,
  buildFromJson,
  defineConfig,
} from '@qkitt/queue'
```

## Quick start

```ts
import { buildQueue, withWorker } from '@qkitt/queue'

type Job = { id: string; url: string }

const queue = withWorker<Job, Response>(
  buildQueue<Job>(),
  async (job) => fetch(job.url),
)

queue.on('worker:completed', ({ item, result }) => {
  console.log(item.id, result.status)
})

queue.on('worker:failed', ({ item, error }) => {
  console.error(item.id, error)
})

queue.enqueue({ id: '1', url: 'https://example.com' })
```

## Queue

```ts
import { buildQueue, QueueFullError } from '@qkitt/queue'

const queue = buildQueue<number>()

queue.enqueue(1)
queue.enqueue(2)

queue.peek()        // 1 (does not remove)
queue.size()        // 2
queue.dequeue()     // 1
queue.toArray()     // [2]
queue.isEmpty()     // false
queue.clear()       // removes remaining items

// Optional capacity (backpressure): enqueue throws when full
const bounded = buildQueue<number>({ maxSize: 100 })
try {
  bounded.enqueue(1)
} catch (error) {
  if (error instanceof QueueFullError) {
    // drop, wait, or reject the producer
  }
}
```

### Queue events

| Event | Payload | When |
| --- | --- | --- |
| `queue:enqueued` | `{ item, size }` | After an item is added |
| `queue:dequeued` | `{ item, size }` | After an item is removed |
| `queue:emptied` | `undefined` | When the last item is dequeued |
| `queue:cleared` | `{ removed }` | After `clear()` removes items |

```ts
queue.on('queue:enqueued', ({ item, size }) => {
  console.log('added', item, 'size=', size)
})

const unsubscribe = queue.on('queue:emptied', () => {
  console.log('drained')
})
// later
unsubscribe()
```

## Workers

`withWorker` dequeues items and runs your async function. By default it **auto-starts** and processes with **concurrency 1**.

```ts
import { buildQueue, withWorker } from '@qkitt/queue'

const queue = withWorker(
  buildQueue<string>(),
  async (name) => `hello ${name}`,
  { concurrency: 3, autoStart: true },
)

queue.on('worker:started', ({ item }) => console.log('start', item))
queue.on('worker:completed', ({ item, result }) => console.log(item, '→', result))
queue.on('worker:failed', ({ item, error }) => console.error(item, error))
queue.on('worker:idle', () => console.log('nothing left to do'))

queue.enqueue('a')
queue.enqueue('b')

queue.stop()           // stop taking new items (in-flight still finish)
queue.start()          // resume
queue.isRunning()      // boolean
queue.isProcessing()   // any active work?
queue.activeCount()    // how many in flight
```

### Manual start

```ts
const queue = withWorker(buildQueue<number>(), async (n) => n * 2, {
  autoStart: false,
})

queue.enqueue(1)
queue.enqueue(2)
// still queued until:
queue.start()
```

### Worker events

| Event | Payload | When |
| --- | --- | --- |
| `worker:started` | `{ item }` | Just before the worker runs |
| `worker:completed` | `{ item, result }` | Worker resolved |
| `worker:failed` | `{ item, error }` | Worker threw/rejected |
| `worker:idle` | `undefined` | No in-flight work and queue empty |

Failed items are **not** re-queued automatically — use `withRetry` or handle `worker:failed`.

## Retry

```ts
import { buildQueue, withRetry, withWorker } from '@qkitt/queue'

const worker = withRetry(
  async (job: { url: string }) => {
    const res = await fetch(job.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },
  {
    retries: 3, // total attempts = retries + 1
    delay: (attempt) => 100 * 2 ** (attempt - 1), // exponential backoff
    shouldRetry: (error) => !(error instanceof TypeError), // optional filter
  },
)

const queue = withWorker(buildQueue<{ url: string }>(), worker)
```

Shorthand for retries only:

```ts
const worker = withRetry(async (n: number) => callApi(n), 2)
```

When all attempts fail, the worker throws a `RetryExhaustedError` class instance:

- `instanceof RetryExhaustedError` works across normal module boundaries
- `attempts` — how many tries ran
- `cause` — last underlying error

## Pipeline

Compose steps so the output of step *n* becomes the input of step *n+1*:

```ts
import { buildQueue, pipeline, withWorker } from '@qkitt/queue'

const worker = pipeline(
  async (id: string) => fetchUser(id),
  async (user) => enrich(user),
  async (enriched) => save(enriched),
)

const queue = withWorker(buildQueue<string>(), worker)
queue.enqueue('user-42')
```

Combine with retry:

```ts
const worker = withRetry(
  pipeline(
    async (job: Job) => validate(job),
    async (job) => deliver(job),
  ),
  { retries: 2, delay: 250 },
)
```

## Topic router

Publish on concrete topics; bind queues to patterns (MQTT/AMQP style):

| Pattern | Matches |
| --- | --- |
| `orders.created` | Exact topic only |
| `orders.*` | One segment (`orders.created`, not `orders.a.b`) |
| `orders.#` | Zero or more trailing segments |
| `#` | Everything |

```ts
import {
  buildQueue,
  buildRouter,
  withWorker,
  type RouteMessage,
} from '@qkitt/queue'

type Order = { id: number; total: number }

const router = buildRouter()
const created = buildQueue<RouteMessage<Order>>()
const allOrders = buildQueue<RouteMessage>()

router.bind('orders.created', created)
router.bind('orders.#', allOrders)

// Optional: process routed messages with a worker
const createdWorker = withWorker(created, async ({ topic, data }) => {
  console.log(topic, data.id, data.total)
})

router.publish('orders.created', { id: 1, total: 42 })
// → both queues receive { topic: 'orders.created', data: { id: 1, total: 42 } }

router.publish('orders.shipped', { id: 1, carrier: 'ups' })
// → only `orders.#` matches

const unbind = router.bind('jobs.*', buildQueue())
unbind() // remove this binding only

router.on('router:unmatched', ({ topic, data, delivered }) => {
  console.warn('no route for', topic, data, 'sink=', delivered)
})
```

### Unrouted (unmatched) publishes

When nothing binds, the router tracks the miss and can optionally park the message:

```ts
const unrouted = buildQueue<RouteMessage>()
const router = buildRouter({ unmatchedTarget: unrouted })

router.publish('no.binding', { id: 1 })
// → publish returns 0
// → unrouted receives { topic: 'no.binding', data: { id: 1 } }
// → router:unmatched with { delivered: true }

router.unmatchedCount()   // how many unrouted since last clear
router.lastUnmatched()    // { topic, data } | undefined
router.clearUnmatched()   // reset stats only (does not drain the sink queue)
router.setUnmatchedTarget(unrouted) // attach / replace / clear (`undefined`)
```

In config, point at a named queue (not a pattern bind):

```ts
router: {
  bindings: [{ pattern: 'mail.#', queue: 'mail' }],
  unmatchedQueue: 'unrouted', // must exist under queues
}
```

The unmatched sink does **not** count as a match (`publish` still returns `0`).

### Router events

| Event | Payload |
| --- | --- |
| `router:bound` | `{ pattern }` |
| `router:unbound` | `{ pattern, removed }` |
| `router:published` | `{ topic, data, matched }` |
| `router:unmatched` | `{ topic, data, delivered }` — `delivered` if the unmatched sink accepted it |
| `router:error` | `{ operation, error, topic?, pattern? }` — `operation` is `publish` \| `bind` \| `unmatched` |

## Persistence

Two strategies:

1. **Snapshot** — rewrite the whole queue on change (simple backends)
2. **Row** — insert/remove per item (DB / per-key storage)

### Snapshot (memory)

```ts
import {
  buildQueue,
  withSnapshotPersist,
  createMemorySnapshotStore,
} from '@qkitt/queue'

const store = createMemorySnapshotStore<string>()
const queue = withSnapshotPersist(buildQueue<string>(), store)

await queue.hydrate() // load from store into memory
queue.enqueue('a')    // auto-saves by default
await queue.persist() // manual save (also used when autoSave is false)
await queue.flush()   // wait for pending auto-saves
```

### Row (memory)

```ts
import {
  buildQueue,
  withRowPersist,
  createMemoryRowStore,
} from '@qkitt/queue'

const store = createMemoryRowStore<string>()
const queue = withRowPersist(buildQueue<string>(), store)
// Optional: override default nanoid-style ids
// withRowPersist(buildQueue<string>(), store, { createId: () => crypto.randomUUID() })

await queue.hydrate()
queue.enqueue('job-1')
await queue.flush()   // wait for async store insert
queue.rowIds() // stable ids aligned with toArray()
queue.dequeue()
await queue.flush()
```

### Durability notes

Both persist wrappers keep **sync** `enqueue` / `dequeue` / `clear` and apply the same composition model: they **override** mutation methods, serialize store I/O on a write chain, and use a silent `replaceAll` during `hydrate` (no mid-hydrate worker drain). After hydrate completes they emit one `queue:enqueued` so a stacked worker pumps with store removes/saves enabled. Concurrent mutations during `hydrate` throw.

| | Snapshot | Row |
| --- | --- | --- |
| Memory vs store | Snapshot rewrites the full list | Optimistic memory; store insert/remove per op |
| Failed write | `persist:error` on save; memory unchanged by save failure | Failed **insert** rolls that row back out of memory (no clear/enqueue noise); failed remove/clear emit error only (call `hydrate` to resync) |
| Wait for I/O | `flush()` or `persist()` | `flush()` |
| Hydrate | Flushes pending saves, then loads | Flushes pending writes, then loads |

**Composition (required):** worker must be **outer** so `dequeue` hits the persist override:

```ts
// correct
withWorker(withRowPersist(buildQueue(), store), worker)

// wrong — throws from withRowPersist / withSnapshotPersist if a worker is already attached
withRowPersist(withWorker(buildQueue(), worker), store)
```

### Browser `localStorage`

```ts
import {
  buildQueue,
  withSnapshotPersist,
  withRowPersist,
  createLocalStorageSnapshotStore,
  createLocalStorageRowStore,
} from '@qkitt/queue'

// Whole queue as one JSON array
const snapQueue = withSnapshotPersist(
  buildQueue<{ id: string }>(),
  createLocalStorageSnapshotStore('my-app:queue'),
)
await snapQueue.hydrate()

// One key per row + order list
const rowQueue = withRowPersist(
  buildQueue<{ id: string }>(),
  createLocalStorageRowStore('my-app:jobs'),
)
await rowQueue.hydrate()
```

`sessionStorage` helpers: `createSessionStorageSnapshotStore`, `createSessionStorageRowStore`.

**Web Storage limits:** not multi-tab safe and not transactional. Snapshot save is a single key write (last tab wins). Row ops touch multiple keys (`order` + per-row); a quota error or crash mid-op can leave order and rows inconsistent. Prefer a single owning tab, or a server/DB store when durability is shared across tabs or processes.

Custom stores implement either:

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

### Persist events

**Snapshot:** `persist:loaded`, `persist:saved`, `persist:error`  
**Row:** `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error`

```ts
queue.on('persist:error', ({ operation, error }) => {
  console.error(operation, error)
})

// Ensure durable writes finished (both strategies expose flush)
await queue.flush()
```

## Config (one object: stores + queues)

A **single config** has two sections:

1. **`stores`** — named adapters (built-in factories or your own `SnapshotStore` / `RowStore`)
2. **`queues`** — wire queues to store **names**, optional workers, plus router bindings

Custom storage = implement the interface and register it. You never extend a hardcoded store list.

### JS config (recommended)

```ts
// queue.config.ts
import { defineConfig } from '@qkitt/queue'
import { handleMail } from './workers/mail'
import { createRedisRowStore } from './stores/redis' // your impl of RowStore

export default defineConfig({
  stores: {
    // built-in adapter
    mailDisk: {
      adapter: 'localStorage',
      strategy: 'row',
      key: 'mail',
    },
    // custom adapter (JS only)
    redis: {
      strategy: 'row',
      impl: createRedisRowStore('queue:mail'),
    },
  },
  queues: {
    mail: {
      maxSize: 1000, // optional backpressure (QueueFullError when full)
      persist: { store: 'mailDisk' }, // reference by name
      worker: { run: handleMail, concurrency: 2 },
    },
    scratch: {},
    // optional unmatched sink (see router.unmatchedQueue)
    unrouted: {},
  },
  router: {
    bindings: [{ pattern: 'mail.#', queue: 'mail' }],
    unmatchedQueue: 'unrouted',
  },
  // defaults to true when any queue has persist
  hydrate: true,
})
```

```ts
// app.ts
import { buildFromConfig } from '@qkitt/queue'
import config from './queue.config'

const system = await buildFromConfig(config)

system.router!.publish('mail.send', { to: 'a@b.c', body: 'hi' })
// system.queues.mail is already a worker queue (start/stop/…)
// system.stores.mailDisk is the resolved store instance

await system.flushAll()
```

Build order: **resolve stores → queue → persist → worker → router → hydrate**.

Composition rules enforced by the library:

- Persist must wrap the **bare** queue; worker is always **outer**.
- Only **one** persist layer per queue (row **or** snapshot, not both).


### Data-only JSON (built-in adapters only)

```json
{
  "stores": {
    "ordersMem": { "adapter": "memory", "strategy": "snapshot" },
    "auditDisk": {
      "adapter": "localStorage",
      "strategy": "row",
      "key": "app:audit"
    }
  },
  "queues": {
    "orders": { "persist": { "store": "ordersMem", "autoSave": true } },
    "audit": { "persist": { "store": "auditDisk" } }
  },
  "router": {
    "bindings": [
      { "pattern": "orders.#", "queue": "orders" },
      { "pattern": "orders.created", "queue": "audit" }
    ]
  }
}
```

```ts
const system = await buildFromJson(jsonText, { storage: myWebStorage })
```

| Field | Meaning |
| --- | --- |
| `stores.<name>.adapter` | Built-in: `"memory"` \| `"localStorage"` \| `"sessionStorage"` |
| `stores.<name>.strategy` | `"snapshot"` or `"row"` (required) |
| `stores.<name>.key` | Required for web adapters |
| `stores.<name>.impl` | **JS only** — your `SnapshotStore` / `RowStore` instance |
| `queues.<name>` | Named queue. `{}` = plain in-memory |
| `queues.<name>.maxSize` | Optional capacity; enqueue throws `QueueFullError` when full |
| `queues.<name>.persist.store` | **Name** of an entry in `stores` |
| `queues.<name>.persist.autoSave` | Snapshot only; default `true` |
| `queues.<name>.worker` | **JS only** — a function, or `{ run, concurrency?, autoStart? }` |
| `router.bindings` | `{ pattern, queue }` → bind pattern to a named queue |
| `hydrate` | Load persisted queues after build (default `true` if any queue has `persist`) |

### Helpers

| API | Role |
| --- | --- |
| `defineConfig(config)` | Typed JS helper; validates and keeps function / store refs |
| `buildFromConfig(config, options?)` | Resolve stores + build queues / workers / router |
| `buildFromJson(json, options?)` | Data-only JSON → build (rejects `worker` / `impl`) |
| `validateSystemConfig(value)` | Data-only validation |
| `validateJsConfig(config)` | JS validation (allows workers + custom stores) |
| `parseSystemConfig(json)` | Parse + data-only validate without building |

Build options:

- `storage` — inject `localStorage` / `sessionStorage` (or a mock) for built-in web adapters

Returned system:

```ts
system.stores      // resolved store instances by name
system.queues      // named queues (+ worker controls / hydrate / flush when configured)
system.router      // present when config.router was set
system.hydrateAll()
system.flushAll()
system.config      // shallow-frozen config (workers / impls preserved)
```

## Putting it together

Route jobs into a durable, concurrent worker with retries:

```ts
import {
  buildQueue,
  withWorker,
  withRowPersist,
  pipeline,
  withRetry,
  buildRouter,
  createMemoryRowStore,
  type RouteMessage,
} from '@qkitt/queue'

type EmailJob = { to: string; body: string }

const router = buildRouter()
const store = createMemoryRowStore<RouteMessage<EmailJob>>()

const base = withRowPersist(
  buildQueue<RouteMessage<EmailJob>>(),
  store,
)
await base.hydrate()

const worker = withRetry(
  pipeline(
    async (msg: RouteMessage<EmailJob>) => {
      if (!msg.data.to.includes('@')) throw new Error('bad recipient')
      return msg
    },
    async (msg) => {
      await sendEmail(msg.data)
      return msg.data.to
    },
  ),
  { retries: 3, delay: (n) => 50 * n },
)

const queue = withWorker(base, worker, { concurrency: 2 })

router.bind('mail.send', queue)
router.bind('mail.#', queue) // same queue can have multiple bindings

router.publish('mail.send', { to: 'you@example.com', body: 'hi' })

queue.on('worker:completed', ({ result }) => console.log('sent to', result))
queue.on('worker:failed', ({ error }) => console.error(error))
queue.on('worker:idle', () => console.log('inbox empty'))
```

## Design notes

| Concern | Approach |
| --- | --- |
| Composition | Decorator stack: bare queue → persist (optional) → worker (optional) |
| Sync API | `enqueue` / `dequeue` stay sync; store I/O is async on a serialized write chain |
| Events | Typed emitter; listener errors are isolated so pumps keep running |
| Routing | MQTT/AMQP-style patterns; unmatched sink does not count as a match |
| Config | Named stores + named queues; workers/`impl` are JS-only; JSON is data-only |
| Packaging | Zero runtime deps; ESM-only npm package; `npm run build` emits ESM + `.d.ts` to `dist/` |

## Source layout

Consumers always import `@qkitt/queue` (root only). The tree under `src/` mirrors composition layers:

| Folder | Meaning |
| --- | --- |
| `queue/core` | FIFO queue (`buildQueue`) |
| `queue/worker` | Attach a processor (`withWorker`) |
| `queue/persist` | Durable queue decorators + store contracts |
| `persist` | Storage backends (memory, Web Storage) |
| `worker` | Processor helpers (`pipeline`, `withRetry`) — not queue decoration |
| `router` | Topic routing |
| `config` | Declarative system build |
| `events` | Typed emitter |

**Name disambiguation:** `src/worker` = functions that process items; `src/queue/worker` = the decorator that runs them on a queue. `src/persist` = store adapters; `src/queue/persist` = queue decorators that use those stores.

## Naming convention

Files follow **`<concept>.<role>.ts`** with a closed role set (exactly **one** role suffix):

| Role | Meaning | Example |
| --- | --- | --- |
| *(none)* | Primary implementation of that concept | `queue.ts`, `with-worker.ts`, `pipeline.ts` |
| `.util` | Pure / small helper | `write-chain.util.ts`, `match.util.ts` |
| `.support` | Shared glue for a feature | `persist.support.ts` |
| `.types` | Shared contracts only | `persist.types.ts` |
| `.test` | Co-located tests | `queue.test.ts` |

Rules:

- **Folders** answer *which product area / composition layer* (`core/`, `persist/`).
- **Role suffix** answers *kind* (product vs helper vs types). Do not invent a second role word (e.g. not `web-storage.access.util.ts`).
- **Mechanism words live in the concept**, hyphenated: `write-chain.util.ts`, `web-storage-access.util.ts`, `json-codec.util.ts` — not `write.chain.ts` or `json.codec.util.ts`.
- Untagged file in a folder ≈ the thing users think of for that area.
- Prefer folders for area + closed role suffixes for kind; avoid deep `utils/` trees unless util count grows large.
- Extract `.types` when shared across modules or folders; keep types co-located when only one module uses them.

## API map

Public surface (via `@qkitt/queue` / `src/index.ts`):

| Area | Exports |
| --- | --- |
| Queue | `buildQueue`, `QueueFullError`, `Queue`, `QueueEvents`, `BuildQueueOptions` |
| Worker | `withWorker`, `QueueWithWorker`, `WorkerEvents`, `WithWorkerOptions` |
| Snapshot persist | `withSnapshotPersist`, `SnapshotStore`, `SnapshotPersistOptions` |
| Row persist | `withRowPersist`, `RowStore`, `RowRecord`, `createId`, `RowPersistOptions` |
| Worker helpers | `pipeline`, `withRetry`, `RetryExhaustedError`, `WorkerFn`, `StepFn` |
| Router | `buildRouter`, `RouteMessage`, `matchTopic`, `isValidTopic`, `isValidPattern`, … |
| Persist stores | memory + Web Storage factories, `StorageCodecError`, `WebStorageLike` |
| Config | `defineConfig`, `buildFromConfig`, `buildFromJson`, `parseSystemConfig`, `validate*`, `SystemConfig`, … |
| Events | `buildEventEmitter`, `createTypedEmit`, `EventEmitter`, `MergeEventMaps` |

Internals (`forward.util`, `hydrate-gate.util`, `write-chain.util`, `row-ids.util`, codecs) are not part of the stable public contract.

## Development

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # tsup (ESM) + tsc declarations → dist/
npm run pack:check   # npm pack --dry-run (what would publish)
npm run release:check # typecheck + test + build + pack:check
```

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

[ISC](./LICENSE)
