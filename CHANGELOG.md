# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.2.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.2.0
[0.1.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.1.1
[0.1.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.1.0
