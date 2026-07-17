# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.4.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.4.0
[0.3.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.3.1
[0.3.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.3.0
[0.2.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.2.0
[0.1.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.1.1
[0.1.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.1.0
