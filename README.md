# @qkitt/queue

Typed FIFO queues for TypeScript. Compose a bare queue with a worker, retries, a pipeline, topic routing, and optional persistence.

Zero runtime dependencies. ESM only. Node.js 18+.

## Features

### Queue types

- **Queue** — FIFO: enqueue, dequeue, peek, clear. Optional max size.
- **Queue with worker** — drains the queue with concurrency, start/stop, idle.
- **Queue with persist** — durable via a snapshot or row store. Stack: queue → persist → worker.

### Workers (build helpers)

Functions you pass into a queue worker:

- **Pipeline** — chain steps; each output feeds the next.
- **Retry** — backoff and optional `shouldRetry`.

### Router

Publish on topics; bind queues with MQTT/AMQP-style patterns (`*`, `#`). Unmatched messages can go to a sink queue.

### Persistence adapters

Memory, `localStorage`, `sessionStorage`, or bring your own snapshot/row store.

### Config

Declare stores, queues, workers, and router bindings in one object and build from that. JS can import workers and custom stores; JSON is data-only.

### Events

Typed listeners on every layer (`queue:*`, `worker:*`, `router:*`, `persist:*`). The emitter also works on its own, without queues.

## Install

```bash
npm install @qkitt/queue
```

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

Or import by area:

```ts
import { buildQueue, withWorker } from '@qkitt/queue/queue'
import { pipeline, withRetry } from '@qkitt/queue/worker'
import { buildRouter } from '@qkitt/queue/router'
import { createMemoryRowStore } from '@qkitt/queue/persist'
import { defineConfig, buildFromConfig } from '@qkitt/queue/config'
import { buildEventEmitter } from '@qkitt/queue/events'
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

queue.peek()      // 1
queue.size()      // 2
queue.dequeue()   // 1
queue.toArray()   // [2]
queue.isEmpty()   // false
queue.clear()

const bounded = buildQueue<number>({ maxSize: 100 })
try {
  bounded.enqueue(1)
} catch (error) {
  if (error instanceof QueueFullError) {
    // drop, wait, or reject
  }
}
```

### Events

| Event | Payload | When |
| --- | --- | --- |
| `queue:enqueued` | `{ item, size }` | Item added |
| `queue:dequeued` | `{ item, size }` | Item removed |
| `queue:emptied` | `undefined` | Last item dequeued |
| `queue:cleared` | `{ removed }` | After `clear()` |

```ts
const unsubscribe = queue.on('queue:emptied', () => {
  console.log('drained')
})
unsubscribe()
```

## Queue with worker

`withWorker` dequeues items and runs your async function. Defaults: auto-start, concurrency 1.

```ts
import { buildQueue, withWorker } from '@qkitt/queue'

const queue = withWorker(
  buildQueue<string>(),
  async (name) => `hello ${name}`,
  { concurrency: 3 },
)

queue.on('worker:started', ({ item }) => console.log('start', item))
queue.on('worker:completed', ({ item, result }) => console.log(item, '→', result))
queue.on('worker:failed', ({ item, error }) => console.error(item, error))
queue.on('worker:idle', () => console.log('idle'))

queue.enqueue('a')
queue.enqueue('b')

queue.stop()         // no new items; in-flight finish
queue.start()
queue.isRunning()
queue.isProcessing()
queue.activeCount()
```

Manual start:

```ts
const queue = withWorker(buildQueue<number>(), async (n) => n * 2, {
  autoStart: false,
})

queue.enqueue(1)
queue.start()
```

| Event | Payload | When |
| --- | --- | --- |
| `worker:started` | `{ item }` | Before run |
| `worker:completed` | `{ item, result }` | Resolved |
| `worker:failed` | `{ item, error }` | Rejected |
| `worker:idle` | `undefined` | Empty and nothing in flight |

Failed items are not re-queued. Use `withRetry` or handle `worker:failed`.

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
    retries: 3, // attempts = retries + 1
    delay: (attempt) => 100 * 2 ** (attempt - 1),
    shouldRetry: (error) => !(error instanceof TypeError),
  },
)

const queue = withWorker(buildQueue<{ url: string }>(), worker)
```

Shorthand when you only need a retry count:

```ts
const worker = withRetry(async (n: number) => callApi(n), 2)
```

After all attempts fail: `RetryExhaustedError` with `attempts` and `cause`.

## Pipeline

Takes an array of steps — bare functions and/or `{ name, fn, metadata? }` objects (mixable). Each step is called as `fn(input, ctx)` where `ctx` is `{ name, index, metadata }`. Empty arrays throw at construction (and invalid step shapes). Failures throw `PipelineStepError` with the same fields plus `cause`. Bare functions get default names like `step[0]`.

Heterogeneous step lists cannot infer end-to-end types; use `pipeline<In, Out>([...])` when you need a precise result type.

```ts
import { buildQueue, pipeline, withWorker } from '@qkitt/queue'

// bare functions (one-arg still fine)
const worker = pipeline([
  async (id: string) => fetchUser(id),
  async (user) => enrich(user),
  async (enriched) => save(enriched),
])

// named steps + metadata available to fn and on error
const named = pipeline([
  { name: 'fetch', fn: async (id: string) => fetchUser(id) },
  {
    name: 'save',
    metadata: { table: 'users' },
    fn: async (user, ctx) => save(user, ctx.metadata),
  },
])

const queue = withWorker(buildQueue<string>(), worker)
queue.enqueue('user-42')
```

With retry:

```ts
const worker = withRetry(
  pipeline([
    { name: 'validate', fn: async (job: Job) => validate(job) },
    { name: 'deliver', fn: async (job) => deliver(job) },
  ]),
  { retries: 2, delay: 250 },
)
```

## Router

| Pattern | Matches |
| --- | --- |
| `orders.created` | Exact topic |
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

withWorker(created, async ({ topic, data }) => {
  console.log(topic, data.id, data.total)
})

router.publish('orders.created', { id: 1, total: 42 })
// both queues get { topic, data }

router.publish('orders.shipped', { id: 1, carrier: 'ups' })
// only orders.#

const unbind = router.bind('jobs.*', buildQueue())
unbind()

router.on('router:unmatched', ({ topic, data, delivered }) => {
  console.warn('no route', topic, data, delivered)
})
```

### Unmatched

```ts
const unrouted = buildQueue<RouteMessage>()
const router = buildRouter({ unmatchedTarget: unrouted })

router.publish('no.binding', { id: 1 })
// publish returns 0; message still lands in unrouted

router.unmatchedCount()
router.lastUnmatched()
router.clearUnmatched() // stats only
router.setUnmatchedTarget(unrouted) // or undefined to clear
```

In config:

```ts
router: {
  bindings: [{ pattern: 'mail.#', queue: 'mail' }],
  unmatchedQueue: 'unrouted',
}
```

The sink is not a match — `publish` still returns `0`. If a matched binding's `enqueue` throws, `publish` still counts that binding as matched and does not deliver to `unmatchedTarget` (see `router:error`).

| Event | Payload |
| --- | --- |
| `router:bound` | `{ pattern }` |
| `router:unbound` | `{ pattern, removed }` |
| `router:published` | `{ topic, data, matched }` |
| `router:unmatched` | `{ topic, data, delivered }` |
| `router:error` | `{ operation, error, topic?, pattern? }` |

## Persistence

Two strategies:

1. **Snapshot** — rewrite the whole queue on change
2. **Row** — insert/remove per item

Worker must be outer so `dequeue` goes through persist. Row persist wraps a bare queue whose items are `{ id, item }` records (`RowRecord<T>`); the public API still enqueues plain `T` values.

```ts
import { buildQueue, withRowPersist, withWorker, type RowRecord } from '@qkitt/queue'

// correct
withWorker(withRowPersist(buildQueue<RowRecord<T>>(), store), worker)

// throws — worker already attached
withRowPersist(withWorker(buildQueue<T>(), worker), store)
```

### Snapshot

```ts
import {
  buildQueue,
  withSnapshotPersist,
  createMemorySnapshotStore,
} from '@qkitt/queue'

const store = createMemorySnapshotStore<string>()
const queue = withSnapshotPersist(buildQueue<string>(), store)

await queue.hydrate()
queue.enqueue('a')    // auto-saves by default
await queue.persist() // manual save
await queue.flush()   // wait for pending saves
```

### Row

```ts
import {
  buildQueue,
  withRowPersist,
  createMemoryRowStore,
  type RowRecord,
} from '@qkitt/queue'

const store = createMemoryRowStore<string>()
const queue = withRowPersist(buildQueue<RowRecord<string>>(), store)
// optional: { createId: () => crypto.randomUUID() }

await queue.hydrate()
queue.enqueue('job-1')
await queue.flush()
queue.rowIds()
queue.dequeue()
await queue.flush()
queue.replaceAll(['x', 'y']) // clears store and reinserts with fresh ids
await queue.flush()
```

| | Snapshot | Row |
| --- | --- | --- |
| Writes | Full list rewrite | Insert/remove per op |
| `replaceAll` | Replaces in-memory list + snapshot | Replaces in-memory rows + store clear/reinsert |
| Failed write | `persist:error`; memory unchanged | Failed insert rolls back that row; failed remove/clear error only (hydrate to resync) |
| Wait | `flush()` or `persist()` | `flush()` |

`enqueue` / `dequeue` / `clear` stay sync; store I/O runs on a serialized write chain. Concurrent mutations during `hydrate` throw.

### Browser storage

```ts
import {
  buildQueue,
  withSnapshotPersist,
  withRowPersist,
  createLocalStorageSnapshotStore,
  createLocalStorageRowStore,
  type RowRecord,
} from '@qkitt/queue'

const snapQueue = withSnapshotPersist(
  buildQueue<{ id: string }>(),
  createLocalStorageSnapshotStore('my-app:queue'),
)
await snapQueue.hydrate()

const rowQueue = withRowPersist(
  buildQueue<RowRecord<{ id: string }>>(),
  createLocalStorageRowStore('my-app:jobs'),
)
await rowQueue.hydrate()
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

### Events

**Snapshot:** `persist:loaded`, `persist:saved`, `persist:error`  
**Row:** `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error`

```ts
queue.on('persist:error', ({ operation, error }) => {
  console.error(operation, error)
})

await queue.flush()
```

## Config

Named `stores` + named `queues` (+ optional `router`). Build the stack from that object.

### JS (recommended)

```ts
// queue.config.ts
import { defineConfig } from '@qkitt/queue'
import { handleMail } from './workers/mail'
import { createRedisRowStore } from './stores/redis'

export default defineConfig({
  stores: {
    mailDisk: {
      adapter: 'localStorage',
      strategy: 'row',
      key: 'mail',
    },
    redis: {
      strategy: 'row',
      impl: createRedisRowStore('queue:mail'),
    },
  },
  queues: {
    mail: {
      maxSize: 1000,
      persist: { store: 'mailDisk' },
      worker: { run: handleMail, concurrency: 2 },
    },
    scratch: {},
    unrouted: {},
  },
  router: {
    bindings: [{ pattern: 'mail.#', queue: 'mail' }],
    unmatchedQueue: 'unrouted',
  },
  hydrate: true, // default when any queue has persist
})
```

```ts
// app.ts
import { buildFromConfig } from '@qkitt/queue'
import config from './queue.config'

const system = await buildFromConfig(config)

system.router!.publish('mail.send', { to: 'a@b.c', body: 'hi' })
await system.flushAll()
```

Build order: stores → queue → persist → worker → router → hydrate.

Rules: persist wraps the bare queue; worker is outer; one persist layer per queue; each named store may back at most one queue (shared store definitions are rejected at validation).

### JSON

Built-in adapters only — no workers or custom `impl`.

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
| `stores.<name>.adapter` | `"memory"` \| `"localStorage"` \| `"sessionStorage"` |
| `stores.<name>.strategy` | `"snapshot"` \| `"row"` |
| `stores.<name>.key` | Required for web adapters |
| `stores.<name>.impl` | JS only — your store instance |
| `queues.<name>` | `{}` = plain in-memory |
| `queues.<name>.maxSize` | Capacity; throws `QueueFullError` when full |
| `queues.<name>.persist.store` | Name of a store |
| `queues.<name>.persist.autoSave` | Snapshot only; default `true` |
| `queues.<name>.worker` | JS only — function or `{ run, concurrency?, autoStart? }` |
| `router.bindings` | `{ pattern, queue }` |
| `hydrate` | Load after build (default `true` if any persist) |

### API

| | |
| --- | --- |
| `defineConfig` | Typed JS config |
| `buildFromConfig` | Build from JS config |
| `buildFromJson` | Build from JSON (no workers / `impl`) |
| `validateSystemConfig` / `validateJsConfig` | Validate without building |
| `parseSystemConfig` | Parse + validate JSON |

Build options: `storage` — inject Web Storage (or a mock).

```ts
system.stores
system.queues
system.router      // if configured
system.hydrateAll()
system.flushAll()
system.config
```

## Example

Router → durable queue → concurrent worker with pipeline + retry:

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
  type RowRecord,
} from '@qkitt/queue'

type EmailJob = { to: string; body: string }

const router = buildRouter()
const store = createMemoryRowStore<RouteMessage<EmailJob>>()

const base = withRowPersist(
  buildQueue<RowRecord<RouteMessage<EmailJob>>>(),
  store,
)
await base.hydrate()

const worker = withRetry(
  pipeline([
    {
      name: 'validate',
      fn: async (msg: RouteMessage<EmailJob>) => {
        if (!msg.data.to.includes('@')) throw new Error('bad recipient')
        return msg
      },
    },
    {
      name: 'send',
      fn: async (msg) => {
        await sendEmail(msg.data)
        return msg.data.to
      },
    },
  ]),
  { retries: 3, delay: (n) => 50 * n },
)

const queue = withWorker(base, worker, { concurrency: 2 })

router.bind('mail.send', queue)
router.bind('mail.#', queue)

router.publish('mail.send', { to: 'you@example.com', body: 'hi' })

queue.on('worker:completed', ({ result }) => console.log('sent to', result))
queue.on('worker:failed', ({ error }) => console.error(error))
```

## Package layout

| Subpath | Exports |
| --- | --- |
| `@qkitt/queue` | Everything |
| `@qkitt/queue/queue` | `buildQueue`, `withWorker`, `withRowPersist`, `withSnapshotPersist`, … |
| `@qkitt/queue/worker` | `pipeline`, `withRetry`, `PipelineStepError`, `RetryExhaustedError`, types |
| `@qkitt/queue/router` | `buildRouter`, … |
| `@qkitt/queue/persist` | Memory + Web Storage stores |
| `@qkitt/queue/config` | `defineConfig`, `buildFromConfig`, `buildFromJson`, … |
| `@qkitt/queue/events` | `buildEventEmitter`, … |

`@qkitt/queue/worker` is worker helpers (pipeline, retry). `@qkitt/queue/queue` includes the queue worker decorator. Same split for persist: adapters under `/persist`, queue wrappers under `/queue`.

Internals (`*.util`, codecs, write chain) are not part of the public contract.

## Development

```bash
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run build         # tsup + d.ts → dist/
npm run pack:check    # npm pack --dry-run
npm run release:check # typecheck + test + build + pack:check
```

### Release

1. Bump `package.json` and [CHANGELOG.md](./CHANGELOG.md), commit, and tag `vX.Y.Z`.
2. Push the tag — the [publish workflow](.github/workflows/publish.yml) runs `release:check` and `npm publish`.
3. Add an npm **Automation** token (bypasses 2FA) as the `NPM_PUBLISH` repository secret in GitHub.

Local publish still works with `npm publish --otp=<code>` after `npm login`.

Source files use `<concept>` or `<concept>.<role>.ts` where role is one of: `util`, `support`, `types`, `test`.

See [CHANGELOG.md](./CHANGELOG.md).

## License

[ISC](./LICENSE)
