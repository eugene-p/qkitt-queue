# @qkitt/queue-config

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue-config.svg)](https://www.npmjs.com/package/@qkitt/queue-config)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue-config.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue-config.svg)](https://nodejs.org)

Declarative setup for [`@qkitt/queue`](https://www.npmjs.com/package/@qkitt/queue): named stores, queues, workers, optional loop / dead-letter, and topic-router bindings in one object.

Builds the same stack as hand-written composition (`buildQueue({ store? })` → worker → loop → dlq → router) from a config object. Optional; most apps only need `@qkitt/queue`. See the core [composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) and [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) guides for the underlying model.

## Is this package for me?

Start with `@qkitt/queue` when you have one or two queues and want the wiring visible in application code. Choose `@qkitt/queue-config` when several named queues, stores, router bindings, and failure paths would otherwise be repeated across startup code. It does not introduce a second queue model—it creates the same core layers in a predictable order.

The config describes structure; JavaScript/TypeScript config can still point to real worker functions and custom stores. JSON mode is for portable structure only, so it cannot contain workers or custom store instances.

**Peer dependency:** `@qkitt/queue` `^0.8.0`. Requires TypeScript **5.0+** with `moduleResolution` `node16`, `nodenext`, or `bundler`.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

Runnable demos: [`examples/with-config`](https://github.com/eugene-p/qkitt-queue/tree/main/examples/with-config), [`examples/with-config-loop-dlq`](https://github.com/eugene-p/qkitt-queue/tree/main/examples/with-config-loop-dlq).

**[API reference](#api-reference)** · [Config reference](#config-reference) · [JSON mode](#json-mode)

## Install

```bash
npm install @qkitt/queue @qkitt/queue-config
```

## Quick start

**A. Minimal — single queue + worker.** This is useful when configuration is already how your application declares components; otherwise the core package’s [quick start](https://github.com/eugene-p/qkitt-queue#quick-start) is shorter.

```ts
import { defineConfig, buildFromConfig } from '@qkitt/queue-config'

const system = await buildFromConfig(
  defineConfig({
    queues: {
      jobs: { worker: { run: handleJob, concurrency: 2 } },
    },
  }),
)

await system.queues.jobs.enqueue({ id: '1' })
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

Build order: stores → `buildQueue({ name, store? })` → worker → loop → dlq → router → hydrate.

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

Named adapters. Queues reference them with `persist.store`. Every durable store is a **row** store (`RowStore`).

| Kind | Shape | Notes |
| --- | --- | --- |
| Built-in | `{ adapter, key? }` | Library constructs the store |
| Custom (JS only) | `{ impl }` | Your `RowStore` instance |

| Field | Values | Notes |
| --- | --- | --- |
| `adapter` | `'localStorage'` \| `'sessionStorage'` | Built-in Web Storage (durable) |
| `key` | `string` | Required for web adapters |
| `impl` | `RowStore` instance | JS only — no JSON; use for Node/custom backends |
| `itemCodec` | `JsonCodec` | Web adapters only (JS) |

```ts
stores: {
  disk: { adapter: 'localStorage', key: 'app:jobs' },
  redis: { impl: createRedisRowStore('queue:mail') },
}
```

Each named store must back **exactly one** queue (shared or unused store names are rejected). Web stores must use unique `adapter`+`key` pairs.

For in-process queues with no durability, omit `persist` (bare queue). Do not use a store for “memory-only” work.

**Removed (breaking):** `strategy` (`snapshot` / `row`), snapshot stores, and snapshot-only fields.

### `queues`

| Field | Type | Notes |
| --- | --- | --- |
| `maxSize` | `number` | Safe integer ≥ 1; same as `buildQueue({ maxSize })` |
| `persist` | `{ store, leaseTtlMs? }` | `store` = name in `stores`; optional in-process lease TTL |
| `worker` | `WorkerFn` or `{ run, concurrency?, autoStart?, onFailure? }` | **JS only** — not available in JSON |
| `loop` | `true` or `{ map?, filter?, delay? }` | `withLoop` after worker; requires `worker`. Queue config key is `buildQueue({ name })`. `map` / `filter` / function `delay` **JS only**; static `delay` ms allowed in JSON. Delays on persisted queues survive restart. |
| `dlq` | `string` or `{ queue, map?, filter? }` | `withDlq` after worker/loop; requires `worker`. Target must be another named queue. `map` / `filter` **JS only** |

Every queue is built with `name` equal to its key under `queues` (for hop meta and `getQueueName`).

```ts
queues: {
  scratch: {}, // plain in-memory
  jobs: {
    maxSize: 500,
    persist: { store: 'disk' },
    worker: { run: handleJob, concurrency: 4, autoStart: true },
    loop: true,
    dlq: 'failed',
  },
  failed: { maxSize: 10_000 },
}
```

#### `loop` + `dlq` together

Recovery is sequential on the worker: **loop first**; when the loop `filter` returns false, the **fail** path runs (DLQ if configured, else drop).

| Setup | Result |
| --- | --- |
| `loop` only, filter false | Drop |
| `loop` + `dlq`, filter false | Dead-letter |
| Complementary `filter`s | Re-enter while under a hop cap; DLQ when the cap is hit |

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

Load all durable queues after build. `buildFromConfig` attaches workers in a
paused state, hydrates, then starts workers whose `autoStart` is on. This is the
default when any queue has `persist`. Set `false` to use
`buildFromConfigSync`; then keep durable workers at `autoStart: false`, hydrate
them yourself, and call `start()` only after hydration succeeds.

### Build rules

- Durable queues use `buildQueue({ store })` (no persist decorator).
- Optional `loop` then `dlq` wrap the worker queue (both require `worker`).
- One store → one queue.
- `dlq` target must exist under `queues` and must not be the source (use `loop` for same-queue).
- JSON cannot carry workers, custom `impl`, or `map` / `filter` functions.

## JSON mode

Built-in adapters only — no workers, no custom stores.

```json
{
  "stores": {
    "ordersDisk": {
      "adapter": "localStorage",
      "key": "app:orders"
    },
    "auditDisk": {
      "adapter": "localStorage",
      "key": "app:audit"
    }
  },
  "queues": {
    "orders": { "persist": { "store": "ordersDisk" } },
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

Validates, resolves stores, builds queues (store → worker → loop → dlq), applies router bindings, optionally hydrates.

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
| `flushAll()` | Await durable write chains (`flush`) |
| `config` | Nested plain data frozen; worker functions and store `impl` refs preserved |

**`ConfiguredQueue`** — base `Queue` plus, when configured:

| Method | When |
| --- | --- |
| `start` / `stop` / `isRunning` / `activeCount` / … | Worker attached |
| `hydrate` / `flush` / `rowIds` | Always on core `Queue` (hydrate/flush no-op without store) |

### Config types

| Type | Role |
| --- | --- |
| `SystemConfig` | Top-level config |
| `StoreDefinition` | Built-in or custom store entry |
| `PersistConfig` | `{ store, leaseTtlMs? }` on a queue |
| `QueueConfig` | `maxSize`, `persist`, `worker`, `loop`, `dlq` |
| `WorkerConfig` | Function or `{ run, concurrency?, autoStart?, onFailure? }` |
| `LoopConfig` | `true` or `{ map?, filter?, delay? }` for `withLoop` |
| `DlqConfig` | Target queue name string or `{ queue, map?, filter? }` for `withDlq` |
| `RouterConfig` / `BindingConfig` | Router section |
| `BuildFromConfigOptions` | `{ storage?, skipValidate? }` |
| `BuiltinStoreAdapter` | `'localStorage' \| 'sessionStorage'` (and other built-in adapter ids) |
| `ResolvedStore` | `RowStore` after build |
| `ConfiguredQueueFor` | Precise queue type from one `QueueConfig` entry |
| `ConfigErrorCode` | Union of validation error codes |
| `ConfigValidationError` | Typed error class (see above) |

## Migration (from config ≤ 0.5 / core ≤ 0.7)

| Before | After |
| --- | --- |
| In-process snapshot / non-durable store for “persist” | Bare queue (no `persist`) for in-process; Web Storage or `{ impl }` for durability |
| `{ adapter, strategy: 'row', key }` | `{ adapter, key }` (drop `strategy`) |
| `{ strategy, impl }` custom store | `{ impl }` (`RowStore` only) |
| `persist: { store, autoSave, autoSaveDebounceMs, createId }` | `persist: { store, leaseTtlMs? }` |
| Peer `@qkitt/queue` `^0.7` | Peer `^0.8.0` |

Core no longer has `withPersist` / snapshot stores — see the [core persistence migration](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#migration-from-withpersist--snapshot--07).

## License

[ISC](./LICENSE)
