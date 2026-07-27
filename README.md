<p align="center" style="margin-bottom:0px;">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="qkitt-queue" width="150" height="150">
  </picture>
</p>

<h1 align="center" style="padding-bottom:2rem; margin-top:0px">Composable in-process queues for TypeScript</h1>

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm @qkitt/queue](https://img.shields.io/npm/v/@qkitt/queue.svg?label=%40qkitt%2Fqueue)](https://www.npmjs.com/package/@qkitt/queue)
[![npm @qkitt/queue-config](https://img.shields.io/npm/v/@qkitt/queue-config.svg?label=%40qkitt%2Fqueue-config)](https://www.npmjs.com/package/@qkitt/queue-config)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

> **ESM-only.** This package ships ES modules exclusively. If you're in a CJS context, use a dynamic import:
> ```ts
> const { buildQueue, withWorker } = await import('@qkitt/queue')
> ```

| Package | What it is |
| --- | --- |
| [`@qkitt/queue`](./packages/queue) | Queue, worker, persist, router, retry, pipeline, loop / DLQ |
| [`@qkitt/queue-config`](./packages/queue-config) | Optional: build a system from a config object |
| [`@qkitt/queue-bench`](./packages/bench) | Benchmarks against in-process peers |

Most apps only need `@qkitt/queue` — compose layers in code and reach for `@qkitt/queue-config` when you want a declarative setup instead.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

## When to use this

In-process queue toolkit. Start bare, add a layer as requirements change:

- **FIFO backlog** — hold work in order until something drains it (orders awaiting fulfillment, moderation queue, form submissions waiting for review).
- **Concurrent workers** — drain that backlog with a concurrency cap (inbound webhooks, notification sends, thumbnail generation).
- **Retries** — survive flaky third-party calls (payment capture, carrier API, email or SMS gateway).
- **Pipelines** — fixed stages per item (validate → reserve stock → charge → confirm).
- **Persistence** — keep unfinished work across a restart (long exports, outbox, unsent messages after a crash). Pass a `RowStore` to `buildQueue({ store })`. Built-in Web Storage; custom stores implement `RowStore`.
- **Topic routing** — one publish, several consumers (`order.placed` → fulfillment, billing, analytics).
- **Failure routing** — re-enter the same queue with hop meta (`withLoop`) or forward failed items to a dead-letter sink (`withDeadLetter` / `withDlq`).
- **Declarative config** — stand up a multi-queue system from one object (`@qkitt/queue-config`).

**Out of scope:** work that spans machines or processes.

## Install

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

## Benchmarks

Details and setup: [`packages/bench`](./packages/bench) · re-run: `npm run bench` · summary also in the [queue package README](./packages/queue/README.md#benchmark-summary).

> AMD Ryzen 7 4800HS (8c/16t) · 16 GB · Windows 11 · Node 26.5.0 · `tinybench` via `tsx --expose-gc` · 2026-07-26 · YMMV

**Worker drain is the strength** — high ops/s and very low retained memory under a backlog. Bare FIFO is competitive on heap and far faster than `Array#shift`; pure enqueue/dequeue ops trail dedicated structures like denque / yocto-queue.

### Worker drain — N async no-op jobs, concurrency C

| Library | 1k c=1 | 1k c=4 | 10k c=1 | 10k c=4 | heap Δ (10k c=1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **4,367** | **4,715** | **439** | **490** | **95 KiB** |
| fastq | 3,962 | 4,310 | 316 | 280 | 6.12 MiB |
| async.queue | 3,855 | 4,189 | 347 | 374 | 3.95 MiB |
| p-queue | 1,342 | 1,413 | 104 | 95 | 6.19 MiB |

### Bare queue — 50k enqueue + dequeue

| Library | ops/s (med) | heap Δ |
| --- | ---: | ---: |
| **@qkitt/queue** `buildQueue` | 783 | 413 KiB |
| denque | 2,349 | 518 KiB |
| yocto-queue | 2,409 | 1.92 MiB |
| native `Array` push/shift | 8 | 399 KiB |

Median ops/s, higher is better. Heap Δ = retained memory measured with all items still held (worker paused).

### Browser — in-process vs durable (Chromium)

Illustrative wall times only (`npm run compare:stores`). Not a peer bench.

| Mode (5k jobs, c=1) | Drain |
| --- | ---: |
| Bare `buildQueue()` (in-process) | ~2 ms |
| `localStorage` rows | ~410 ms |

Store put N=5k: localStorage ~245 ms. Full matrix: [persistence — browser](./packages/queue/docs/persistence.md#browser-integration-checks).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code style, and PR expectations. For usage questions, prefer [GitHub Discussions](https://github.com/eugene-p/qkitt-queue/discussions).

## License

[ISC](./LICENSE)
