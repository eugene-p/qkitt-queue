# @qkitt/queue-config

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue-config.svg)](https://www.npmjs.com/package/@qkitt/queue-config)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue-config.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue-config.svg)](https://nodejs.org)

Declarative setup for [`@qkitt/queue`](https://www.npmjs.com/package/@qkitt/queue): named stores, queues, workers, optional loop / dead-letter, and topic-router bindings in one object.

Builds the same stack as hand-written composition (`queue → persist → worker → loop → dlq → router`) from a config object. Optional; most apps only need `@qkitt/queue`. See the core [composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) and [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) guides for the underlying model.

**Peer dependency:** `@qkitt/queue` `^0.6.4`. Requires TypeScript **4.7+** with `moduleResolution` `node16` or `nodenext`, or **5.0+** with `bundler`.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.2` → `0.3`). Check the changelog on minor upgrades.

Runnable demos: [`examples/with-config`](https://github.com/eugene-p/qkitt-queue/tree/main/examples/with-config), [`examples/with-config-loop-dlq`](https://github.com/eugene-p/qkitt-queue/tree/main/examples/with-config-loop-dlq).

**[API reference](#api-reference)** · [Config reference](#config-reference) · [JSON mode](#json-mode)

## Install

```bash
npm install @qkitt/queue @qkitt/queue-config
```

## Quick start

**A. Minimal — single queue + worker**

```ts
import { defineConfig, buildFromConfig } from '@qkitt/queue-config'

const system = await buildFromConfig(
  defineConfig({
    queues: {
      jobs: { worker: { run: handleJob, concurrency: 2 } },
    },
  }),
)

system.queues.jobs.enqueue({ id: '1' })
```

**B. Add persist + router**

Add `stores` / `persist` when you need durability; add `router` for topic fan-out.

```ts
// queue.config.ts
import { defineConfig } from '@qkitt/queue-config'
import { handleMail } from './workers/mail'

export default defineConfig({
  stores: {
    mailDisk: {
      adapter: 'localStorage',
      strategy: 'row',
      key: 'mail',
    },
  },
  queues: {
    mail: {
      maxSize: 1000,
      persist: { store: 'mailDisk' },
      worker: { run: handleMail, concurrency: 2 },
    },
    unrouted: {},
  },
  router: {
    bindings: [{ pattern: 'mail.#', queue: 'mail' }],
    unmatchedQueue: 'unrouted',
  },
})
```

Build order: stores → queue(+name) → persist → worker → loop → dlq → router → hydrate (same stack rule: persist inside, worker outside; loop/dlq outside worker).

```ts
// app.ts
import { buildFromConfig } from '@qkitt/queue-config'
import config from './queue.config'

const system = await buildFromConfig(config)

system.router!.publish('mail.send', { to: 'a@b.c', body: 'hi' })
await system.flushAll()
```

Running in Node or tests? Pass a `storage` implementation to `buildFromConfig` for `localStorage` / `sessionStorage` adapters (see [`buildFromConfig`](#buildfromconfig)).

## Config reference

### Top-level shape

```ts
type SystemConfig = {
  stores?: Record<string, StoreDefinition>
  queues: Record<string, QueueConfig>
  router?: RouterConfig
  hydrate?: boolean // default true when any queue has persist
}
```

### `stores`

Named adapters. Queues reference them with `persist.store`.

| Kind | Shape | Notes |
| --- | --- | --- |
| Built-in | `{ adapter, strategy, key? }` | Library constructs the store |
| Custom (JS only) | `{ strategy, impl }` | Your `SnapshotStore` / `RowStore` instance (plain object or class) |

| Field | Values | Notes |
| --- | --- | --- |
| `adapter` | `'memory'` \| `'localStorage'` \| `'sessionStorage'` | Built-in only |
| `strategy` | `'snapshot'` \| `'row'` | Required |
| `key` | `string` | Required for web adapters |
| `impl` | store instance | JS only — no JSON |
| `codec` | `JsonCodec` | Snapshot + web adapters only (JS) |
| `itemCodec` | `JsonCodec` | Row + web adapters only (JS) |

```ts
stores: {
  mem: { adapter: 'memory', strategy: 'snapshot' },
  disk: { adapter: 'localStorage', strategy: 'row', key: 'app:jobs' },
  redis: { strategy: 'row', impl: createRedisRowStore('queue:mail') },
}
```

Each named store must back **exactly one** queue (shared or unused store names are rejected). Web stores must use unique `adapter`+`key` pairs.

### `queues`

| Field | Type | Notes |
| --- | --- | --- |
| `maxSize` | `number` | Safe integer ≥ 1; same as `buildQueue({ maxSize })` |
| `persist` | `{ store, autoSave?, autoSaveDebounceMs?, createId? }` | `store` = name in `stores`; `autoSave` / `autoSaveDebounceMs` **snapshot-only**; `createId` **row-only** (JS) |
| `worker` | `WorkerFn` or `{ run, concurrency?, autoStart? }` | **JS only** — not available in JSON |
| `loop` | `true` or `{ map?, filter?, delay? }` | `withLoop` after worker; requires `worker`. Queue config key is `buildQueue({ name })`. `map` / `filter` / function `delay` **JS only**; static `delay` ms allowed in JSON. **Delay is not durable** — restart/crash drops pending delayed re-entries (see core [loop delay disclaimer](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#loop-withloop)) |
| `dlq` | `string` or `{ queue, map?, filter? }` | `withDlq` after worker/loop; requires `worker`. Target must be another named queue. `map` / `filter` **JS only** |

Every queue is built with `name` equal to its key under `queues` (for hop meta and `getQueueName`).

```ts
queues: {
  scratch: {}, // plain in-memory
  jobs: {
    maxSize: 500,
    persist: { store: 'disk', autoSave: true },
    worker: { run: handleJob, concurrency: 4, autoStart: true },
    loop: true,
    dlq: 'failed',
  },
  failed: { maxSize: 10_000 },
}
```

#### `loop` + `dlq` together

Both attach to `worker:failed` **independently** — not “loop until filter fails, then DLQ.”

| Setup | Result |
| --- | --- |
| `loop: true` and `dlq: 'failed'` (default filters) | **Duplicates:** every failure re-enters *and* is dead-lettered |
| Complementary `filter`s | Chain: re-enter while under a hop cap; DLQ only when the cap is hit |

```ts
import { getLoopHops } from '@qkitt/queue'
import { defineConfig } from '@qkitt/queue-config'

const MAX = 3

export default defineConfig({
  queues: {
    jobs: {
      worker: handleJob,
      loop: {
        delay: (hops) => 50 * hops, // 1-based hop count only
        filter: (_item, _error, ctx) => (ctx.previousHops ?? 0) < MAX,
      },
      dlq: {
        queue: 'failed',
        filter: (item) => (getLoopHops(item, 'jobs') ?? 0) >= MAX,
      },
    },
    failed: {},
  },
})
```

Runnable: [`examples/with-config-loop-dlq`](https://github.com/eugene-p/qkitt-queue/tree/main/examples/with-config-loop-dlq). Hand composition: [`examples/loop-and-dlq`](https://github.com/eugene-p/qkitt-queue/tree/main/examples/loop-and-dlq) and core [Chaining withLoop + withDlq](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#chaining-withloop--withdlq).

### `router`

| Field | Type | Notes |
| --- | --- | --- |
| `bindings` | `{ pattern, queue }[]` | `queue` is a name under `queues` |
| `unmatchedQueue` | `string` | Named sink for unrouted publishes (not a pattern match) |

```ts
router: {
  bindings: [
    { pattern: 'orders.#', queue: 'orders' },
    { pattern: 'orders.created', queue: 'audit' },
  ],
  unmatchedQueue: 'unrouted',
}
```

### `hydrate`

Load all persisted queues after build (and after workers attach, so restored items can run when `autoStart` is on). Defaults to `true` when any queue has `persist`. Set `false` to hydrate yourself via `system.hydrateAll()` or per-queue `hydrate()`.

### Build rules

- Persist wraps the bare queue; worker is outer (**persist inside, worker outside** — same as hand composition).
- Optional `loop` then `dlq` wrap the worker queue (both require `worker`).
- One persist layer per queue.
- One store → one queue.
- `dlq` target must exist under `queues` and must not be the source (use `loop` for same-queue).
- JSON cannot carry workers, custom `impl`, or `map` / `filter` functions.

## JSON mode

Built-in adapters only — no workers, no custom stores.

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
import { buildFromJson } from '@qkitt/queue-config'

const system = await buildFromJson(jsonText, { storage: myWebStorage })
```

---

## API reference

### `defineConfig`

```ts
defineConfig<T extends SystemConfig>(config: T): T
```

Typed identity helper for JS/TS config modules. Preserves worker and `impl` references.

### `buildFromConfig`

```ts
buildFromConfig<T extends SystemConfig>(
  config: T,
  options?: BuildFromConfigOptions,
): Promise<ConfiguredSystem<T>>
```

| Option | Type | Notes |
| --- | --- | --- |
| `storage` | `WebStorageLike` | Inject Web Storage (tests, Node, mocks) for `localStorage` / `sessionStorage` adapters |
| `skipValidate` | `boolean` | Skip re-validation when config was already validated (`defineConfig` / parse) |

Validates, resolves stores, builds queues (persist → worker → loop → dlq), applies router bindings, optionally hydrates.

### `buildFromConfigSync`

```ts
buildFromConfigSync<T extends SystemConfig>(
  config: T,
  options?: BuildFromConfigOptions,
): ConfiguredSystem<T>
```

Same wiring as `buildFromConfig`, but **synchronous**. Throws `ASYNC_REQUIRED` if hydrate would run — pass `hydrate: false` or use the async builder when queues have `persist` and you want auto-hydrate.

### `buildFromJson`

```ts
buildFromJson(
  json: string,
  options?: BuildFromConfigOptions,
): Promise<ConfiguredSystem>
```

Parse + validate + build. Workers and custom `impl` are not supported in JSON.

### `validateSystemConfig` / `validateJsConfig`

```ts
validateSystemConfig(config: unknown): SystemConfig
validateJsConfig<T extends SystemConfig>(config: T): T
```

Validate without building. `validateJsConfig` allows functions / `impl` and returns the **same object reference**. `validateSystemConfig` is the JSON-safe shape (returns a cleaned reconstruction).

### `parseSystemConfig`

```ts
parseSystemConfig(json: string): SystemConfig
```

Parse JSON text and validate.

### `ConfigValidationError`

Thrown for invalid config / resolve / build failures:

```ts
import { ConfigValidationError } from '@qkitt/queue-config'

try {
  await buildFromConfig(config)
} catch (e) {
  if (e instanceof ConfigValidationError) {
    console.error(e.code, e.path, e.message)
  }
}
```

| Field | Description |
| --- | --- |
| `code` | Stable `ConfigErrorCode` (e.g. `STORE_NOT_FOUND`, `KEY_REQUIRED`) |
| `path` | Optional config path (`config.stores.jobs.key`) |
| `message` | Human-readable detail |

### `ConfiguredSystem`

Returned by `buildFromConfig` / `buildFromJson`:

| Property / method | Description |
| --- | --- |
| `queues` | Map of configured queues (worker/persist methods required in types when configured) |
| `stores` | Resolved store instances by name |
| `router` | Present when `router` was set in config |
| `hydrateAll()` | Hydrate every queue that exposes `hydrate` |
| `flushAll()` | Drain pending auto-saves / write chains (`flush`) |
| `persistAll()` | Explicit snapshot `persist()` on every queue that has it |
| `config` | Nested plain data frozen; worker functions and store `impl` refs preserved |

**`ConfiguredQueue`** — base `Queue` plus, when configured:

| Method | When |
| --- | --- |
| `start` / `stop` / `isRunning` / `activeCount` / … | Worker attached |
| `hydrate` / `flush` / `persist?` / `rowIds?` | Persist attached |

### Config types

| Type | Role |
| --- | --- |
| `SystemConfig` | Top-level config |
| `StoreDefinition` | Built-in or custom store entry |
| `PersistConfig` | `{ store, autoSave?, autoSaveDebounceMs?, createId? }` on a queue |
| `QueueConfig` | `maxSize`, `persist`, `worker`, `loop`, `dlq` |
| `WorkerConfig` | Function or `{ run, concurrency?, autoStart? }` |
| `LoopConfig` | `true` or `{ map?, filter?, delay? }` for `withLoop` |
| `DlqConfig` | Target queue name string or `{ queue, map?, filter? }` for `withDlq` |
| `RouterConfig` / `BindingConfig` | Router section |
| `BuildFromConfigOptions` | `{ storage?, skipValidate? }` |
| `BuiltinStoreAdapter` | `'memory' \| 'localStorage' \| 'sessionStorage'` |
| `ResolvedStore` | `SnapshotStore \| RowStore` after build |
| `ConfiguredQueueFor` | Precise queue type from one `QueueConfig` entry |
| `ConfigErrorCode` | Union of validation error codes |
| `ConfigValidationError` | Typed error class (see above) |

## Migration (from `@qkitt/queue` ≤ 0.4)

Config used to ship inside the core package. Core removed it in **`@qkitt/queue@0.5.0`**; this package starts at **`0.1.0`**:

```ts
// before
import { buildFromConfig, defineConfig } from '@qkitt/queue'
// or
import { buildFromConfig, defineConfig } from '@qkitt/queue/config'

// after
import { buildFromConfig, defineConfig } from '@qkitt/queue-config'
```

## License

[ISC](./LICENSE)
