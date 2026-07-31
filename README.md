<p align="center" style="margin-bottom:0px;">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="qkitt-queue" width="96" height="96">
  </picture>
</p>

<h1 align="center" style="padding-bottom:0.75rem; margin-top:0px">Durable in-process job queues for TypeScript</h1>

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm @qkitt/queue](https://img.shields.io/npm/v/@qkitt/queue.svg?label=%40qkitt%2Fqueue)](https://www.npmjs.com/package/@qkitt/queue)
[![npm @qkitt/queue-config](https://img.shields.io/npm/v/@qkitt/queue-config.svg?label=%40qkitt%2Fqueue-config)](https://www.npmjs.com/package/@qkitt/queue-config)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Run reliable background work **inside one Node process or browser**: concurrent workers, retries, topic routing, and persistence when restart safety matters. It is not a distributed broker; jobs do not cross servers or processes.

> Need a simpler worker/drain-first in-memory queue? Use the sibling project [`@qkitt/tinyq`](https://github.com/eugene-p/tinyq). Choose `@qkitt/queue` when unfinished jobs must survive restart, or you need this package’s composition surface (persistence, routing, durable retries, declarative multi-queue).

| Package | What it is |
| --- | --- |
| [`@qkitt/queue`](./packages/queue) | Composable, persistence-first in-process job queue: worker, durable retry, routing, job admin, observability, pipeline, loop / DLQ |
| [`@qkitt/queue-config`](./packages/queue-config) | Optional: build a system from a config object |
| [`@qkitt/queue-bench`](./packages/bench) | Local harness for workload regression and retained-memory checks |

Most apps only need `@qkitt/queue` — compose layers in code and reach for `@qkitt/queue-config` when you want a declarative setup instead.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

## Start here

Most applications begin with one queue and one worker: install `@qkitt/queue`, copy the [quick start](#quick-start), and enqueue work. From there, choose the next concern rather than adopting a framework up front:

| If you need… | Add… | Why |
| --- | --- | --- |
| Background jobs with a concurrency limit | `withWorker` | Keeps request handling separate from slow work. |
| Work to survive a restart | a `RowStore` at `buildQueue({ store })` | Restores unfinished rows when the app starts again. |
| A brief transient failure inside one worker call | `retryWorker` | Retries immediately in the same worker slot; it is not durable. |
| A job to retry later, survive restart, then reach a DLQ | `withRetry` | Persists the attempt and backoff between deliveries. |
| Failed work to be retained or tried later | `withDlq` or `withLoop` | Sends it to a separate sink or re-enters the same queue with a hop cap. |
| Metrics, tracing, or job control | `withObservability` and `Job` operations | Inspect, cancel, reschedule, promote, replay, and instrument background work. |
| One message to reach multiple consumers | `buildRouter` | Fans topic messages out to bound queues. |
| Many related queues | `@qkitt/queue-config` | Keeps the same composition in one declarative object. |

Why use it: TypeScript-first, zero core runtime dependencies, and explicit reliability choices. It is not distributed; use a broker for work across machines or processes.

## When to use this

Use it when producers and consumers share a process or browser tab and you need FIFO work, concurrency, retries, persistence, routing, or shutdown handling. Start bare, then add layers as needed:

- **FIFO backlog** — hold work in order until something drains it (orders awaiting fulfillment, moderation queue, form submissions waiting for review).
- **Concurrent workers** — drain that backlog with a concurrency cap (inbound webhooks, notification sends, thumbnail generation).
- **Retries** — use `retryWorker` for a short in-call retry, or durable `withRetry` to release capacity, survive restart, and retry later.
- **Pipelines** — fixed stages per item (validate → reserve stock → charge → confirm).
- **Persistence** — keep unfinished work across a restart (long exports, outbox, unsent messages after a crash). Pass a `RowStore` to `buildQueue({ store })`. Built-in Web Storage; custom stores implement `RowStore`.
- **Topic routing** — one publish, several consumers (`order.placed` → fulfillment, billing, analytics).
- **Failure routing** — re-enter the same queue with hop meta (`withLoop`) or forward failed items to a dead-letter sink (`withDeadLetter` / `withDlq`).
- **Declarative config** — stand up a multi-queue system from one object (`@qkitt/queue-config`).

**Out of scope:** work that spans machines or processes.

## Install

**Requirements:** Node.js 20+ or a modern browser; ESM-only. In a CJS context, use a dynamic import:

```ts
const { buildQueue, withWorker } = await import('@qkitt/queue')
```

```bash
npm install @qkitt/queue
```

Optional config helper:

```bash
npm install @qkitt/queue @qkitt/queue-config
```

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

queue.enqueue({ id: '1' })
```

Add persistence when you need it (`store` on the constructor):

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

Failed items are **not** re-queued. Use `retryWorker` for in-call retries, `withDeadLetter` / `withDlq` for a separate sink, or `withLoop` to re-enter the same queue with hop meta.

For durable retries, job operations, observability, and `WorkerContext` / `timeoutMs`, see the [queue feature guide](./packages/queue/README.md) and [API reference](./packages/queue/docs/api.md).

With config (optional):

```ts
import { defineConfig, buildFromConfig } from '@qkitt/queue-config'

const system = await buildFromConfig(
  defineConfig({
    queues: {
      jobs: { worker: { run: handleJob, concurrency: 2 } },
    },
  }),
)
```

## Examples

| Example | Use case |
| --- | --- |
| [`worker-drain`](./examples/worker-drain/main.ts) | Concurrent jobs + drain wait |
| [`lifecycle`](./examples/lifecycle/main.ts) | `whenIdle` drain vs `gracefulStop` |
| [`retry-pipeline`](./examples/retry-pipeline/main.ts) | Retries / multi-step |
| [`fs-row-store`](./examples/fs-row-store/main.ts) | Survive restart via custom file `RowStore` |
| [`router-topics`](./examples/router-topics/main.ts) | Topic fan-out |
| [`with-config`](./examples/with-config/main.ts) | Declarative multi-queue |
| [`with-loop`](./examples/with-loop/main.ts) | Same-queue re-entry, hop cap, hop-based `delay` |
| [`with-dlq`](./examples/with-dlq/main.ts) | Failed items → distinct sink |
| [`loop-and-dlq`](./examples/loop-and-dlq/main.ts) | Hop, then dead-letter via filters |
| [`with-config-loop-dlq`](./examples/with-config-loop-dlq/main.ts) | Same chain from config |

```bash
npm run build
npx tsx examples/worker-drain/main.ts
# or all: npm run examples
```

Full task index: [`examples/README.md`](./examples/README.md).

## Docs

| Link | Covers |
| --- | --- |
| [`@qkitt/queue`](./packages/queue/README.md) | Install, quick start, recipes, bench summary |
| [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) | Layers, worker helpers, pitfalls |
| [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) | `buildQueue({ store })`, row stores, custom backends |
| [Topics & routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/routing.md) | MQTT-style patterns, unmatched sink |
| [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) | Loop, DLQ, chaining |
| [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) | Drain and graceful stop |
| [API reference](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/api.md) | Public signatures, events, package layout |
| [`@qkitt/queue-config`](./packages/queue-config/README.md) | Config schema, API |
| [`packages/bench`](./packages/bench/README.md) | Benchmark harness — how to re-run |
| [`examples/`](./examples) | Runnable use cases |

## Develop

Requires Node.js >= 20. CI runs on Node 20, 22, 24, and 26.

```bash
npm install
npm test
npm run build
npm run bench
```

`npm run bench` runs the default payload, durable, and workload suites (regression and retained-memory guardrails). Optional scheduler drain: `npm run bench:worker`. Details: [`packages/bench`](./packages/bench).

## Benchmarks

Run with `npm run bench`. Details: [`packages/bench`](./packages/bench).

> AMD Ryzen 7 4800HS (8c/16t) · 16 GB · Windows 11 · Node 26.5.0 · `tinybench` via `tsx --expose-gc` · 2026-07-31 · full tables and re-capture notes: [`packages/bench`](./packages/bench/README.md#release-baseline-0133)

`@qkitt/queue` is a composable, persistence-first in-process job queue. Performance work prioritizes persistence and correctness, then retained memory, then throughput. The numbers below are workload context and regression evidence — not a competitive scoreboard. For a simpler worker/drain-first in-memory queue when persistence and this package’s composition surface are not needed, see [`@qkitt/tinyq`](https://github.com/eugene-p/tinyq).

### Payload worker drain — workload context (5k × 1 KiB job objects, c=4)

Representative peer context for a realistic payload + drain path. Useful for spotting severe regressions in retained heap or throughput under load — not a ranking target.

Preallocated 1 KiB jobs; each handler reads and hashes the payload, then yields.

| Library | ops/s (med) | heap Δ total | heap Δ / item |
| --- | ---: | ---: | ---: |
| @qkitt/queue `withWorker` | 78 | **5.58 MiB** | **1.1 KiB** |
| fastq | **106** | 6.40 MiB | 1.3 KiB |
| async.queue | 94 | 7.47 MiB | 1.5 KiB |
| p-queue | 72 | 8.82 MiB | 1.8 KiB |

Timing uses tinybench p50 (median; mean fallback only if p50 is unavailable). Heap Δ is the median of seven post-GC samples with N items held (`heapUsed` + `arrayBuffers`).

### Durable row lifecycle — internal regression, `MemoryRowStore`

Internal `MemoryRowStore` bookkeeping check; not a storage-backend benchmark.

| Operation (5k rows) | ops/s (med) | heap Δ (pending) |
| --- | ---: | ---: |
| enqueue + flush | 80 | **571.3 KiB** total · **117 B**/job |
| hydrate + worker drain + flush | 97 | — |

### Workload shapes — internal regression (5k × 1 KiB, c=4)

| Scenario | ops/s (med) | heap Δ (burst pending) |
| --- | ---: | ---: |
| burst drain | 263 | **5.90 MiB** total · **1.2 KiB**/job |
| steady producer | 224 | — |

### Browser — durability context (Chromium)

Wall times for in-memory vs durable drain — durability cost context, not a peer scoreboard.

| Mode (5k jobs, c=1) | Drain |
| --- | ---: |
| Bare `buildQueue()` (in-process) | ~2 ms |
| `localStorage` rows | ~410 ms |

Store put N=5k: localStorage ~245 ms. Full matrix: [persistence — browser](./packages/queue/docs/persistence.md#browser-integration-checks).

### Optional diagnostic — scheduler drain

Async no-op worker drain (scheduling overhead only). Re-run with `npm run bench:worker`. Not a product scoreboard.

| Library | 1k c=1 | 1k c=4 | 10k c=1 | 10k c=4 | heap Δ (10k c=1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| @qkitt/queue `withWorker` | 1,519 | 1,814 | 155 | 174 | **87.9 KiB** |
| fastq | **9,259** | **9,149** | **858** | **900** | 1.76 MiB |
| async.queue | 3,384 | 3,236 | 216 | 296 | 3.89 MiB |
| p-queue | 1,774 | 1,695 | 116 | 103 | 6.19 MiB |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code style, and PR expectations. For usage questions, prefer [GitHub Discussions](https://github.com/eugene-p/qkitt-queue/discussions).

## License

[ISC](./LICENSE)
