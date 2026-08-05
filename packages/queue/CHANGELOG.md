# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] — 2026-08-05

### Added

- Lease renewal with `extendLease()` and optional worker `heartbeatMs`.
- Optional unique application-id enforcement with `uniqueJobIds` and
  `DuplicateJobIdError`.
- Stable job pagination cursors, all-match `getJobs()`, and detailed replay and
  router delivery results.
- Best-effort cleanup of unreachable Web Storage generation rows.

### Changed

- Reduce retained `MemoryRowStore` overhead by using insertion-ordered map
  storage without linked-node metadata.

## [0.14.0] — 2026-08-05

### Added

- `Router.publishAsync()` reports matched, accepted, and failed target writes.
- Web Storage rows use generation manifests so reloads see the previous or
  newly committed generation after an interrupted mutation.

### Fixed

- Serialize durable capacity and exclusive-operation checks with the write
  chain, preventing enqueue, `replaceAll`, and hydrate races.
- Emit `persist:error` for ordinary store failures and chunk timers for delays
  beyond the platform timeout limit.

### Changed

- Reduce large-queue work in row stores, job pagination, and observability
  snapshots while preserving insertion order and retained-memory behavior.

## [0.13.3] — 2026-07-31

### Changed

- Reduce hot-path allocation for bare enqueue and unobserved queue and worker
  events.
- Avoid per-emission listener snapshots and unnecessary delayed-timer resets.

### Fixed

- Release retry and dead-letter metadata after exceptional ready items drain.
- Inspect, cancel, and reschedule jobs without rebuilding complete ready or
  delayed collections.

## [0.13.2] — 2026-07-31

### Changed

- Simplified bare and durable queue delivery onto one async operation path by
  removing benchmark-only inline operations, lease recycling, and other
  speed-specific branches.
- Refreshed the private benchmark suite around retained memory and
  product-shaped workloads.

### Fixed

- Bare ready queues no longer retain durable-only row-id storage, and ordinary
  leases omit inactive DLQ handoff metadata.

## [0.13.1] — 2026-07-30

### Fixed

- Clear consumed available-queue slots and compact the head-index FIFO so
  drained payloads are not retained unnecessarily.
- Preserve durable retry and dead-letter handoff state across head compaction
  and hydration, with regression coverage for transient store failures.

### Changed

- Reduce worker hot-path overhead when handler timing is not observed.
- Refresh benchmark framing and published measurements.

## [0.13.0] — 2026-07-30

### Added

- `withDeadLetter` / `withDlq` now accepts `maxHandoffAttempts` (default `3`)
  to bound destination-handoff retries. Pending handoff state survives durable
  restart without adding storage to ordinary rows.

### Fixed

- A permanently failing DLQ destination can no longer re-deliver source work
  forever; the source is acknowledged and emits `worker:dropped` after its
  bounded handoff attempts.
- `withObservability` no longer rebuilds every job page synchronously from
  each queue lifecycle event.

### Changed

- `onMetrics` now coalesces lifecycle activity to at most one callback per
  microtask. `queue:enqueued` is documented as an availability notification:
  hydrate and batch delayed promotion may coalesce notifications.
- The feature-disabled FIFO and worker paths lazily allocate retry-attempt and
  cancellation state; lease expiry reclaim no longer copies the leased map on
  every claim.
- Removed the uninformative native `Array#shift` baseline from the FIFO bench.

## [0.12.0] — 2026-07-30

### Added

- Application-id job operations for opt-in `Job` envelopes: inspect and page
  ready/delayed/leased jobs, cancel, reschedule, promote, and enqueue-first
  replay from a DLQ queue. Leased jobs remain inspectable but are never
  force-moved.
- `withObservability` with queue depth, oldest-job age, completion/failure,
  retry/DLQ counts, handler/store timing summaries, and isolated metrics and
  tracing hooks.
- `worker:handled` handler-timing and observed `persist:operation` events.

## [0.11.0] — 2026-07-30

### Added

- `withWorker` now supplies a second `WorkerContext` argument with the
  application `Job.id`, durable delivery attempt, lease deadline, tracing
  context, and `AbortSignal`.
- Cooperative worker `timeoutMs` cancellation, with `WorkerTimeoutError` and
  `WorkerLeaseExpiredError` as abort reasons. Retry and pipeline workers pass
  the delivery context through to composed handlers.

## [0.10.0] — 2026-07-30

### Added

- `withRetry` for durable, bounded worker retries. Attempts are persisted in
  queue rows, with capped exponential backoff, optional jitter and failure
  classification; exhausted jobs follow the normal DLQ path.
- Retry events: `retry:scheduled` and `retry:exhausted`.
- Failure-routing guidance for choosing `retryWorker`, `withRetry`, or
  `withLoop`.

## [0.9.0] — 2026-07-30

### Added

- Opt-in `Job<T>` envelopes with `createJob` and `isJob`. Applications can
  persist a stable id, enqueue timestamp, and correlation metadata separately
  from their work payload.

## [0.8.1] — 2026-07-30

### Fixed

- Report rejected asynchronous router targets through `router:error` instead of
  leaving unhandled rejections.
- Keep subscription counts correct when an unsubscribe function is called more
  than once, and reject queue mutations while hydration is active.
- Reclaim bare-queue leases when `leaseTtlMs` is configured.
- Route a custom `onFailure` handler that returns no action through the normal
  fail path, and expose loop / dead-letter handoff failures consistently.

### Changed

- Reduce retained memory in lease recycling, delayed / expiry heaps, hydration,
  `replaceAll`, and Web Storage order maintenance.
- Use a heap for lease-expiry scheduling, avoiding full active-lease scans when
  the TTL timer fires.
- Clarify recovery, routing, persistence-delay, and lease-lifetime semantics in
  the API guides. Benchmark summaries refreshed (Node 26 / 2026-07-30).

## [0.8.0] — 2026-07-26

> **BREAKING — read this before upgrading.** Persistence and the core queue API
> changed substantially. Snapshot stores and `withPersist` are **gone**. Durable
> mode is `buildQueue({ store })` with a lease-based worker path. Mutating
> methods return `Promise`. Plan a deliberate migration; this is not a drop-in.

### Breaking

- **Removed `withPersist`.** Pass a store on construction: `buildQueue({ store })`.
- **Removed snapshot persistence entirely:** `SnapshotStore`, `createMemorySnapshotStore`, snapshot auto-save / `autoSave` / `autoSaveDebounceMs`, and `persist()`.
- **`RowStore` contract rewritten:**
  - Ids are **numeric** (safe integers ≥ 1), allocated by the queue — not strings / `createId`.
  - Methods: `loadAll` / `put` / `remove` / `clear` (optional `putBatch` / `removeBatch` / `replaceAll`).
  - Records are full `RowRecord` (`id`, `item`, `availableAt`, `leaseGeneration`, `leaseExpiresAt`) — not `{ id, item }` inserts.
- **Queue API is lease-first for workers:** `claim` / `ack` / `release` / `reschedule`. Admin path remains `dequeue` / `tryDequeue`.
- **Mutators are async:** `enqueue`, `dequeue`, `tryDequeue`, `clear`, `replaceAll`, `claim`, `ack`, `release`, `reschedule` return `Promise`. Bare (no store) paths still apply memory updates immediately and resolve a shared settled promise.
- **Always-on durable methods on `Queue`:** `hydrate()`, `flush()`, `rowIds()` (hydrate/flush no-op without a store).
- **New / renamed errors:** e.g. `HydrateWhileActiveError`, `LeaseMismatchError`, `IdSpaceExhaustedError`, `ConflictingRecoveryError` (replaces older hydrate/persist-only error shapes such as `QueueHydratingError` / `HydrateInProgressError` where applicable).
- **Worker recovery:** default failure path is drop (or DLQ when registered). `withLoop` / `onFailure` integrate with leases; see failure-routing guide.

### Migration (0.7 → 0.8)

```ts
// before
const q = withWorker(
  withPersist(buildQueue<Job>(), createMemorySnapshotStore()),
  run,
)
await q.hydrate()
q.enqueue(job)

// after
const q = withWorker(
  buildQueue<Job>({ store: createMemoryRowStore() }),
  run,
)
await q.hydrate()
await q.enqueue(job)
await q.flush()
```

Custom snapshot backends must become `RowStore` implementations. Config package **0.6.0** drops `strategy` / snapshot fields — upgrade together.

### Added

- Durable mode via `buildQueue({ store, leaseTtlMs? })` with in-process lease TTL reclaim
- Inline bare hot path (shared resolved promises, freelist leases) for fast non-durable use
- Browser Playwright suite + `npm run compare:stores` (bare vs memory `RowStore` vs `localStorage`)
- Delayed enqueue (`enqueue(item, { delayMs })`), `readyCount()`, `stats()`, lease events
- Worker recovery events: `worker:requeued`, `worker:dropped` (prefer over deprecated `loop:enqueued`)

### Changed

- Workers process via **claim/ack** (success always acks; failures use recovery policy)
- **Loop + DLQ chaining:** loop `filter` false falls through to the fail path (DLQ if registered); single recovery path, not dual independent listeners
- Docs, examples, and benches updated for the constructor-store model
- Example `fs-snapshot-store` → `fs-row-store` (file-backed `RowStore`)
- Benchmark tables refreshed (Node 26 / 2026-07-26)

## [0.7.0] — 2026-07-25

### Added

- `withLoop` option `delay`: static ms or `(hops) => ms` before re-enqueue (process-local timers; restart/crash drops pending delayed items)
- Shared `DelayPolicy` type (`number | (attempt: number) => number`) for retry and loop delay (exported)

### Changed

- **Breaking:** `retryWorker` `delay` function is `(failedAttempt: number) => number` only (no longer receives `error`)

## [0.6.5] — 2026-07-25

### Added

- `whenIdle(queue, { timeoutMs? })` — promise that resolves when the worker queue is empty and nothing is in flight
- `gracefulStop(queue, { flush?, timeoutMs? })` and `queue.gracefulStop(...)` — stop the pump, wait for in-flight work (remaining items stay queued); `flush: true` is opt-in
- `LifecycleTimeoutError` when a lifecycle helper exceeds `timeoutMs`
- Example: `examples/lifecycle` (`whenIdle` vs `gracefulStop` + flush)

## [0.6.4] — 2026-07-25

### Added

- `buildQueue({ name })` — optional logical queue id; read with `getQueueName` (survives decorator layers)
- `withDeadLetter` / `withDlq` — forward `worker:failed` items to a **distinct** destination (`map` / `filter`; same reference throws)
- `withLoop` — re-enqueue failures onto the same worker queue; hop meta under `__qkittQueue.loop[name].hops` (`getLoopHops`, `QKITT_QUEUE_KEY`); **requires** a named queue
- Optional `map` runs on the original item with hop context; library always re-stamps `__qkittQueue`. If map changes that bag → `loop:meta-override` then library override
- Errors: `DeadLetterEnqueueError`, `InvalidDeadLetterOptionError`, `LoopEnqueueError`, `InvalidLoopOptionError`
- Events: `dlq:enqueued` / `dlq:error`, `loop:enqueued` / `loop:meta-override` / `loop:error`
- Examples: `examples/with-loop`, `examples/with-dlq`

## [0.6.3] — 2026-07-24

### Breaking

- Option / construction failures and several persist/router failures throw **named** `Error` subclasses instead of plain `Error`, `TypeError`, or `RangeError`. Messages are unchanged; catch with `instanceof` (or keep matching messages).
  - Queue / worker / options: `InvalidQueueOptionError`, `InvalidWorkerOptionError`, `InvalidRetryOptionError`, `InvalidPipelineError`, `InvalidPersistOptionError`
  - Persist composition / stores / rows: `InvalidQueueCompositionError`, `InvalidStoreError`, `InvalidRowIdError`, `DuplicateRowIdError`, `HydrateInProgressError`
  - Router: `InvalidRoutePatternError`, `InvalidTopicError`
  - Web storage: `StorageUnavailableError`
- `withPersist` bad-store cases throw `InvalidStoreError` (was `TypeError`)

### Added

- Named error classes above are exported from the root barrel and relevant subpaths (`@qkitt/queue/persist`, `@qkitt/queue/queue`, `@qkitt/queue/worker`, `@qkitt/queue/router`, store subpaths for storage errors)

## [0.6.2] — 2026-07-22

### Performance

- **Workers:** thenable process path (sync workers avoid an outer `async` Promise); skip worker event payload work when nobody is subscribed
- Shared `createSubscriptionCounts` helper for integer listener gates on queue, worker, and row-persist hot paths

### Docs

- Refreshed root and package benchmark numbers

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

[Unreleased]: https://github.com/eugene-p/qkitt-queue/compare/v0.15.0...HEAD
[0.15.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.15.0
[0.14.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.14.0
[0.13.3]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.13.3
[0.13.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.13.1
[0.13.2]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.13.2
[0.13.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.13.0
[0.12.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.12.0
[0.11.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.11.0
[0.10.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.10.0
[0.9.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.9.0
[0.8.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.8.1
[0.8.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.8.0
[0.7.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.7.0
[0.6.5]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.6.5
[0.6.4]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.6.4
[0.6.3]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.6.3
[0.6.2]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.6.2
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
