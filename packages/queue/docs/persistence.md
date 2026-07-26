# Persistence

Built-in stores: in-memory and browser Web Storage (snapshot or row). You can also use your own store as long as it matches `SnapshotStore` or `RowStore` ([Custom stores](#custom-stores)).

[README](../README.md) · [Composition](./composition.md) · [API `withPersist`](./api.md#withpersist) · [Stores](./api.md#stores)

## Strategies

| | Snapshot | Row |
| --- | --- | --- |
| Writes | Full list rewrite | Insert/remove per op |
| Good for | Simple backends, small queues | DB-style stores |
| Failed write | `persist:error`; memory unchanged | Failed insert rolls back that row; failed remove/clear error only (hydrate to resync) |
| Wait | `flush()` or `persist()` | `flush()` |

`enqueue` / `dequeue` / `clear` stay sync; store I/O runs on a serialized write chain. Concurrent mutations during `hydrate` throw `QueueHydratingError`. A second concurrent `hydrate()` rejects.

Stack rule (same as [composition](./composition.md#3-add-persistence)): **persist inside, worker outside**.

### Persist lifecycle

1. Build stack: bare → persist → worker (**persist inside, worker outside**).
2. `await queue.hydrate()` before enqueue / before expecting workers to process restored items.
3. Mutate as usual — `enqueue` / `dequeue` stay sync.
4. `await queue.flush()` before process exit. Snapshot auto-save may debounce; `flush` promotes pending writes.

## Snapshot

```ts
const store = createMemorySnapshotStore<string>()
const queue = withPersist(buildQueue<string>(), store)

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

## Row

```ts
const store = createMemoryRowStore<string>()
const queue = withPersist(buildQueue<string>(), store)
// optional: pass { createId: () => crypto.randomUUID() } as factory second arg

await queue.hydrate()
queue.enqueue('job-1')
await queue.flush()
queue.rowIds()
queue.replaceAll(['x', 'y']) // clears store and reinserts with fresh ids
await queue.flush()
```

Row ids (from the store's id factory or `loadAll`) must be unique non-empty strings (not whitespace-only).

## Browser storage

```ts
import {
  withPersist,
  createLocalStorageSnapshotStore,
  createLocalStorageRowStore,
} from '@qkitt/queue'

const snap = withPersist(
  buildQueue<{ id: string }>(),
  createLocalStorageSnapshotStore('my-app:queue'),
)
await snap.hydrate()

const rows = withPersist(
  buildQueue<{ id: string }>(),
  createLocalStorageRowStore('my-app:jobs'),
)
await rows.hydrate()
```

Also: `createSessionStorageSnapshotStore`, `createSessionStorageRowStore`.

Web Storage is not multi-tab safe or transactional. Prefer one owning tab, or a real DB, when durability is shared.

## Custom stores

Same API as the built-ins: implement the interface, pass the object to `withPersist`.

```ts
import type { SnapshotStore } from '@qkitt/queue'
import { buildQueue, withPersist } from '@qkitt/queue'

type Job = { id: string }

const store: SnapshotStore<Job> = {
  async load() {
    // return items head → tail
    return []
  },
  async save(items) {
    // replace the full snapshot
  },
}

const queue = withPersist(buildQueue<Job>(), store)
await queue.hydrate()
queue.enqueue({ id: '1' })
await queue.flush()
```

```ts
type SnapshotStore<T> = {
  load: () => readonly T[] | Promise<readonly T[]>
  save: (items: readonly T[]) => void | Promise<void>
}

type RowStore<T> = {
  loadAll: () =>
    | readonly { id: string; item: T }[]
    | Promise<readonly { id: string; item: T }[]>
  insert: (record: { id: string; item: T }) => void | Promise<void>
  remove: (id: string) => void | Promise<void>
  clear: () => void | Promise<void>
}
```

- `load` / `loadAll` return FIFO order (head first).
- Row ids must be unique, non-empty strings (not whitespace-only).
- Optional `persistOptions` on the store object (same as the factories; omit for defaults):
  - **Snapshot:** `autoSave`, `autoSaveDebounceMs`
  - **Row:** `createId`
- Queue methods stay sync; store methods may be async.

Example (Node file snapshot): [`examples/fs-snapshot-store`](../../../examples/fs-snapshot-store/main.ts). With [`@qkitt/queue-config`](../../queue-config), pass the instance as `{ strategy, impl }` under `stores`.
