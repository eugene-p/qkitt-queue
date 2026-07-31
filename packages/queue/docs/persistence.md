# Persistence

Use persistence when an accepted job must still exist after the process or browser reloads. Durability is **built into the queue**: pass a `RowStore` to `buildQueue({ store })`. There is no separate persist decorator and no snapshot strategy — every durable queue is row-based (per-op put/remove with numeric ids and lease fields).

Built-in durable stores: browser Web Storage (`localStorage` / `sessionStorage`). Custom backends implement `RowStore` ([Custom stores](#custom-stores)). Bare `buildQueue()` (no store) is the in-process path — data is not durable across restarts.

Persistence is a reliability boundary, not a default optimization. It adds storage I/O, hydration, and shutdown work; keep `buildQueue()` bare when an in-process backlog is enough. It also does not make a queue distributed or coordinate multiple writers—choose a proper shared backend and ownership model when that is required.

[README](../README.md) · [Composition](./composition.md) · [Delivery & idempotency](./delivery.md) · [API `buildQueue`](./api.md#buildqueue) · [Stores](./api.md#stores)

> **Delivery is at-least-once, not exactly-once.** A side effect may have
> completed before a crash prevents its lease acknowledgement from persisting.
> Use a stable application idempotency key for every durable effect; see
> [Delivery & idempotency](./delivery.md).

## Model

| | Bare queue | Durable queue (`store` set) |
| --- | --- | --- |
| Construction | `buildQueue()` | `buildQueue({ store })` |
| Writes | Process memory only | Memory + `RowStore` put/remove on a write chain |
| Worker path | `claim` / `ack` / `release` (leases) | Same; store updated on claim/ack/release |
| Wait for I/O | `flush()` is a no-op | `await flush()` before process exit |
| Restart | Lost | `await hydrate()` loads rows |

Mutations return `Promise` so async stores work. Bare (no store) paths resolve immediately after the in-process update; durable paths also await the serialized store operation.

While `hydrate` runs, concurrent mutations reject with `HydrateWhileActiveError`. Hydrate also requires an idle queue (no leased rows / active workers).

## Lifecycle

The reliable startup and shutdown sequence is the important part: load rows before a worker can claim them, and let writes finish before the process exits.

1. Build: `buildQueue({ store })`.
2. After restart: `await hydrate()` **before** attaching `withWorker` (or `autoStart: false` → hydrate → `start()`). Hydrate rejects with `HydrateWhileActiveError` while workers are active or rows are leased.
3. Attach worker / loop / dlq; mutate as usual — `enqueue` / `claim` / admin `dequeue` await store I/O when durable.
4. `await flush()` before process exit so the write chain settles.

```ts
import {
  buildQueue,
  withWorker,
  createLocalStorageRowStore,
} from '@qkitt/queue'

type Job = { id: string }

const store = createLocalStorageRowStore<Job>('my-app:jobs')
const base = buildQueue<Job>({ store })
await base.hydrate() // load restored rows first

const queue = withWorker(
  base,
  async (job) => {
    // handle job
  },
  { concurrency: 2 },
)

await queue.enqueue({ id: '1' })
await queue.flush() // before process exit
```

Optional `leaseTtlMs` on `buildQueue` reclaims abandoned in-process leases after a wall-clock deadline. Without it, leased rows are reclaimed only on the next `hydrate` (restart path).

## Row records

```ts
type RowRecord<T> = {
  id: number // safe integer ≥ 1, allocated by the queue
  item: T
  availableAt: number // 0 = claimable now; else ms epoch
  leaseGeneration: number | null
  leaseExpiresAt: number | null
}

type RowStore<T> = {
  loadAll: () => readonly RowRecord<T>[] | Promise<readonly RowRecord<T>[]>
  put: (record: RowRecord<T>) => void | Promise<void>
  remove: (id: number) => void | Promise<void>
  clear: () => void | Promise<void>
  putBatch?: (records: readonly RowRecord<T>[]) => void | Promise<void>
  removeBatch?: (ids: readonly number[]) => void | Promise<void>
  replaceAll?: (records: readonly RowRecord<T>[]) => void | Promise<void>
}
```

Ids are **numeric** and owned by the queue (not string factories). `loadAll` may return rows in any order; the queue rebuilds FIFO from id order of available heads.

## Browser storage

```ts
import {
  buildQueue,
  createLocalStorageRowStore,
} from '@qkitt/queue'

const queue = buildQueue<{ id: string }>({
  store: createLocalStorageRowStore('my-app:jobs'),
})
await queue.hydrate()
```

Also: `createSessionStorageRowStore`, `createWebRowStore` (custom `WebStorageLike`).

Web Storage is not multi-tab safe or transactional. Prefer one owning tab when durability is shared.

### Browser integration checks

Headless Chromium exercises real `localStorage` / `sessionStorage`. From the monorepo root (first time: `npx playwright install chromium`):

```bash
npm run test:browser      # integration specs (round-trip, batch, reload durability)
npm run compare:stores    # bare (in-process) vs localStorage drain + store ops
```

Illustrative Chromium sample (Windows laptop, 2026-07-26 — not a peer bench):

| Worker drain | 1k c=1 | 1k c=4 | 5k c=1 | 5k c=4 |
| --- | ---: | ---: | ---: | ---: |
| Bare (in-process) | ~1.3 ms | ~1.2 ms | ~2.1 ms | ~1.8 ms |
| `localStorage` | ~38 ms | ~27 ms | ~411 ms | ~113 ms |

| Store ops (put N) | N=1k fill | N=5k fill |
| --- | ---: | ---: |
| `localStorage` | ~17 ms | ~245 ms |

`browser/` is dev-only and is not published on npm.

## Custom stores

Implement `RowStore` and pass the instance to `buildQueue({ store })`.

Use a custom store for Node or a real database. The queue owns ids and lease state; the store persists complete rows faithfully. It should be scoped to one queue, because sharing a row collection between queues would mix their ownership and ordering.

```ts
import type { RowRecord, RowStore } from '@qkitt/queue'
import { buildQueue } from '@qkitt/queue'

type Job = { id: string }

const store: RowStore<Job> = {
  async loadAll() {
    // return all durable rows (any order)
    return []
  },
  async put(record: RowRecord<Job>) {
    // upsert full row state by record.id
  },
  async remove(id: number) {
    // delete by id
  },
  async clear() {
    // wipe all rows for this queue
  },
}

const queue = buildQueue<Job>({ store })
await queue.hydrate()
await queue.enqueue({ id: '1' })
await queue.flush()
```

Example (Node file rows): [`examples/fs-row-store`](../../../examples/fs-row-store/main.ts). With [`@qkitt/queue-config`](../../queue-config), pass the instance as `{ impl }` under `stores`.

## Events

| Event | Payload | When |
| --- | --- | --- |
| `persist:loaded` | `{ size }` | After successful `hydrate` |
| `persist:lease-expired` | `{ id, item }` | In-process lease TTL reclaim |
| `persist:id-space-low` | `{ remaining }` | Id counter approaching exhaustion |
| `persist:error` | `{ operation, error, id? }` | Store `load` / `put` / `remove` / `clear` failed |

## Migration from `withPersist` / snapshot (≤ 0.7)

| Before (0.7) | After (0.8+) |
| --- | --- |
| `withPersist(buildQueue(), store)` | `buildQueue({ store })` |
| `createMemorySnapshotStore` / `SnapshotStore` | **Removed** — use Web Storage or a custom `RowStore` |
| Snapshot `autoSave` / `persist()` | Gone — every mutation writes rows; `flush()` waits on the chain |
| Row `insert` + string ids / `createId` | `put` full `RowRecord` with numeric ids from the queue |
| Sync `enqueue` / `dequeue` | Always `Promise` (bare resolves immediately) |

```ts
// before
const q = withWorker(
  withPersist(buildQueue<Job>(), createMemorySnapshotStore()),
  run,
)

// after
const q = withWorker(
  buildQueue<Job>({ store: createLocalStorageRowStore('my-app:jobs') }),
  run,
)
```
