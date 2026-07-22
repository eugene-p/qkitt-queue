# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] — 2026-07-22

### Changed

- **Bundle split (persist):** `withPersist` / strategy runtime and built-in store factories ship as separate JS chunks. New optional subpaths: `@qkitt/queue/persist/stores`, `.../memory`, `.../web-storage`. Root and `@qkitt/queue/persist` still re-export stores.
- **Package contents:** only declaration files reachable from public export entry points are published (private strategy / util `.d.ts` no longer pack).

## [0.6.0] — 2026-07-22

### Breaking

- **Events:** public surface is `on` / `emit` only. Removed `once`, `emitLazy`, and `hasListeners` from `EventEmitter`, `Queue`, and wrappers. Use `on` + the returned unsubscribe (or unsubscribe after first fire yourself).
- **Workers:** removed deprecated aliases `withRetry` and `pipeline` (use `retryWorker` / `pipelineWorker`). `isPipelineDone` is no longer exported (`pipelineDone` remains).
- **Router:** topic-match helpers and wildcard constants are no longer public (`matchTopic`, `matchTopicParts`, `isValidTopic`, `isValidPattern`, `TOPIC_SEPARATOR`, `SINGLE_WILDCARD`, `MULTI_WILDCARD`). Use `buildRouter`.
- **Persist:** `withRowPersist` / `withSnapshotPersist` → `withPersist(queue, store)`. Strategy comes from the store shape; options live on the store handle (`persistOptions`). Persist types and APIs are under `@qkitt/queue/persist` (and the root barrel), not `@qkitt/queue/queue`.

### Changed

- `engines.node` is now `>=20` (aligned with CI; Node 18 dropped)

### Migration

```ts
// events — was once(...)
const unsub = queue.on('queue:emptied', (e) => {
  unsub()
  // ...
})

// workers
retryWorker(fn, opts)   // was withRetry
pipelineWorker(steps)   // was pipeline

// persist
withPersist(buildQueue(), store)  // was withRowPersist / withSnapshotPersist
```

## [0.5.6] — 2026-07-20

### Added

- `pipelineDone(value)` / `isPipelineDone` / type `PipelineDone` — successful early exit from `pipelineWorker` (skips later steps, resolves with `value`; not an error, so `retryWorker` does not retry)

## [0.5.5] — 2026-07-19

### Docs

- Recipes index, persist lifecycle checklist, waiting-for-drain (`whenIdle`) recipe, and primary vs advanced API grouping
- Failure model, stack order, retries attempt table, RowRecord callout, router unmatched semantics, package layout “does not contain” table
- JSDoc: `retries` total attempts, row/snapshot durability, worker failures not re-queued, `replaceAll` is not bulk enqueue
- Refreshed root and package benchmark numbers

## [0.5.4] — 2026-07-19

### Added

- `SnapshotPersistOptions.autoSaveDebounceMs` — optional debounce for snapshot auto-save (`0` / omitted = one save per microtask; `> 0` waits ms after the last mutation). `flush()` / `hydrate()` still promote a pending save immediately; explicit `persist()` is never debounced

### Performance

- Row persist: persistent id `Set` for O(1) uniqueness checks (no per-enqueue `toArray` rebuild)
- Snapshot auto-save: coalesce burst mutations (microtask default; see `autoSaveDebounceMs`)
- Router: single topic split via `isValidTopicParts`; stable-binding publish avoids full route array snapshot (version counter)
- Events: in-place `remove` (`indexOf` + `splice`); two-listener dispatch fast path
- Row persist: skip outer `queue:enqueued` / `queue:dequeued` payload mapping when no listeners; single-pass `toArray` / `rowIds`
- `createId`: cache `crypto.getRandomValues`; build id with array + `join`
- Memory row store: id → index map for insert/remove lookup
- Web storage access: cache resolved `localStorage` / `sessionStorage` after first successful resolve

### Fixed

- Row persist: if `inner.enqueue` throws (e.g. `QueueFullError`), roll back the reserved id and skip the scheduled store insert so neither `idSet` nor durable state leaks

## [0.5.3] — 2026-07-19

### Added

- `QueueSlot<T>`, `tryDequeue()`, and `tryPeek()` so emptiness is structural: `undefined` means empty; `{ value }` holds any payload including `null` / `undefined`
- Exported `matchTopicParts` for pre-split topic matching (used by the router hot path)

### Fixed

- Worker pump no longer drops or skips items when the payload is `undefined` (or other nullish values)
- Snapshot auto-save runs after dequeuing an `undefined` payload
- Post-hydrate worker kick no longer skips when the restored head is `undefined`
- Row `replaceAll` reports insert failures as `operation: 'insert'` with `id` (not mislabeled as `clear`)

### Changed

- Router `publish` validates the topic once, splits it once, and matches against pattern parts cached at `bind` (no per-binding re-validation / re-split)
- `toArray` uses a single reverse-fill allocation when both stacks hold items
- Public `dequeue` / `peek` stay allocation-light (inlined); `tryDequeue` / `tryPeek` are the unambiguous path for nullish `T`
- Listener subscription counters kept on the bare-queue hot path (avoids per-op factory cost from `emitLazy` on the 50k FIFO bench)
- Docs: refreshed root and package benchmark numbers; hydrate docs note the gate has no built-in deadline

## [0.5.2] — 2026-07-18

### Added

- `retryWorker` and `pipelineWorker` as the primary worker-helper names

### Changed

- Docs: composition-first READMEs (queue, config, monorepo, bench); API reference for queue and config; less FIFO-centric framing
- Prefer `retryWorker` / `pipelineWorker` in docs and samples. `withRetry` and `pipeline` remain exported as aliases (same functions)

## [0.5.1] — 2026-07-18

### Added

- `EventEmitter.emitLazy` and `EventEmitter.hasListeners` for hot-path-friendly event dispatch
- Private monorepo bench package (`packages/bench`) and documented peer comparisons in the root README

### Changed

- `buildQueue` enqueue/dequeue hot path: maintained size counter; skip event payload work when no listeners are subscribed (subscription counts on `on` / `once`)

## [0.5.0] — 2026-07-16

### Breaking

- **Event API:** public surface is `on` / `once` / `emit` only. Removed `off`, emitter `clear`, `listenerCount`, and `eventNames` from `EventEmitter`, `Queue`, `Router`, and row-persist wrappers. Use the unsubscribe function returned by `on` / `once`. Domain `queue.clear()` / `router.clear()` are unchanged.
- **Config extracted:** declarative config (`defineConfig`, `buildFromConfig`, `buildFromJson`, validators, config types) and the `@qkitt/queue/config` subpath are removed. Use [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config) (starts at `0.1.0`; versioned independently of core).
- **Monorepo:** package source now lives under `packages/queue` (consumer import paths for `@qkitt/queue` are unchanged).

### Migration

```ts
// events
const unsub = queue.on('queue:enqueued', handler)
unsub() // was: queue.off('queue:enqueued', handler)

// config
import { buildFromConfig, defineConfig } from '@qkitt/queue-config'
```

## [0.4.1] — 2026-07-16

### Changed

- Internal maintainability pass with no public API changes
- `withWorker` subscribes to `queue:enqueued` only while running (`start` / `stop`); `autoStart: false` no longer attaches a listener until `start()`
- Removed redundant persist suppression flags; hydrate and insert rollback already use silent `inner` mutations
- Inlined post-hydrate worker kick into the persistence lifecycle helper
- Deduplicated Web Storage key validation and built-in `StoreDefinition` field types

## [0.4.0] — 2026-07-16

### Breaking

These tighten previously loose input handling and worker error swallowing. Call sites that relied on the old leniency need to pass valid values (or handle the new events/errors). Treat as a **minor** break under 0.x unless you prefer a 1.0 major cut.

- `maxSize`, `concurrency`, and `retries` must be safe integers in range; fractional values (e.g. `1.5`) and non-integers no longer coerce via `Math.floor` / `Math.max`
- Invalid retry `delay` values (negative, `NaN`, non-finite) throw instead of being clamped to `0`
- Unexpected `dequeue` failures in `withWorker` emit `worker:pump-error` and **stop** the worker; only `QueueHydratingError` is swallowed so hydrate can resume
- Concurrent second `hydrate()` rejects with “hydrate already in progress” (gate is exclusive)
- Row ids that are empty or whitespace-only, or that collide with an existing id, throw before memory/store mutation
- Router bind patterns reject segments that embed `*`/`#` without being the whole segment (e.g. `orders*` is invalid)

### Fixed

- Hydrate gate no longer clears suppression while another hydrate is still in flight
- Row persist enforces unique, non-empty (non-whitespace) ids from `createId`, `replaceAll`, and `loadAll`

### Changed

- Config validation for `maxSize` / `concurrency` requires safe integers ≥ 1 (aligned with direct APIs)

### Added

- Public `QueueHydratingError` for mutate/dequeue during hydrate
- `worker:pump-error` event

## [0.3.1] — 2026-07-15

### Changed

- GitHub Actions CI and publish workflows use `actions/checkout@v5` and `actions/setup-node@v5` (Node 24 action runtime; project tests/build on Node 22)

### Added

- npm publish workflow triggered by `v*` tags (authenticates with the `NPM_PUBLISH` repository secret)

## [0.3.0] — 2026-07-15

### Changed

- **Breaking:** `withRowPersist` requires an inner queue typed as `RowRecord<T>` (`buildQueue<RowRecord<T>>()`); callers still enqueue plain `T` values
- **Breaking:** removed `expand()` from `buildEventEmitter`, `buildQueue`, and `buildRouter`
- **Breaking:** config validation rejects multiple queues referencing the same named persist store
- **Breaking:** router `publish` counts a binding as matched before `enqueue`; a throwing target no longer delivers to `unmatchedTarget` (`router:error` is emitted instead)
- Queue core uses a two-stack FIFO instead of a head-index ring buffer (same public behavior)
- Worker unsubscribes from `queue:enqueued` while stopped

### Added

- `replaceAll` on row-persisted queues: replaces in-memory rows and clears/reinserts the store with fresh ids

### Removed

- Internal `row-ids` helper (row ids now live in the inner `RowRecord` queue)
- Internal `forwardQueue` decorator helper (replaced by `decorateQueue` via prototype fall-through)

## [0.2.0] — 2026-07-13

### Changed

- **Breaking:** `pipeline` takes an **array of steps** (not variadic args): bare functions and/or `{ name, fn, metadata? }` objects
- Each step receives `(input, ctx)` with `ctx = { name, index, metadata }`
- Failed steps throw **`PipelineStepError`** (`stepName`, `stepIndex`, `metadata`, `cause`)
- **Breaking:** `StepFn` is no longer an alias of `WorkerFn` — it accepts the pipeline `ctx` as a second argument (one-arg functions still work)

### Added

- `PipelineStep`, `PipelineStepObject`, `PipelineStepContext`, and `PipelineStepError` from `@qkitt/queue` / `@qkitt/queue/worker`
- Pipeline construction validates step shape (function or `{ name, fn }`; non-empty `name`)

### Fixed

- Dropped unused `WorkerFn` re-export from the queue worker module (use `@qkitt/queue` or `@qkitt/queue/worker`)

## [0.1.1] — 2026-07-13

### Added

- Area **subpath exports** matching source barrels (release proposal B2):
  - `@qkitt/queue/queue`
  - `@qkitt/queue/worker`
  - `@qkitt/queue/router`
  - `@qkitt/queue/persist`
  - `@qkitt/queue/config`
  - `@qkitt/queue/events`
- Multi-entry ESM build (`tsup` `splitting: true`) so subpaths share chunks instead of fully duplicating code

Root `@qkitt/queue` remains the full surface; subpaths are additive.

## [0.1.0] — 2026-07-12

First public release of `@qkitt/queue`.

### Added

- Typed FIFO queue (`buildQueue`) with optional capacity / `QueueFullError`
- Workers (`withWorker`) with concurrency, start/stop, and idle detection
- Retry helper (`withRetry`) and pipelines (`pipeline`)
- Topic router (`buildRouter`) with MQTT/AMQP-style patterns
- Snapshot and row persistence (memory + Web Storage adapters)
- Declarative config (`defineConfig`, `buildFromConfig`, `buildFromJson`)
- Typed event emitter used across queue, worker, router, and persist layers

### Packaging

- ESM-only publish (`type: module`), zero runtime dependencies
- Node.js `>=18`
- Public surface: `@qkitt/queue` root entry only

[0.6.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.6.1
[0.6.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.6.0
[0.5.6]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.6
[0.5.5]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.5
[0.5.4]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.4
[0.5.3]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.3
[0.5.2]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.2
[0.5.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.1
[0.5.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.0
[0.4.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.4.1
[0.4.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.4.0
[0.3.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.3.1
[0.3.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.3.0
[0.2.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.2.0
[0.1.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.1.1
[0.1.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.1.0
