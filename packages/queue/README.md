<img src="https://raw.githubusercontent.com/eugene-p/qkitt-queue/main/assets/logo.svg" alt="qkitt-queue" width="96" height="96">

# @qkitt/queue — durable in-process job queues for TypeScript

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue.svg)](https://www.npmjs.com/package/@qkitt/queue)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Composable, persistence-first job queues in one Node process or browser: concurrent workers, retries, topic routing, and optional durability. Memory-conscious by design; zero runtime dependencies.

Layers: queue, worker, optional persistence, routing, and failure handling. ESM-only; Node.js 20+, modern browsers, and TypeScript **5.0+** (`moduleResolution`: `node16`, `nodenext`, or `bundler`).

**Out of scope:** work that spans machines or processes.

> Need a simpler worker/drain-first in-memory queue? Use the sibling project [`@qkitt/tinyq`](https://github.com/eugene-p/tinyq). Choose this package when unfinished jobs must survive restart, or you need this package’s composition surface (persistence, routing, durable retries, declarative multi-queue).

## What it is for

Use it for in-process work that needs concurrency, retries, routing, or restart recovery. Start with `buildQueue()`; add `withWorker()`, a `RowStore`, or helpers as needed.

It is not a distributed queue. Use a broker for work across machines or processes.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

Guides live on GitHub (not in the npm tarball). Suggested path: [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) → [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) → [Delivery & idempotency](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/delivery.md) → [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) → [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md). Jump by task via [Recipes](#recipes).

| Guide | Covers |
| --- | --- |
| [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) | Bare / durable queue → worker → helpers → config |
| [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) | `buildQueue({ store })`, row stores, custom backends |
| [Delivery & idempotency](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/delivery.md) | At-least-once delivery, idempotency keys, transactional outbox |
| [Topics & routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/routing.md) | MQTT-style patterns, unmatched sink |
| [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) | `withLoop`, `withDlq`, chaining |
| [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) | `whenIdle`, `gracefulStop` |
| [API reference](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/api.md) | Public signatures, events, package layout |

## Install

**Requirements:** Node.js 20+ or a modern browser; TypeScript 5.0+ for typed consumers; ESM-only. In a CJS context:

```ts
const { buildQueue, withWorker } = await import('@qkitt/queue')
```

```bash
npm install @qkitt/queue
```

```ts
import {
  buildQueue,
  withWorker,
  pipelineWorker,
  retryWorker,
  buildRouter,
  createLocalStorageRowStore,
} from '@qkitt/queue'
```

Subpath exports: `@qkitt/queue/queue`, `/worker`, `/router`, `/persist`, `/persist/stores`, `/events`. See [package layout](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/api.md#package-layout).

## Quick start

Minimal concurrent drain:

```ts
import { buildQueue, withWorker } from '@qkitt/queue'

type Job = { id: string }

const queue = withWorker(
  buildQueue<Job>(),
  async (job) => {
    // handle job
  },
  { concurrency: 2 },
)

await queue.enqueue({ id: '1' })
```

For persistence, retries, or failure routing, see [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md), [worker helpers](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#4-worker-helpers), and [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md).

When a durable job needs an application id for idempotency or correlation,
queue an opt-in `Job<T>` envelope. Its id is separate from the queue's internal
row id:

```ts
import { buildQueue, createJob, type Job } from '@qkitt/queue'

const jobs = buildQueue<Job<{ to: string }>>()
await jobs.enqueue(
  createJob({ to: 'a@example.com' }, { id: 'mail_01H...', metadata: { traceId: 'trace_123' } }),
)
```

See [`Job` / `createJob`](./docs/api.md#job--createjob) for the complete
contract.

Job operations include `listJobs`, `getJob`, `cancelJob`, `rescheduleJob`,
`promoteJob`, and `replayJob`. Add `withObservability(queue)` for metrics and
tracing. See the [API reference](./docs/api.md#withobservability).

> **Durable workers are at-least-once, not exactly-once.** A completed side
> effect can be delivered again if the process stops before its queue
> acknowledgement persists. Use the stable `Job.id` as an idempotency key at
> the side effect. See [Delivery & idempotency](./docs/delivery.md).

Add persistence (`store` on the constructor — no decorator):

```ts
import {
  buildQueue,
  withWorker,
  createLocalStorageRowStore,
} from '@qkitt/queue'

const base = buildQueue<Job>({
  store: createLocalStorageRowStore('my-app:jobs'),
})
await base.hydrate() // after restart: before withWorker

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

Retries or multi-step workers — compose a worker function, then pass it to `withWorker`:

```ts
import {
  buildQueue,
  withWorker,
  retryWorker,
  pipelineWorker,
} from '@qkitt/queue'

const run = retryWorker(
  pipelineWorker([validate, deliver]),
  { retries: 3, delay: 100 },
)

const queue = withWorker(buildQueue<Job>(), run, { concurrency: 4 })
```

Failed items are **not** re-queued by default. Use `retryWorker` for in-call retries or durable [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md). Worker context includes job id, attempt, lease deadline, metadata, and cancellation; see the [API reference](./docs/api.md#withworker).

When stacks grow (many queues, router, stores), prefer [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config).

## Recipes

| Task | Jump to |
| --- | --- |
| Concurrent jobs | [Composition §2](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#2-add-a-worker) |
| Drain / graceful stop | [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) |
| Retries / multi-step | [Composition §4](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#4-worker-helpers) |
| Survive restart | [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) · [Composition §3](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#3-add-persistence) |
| Idempotent durable effects / outbox | [Delivery & idempotency](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/delivery.md) |
| Browser Web Storage | [Browser storage](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#browser-storage) |
| Custom store (file, etc.) | [Custom stores](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#custom-stores) |
| Topic fan-out | [Topics & routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/routing.md) |
| Same-queue re-entry / loop delay | [Loop](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#loop-withloop) |
| Dead-letter sink | [Dead letter](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#dead-letter-withdeadletter--withdlq) |
| Hop, then dead-letter | [Chaining loop + DLQ](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#chaining-withloop--withdlq) |
| Declarative multi-queue | [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config) |

Runnable scenarios: [examples/](https://github.com/eugene-p/qkitt-queue/tree/main/examples) in the monorepo.

## Benchmark summary

Workload context and regression evidence — not a competitive scoreboard. Full tables and setup: [root README](https://github.com/eugene-p/qkitt-queue/blob/main/README.md#benchmarks). Default re-run from repo root: `npm run bench` (payload, durable, workloads). Optional scheduler drain: `npm run bench:worker`. Harness: [`packages/bench`](https://github.com/eugene-p/qkitt-queue/tree/main/packages/bench).

Performance priority for this package: persistence and correctness, then retained memory, then throughput. For a simpler worker/drain-first in-memory queue, see [`@qkitt/tinyq`](https://github.com/eugene-p/tinyq).

**Payload worker drain** — workload context: 5,000 preallocated 1 KiB jobs, c=4. Each handler reads and hashes the payload, then yields. Representative peer context for severe-regression checks, not a ranking target.

| Library | ops/s | heap Δ total | heap Δ / item |
| --- | ---: | ---: | ---: |
| @qkitt/queue `withWorker` | 92 | **5.58 MiB** | **1.1 KiB** |
| fastq | **108** | 6.40 MiB | 1.3 KiB |
| async.queue | 97 | 7.47 MiB | 1.5 KiB |
| p-queue | 75 | 8.82 MiB | 1.8 KiB |

**Durable / workload** full matrices, release baseline, and optional scheduler diagnostic: [root README benchmarks](https://github.com/eugene-p/qkitt-queue/blob/main/README.md#benchmarks) · [bench package](https://github.com/eugene-p/qkitt-queue/blob/main/packages/bench/README.md#release-baseline-0131). Re-run: `npm run bench` / `npm run bench:worker`.

**Browser (Chromium)** — durability context: in-memory vs durable worker drain, 5k jobs c=1: bare ~2 ms · localStorage ~410 ms (`npm run compare:stores`).

Timing uses tinybench p50 (median; mean fallback only if p50 is unavailable). Heap Δ is the median of seven post-GC samples (`heapUsed` + `arrayBuffers`). Relative numbers (Node 26.5.0, Windows laptop, 2026-07-31).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration guidance.

## License

[ISC](./LICENSE)
