<p align="center" style="margin-bottom:0px;">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="qkitt-queue" width="150" height="150">
  </picture>
</p>

<h1 align="center" style="padding-bottom:2rem; margin-top:0px">Fast in-process queues for TypeScript</h1>

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
| [`@qkitt/queue`](./packages/queue) | Queue, worker, persist, router, retry, pipeline |
| [`@qkitt/queue-config`](./packages/queue-config) | Optional: build a system from a config object |
| [`@qkitt/queue-bench`](./packages/bench) | Benchmarks against in-process peers (monorepo only) |

Most apps only need `@qkitt/queue` — compose layers in code and reach for `@qkitt/queue-config` when you want a declarative setup instead.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

## Install

```bash
npm install @qkitt/queue
```

Optional config helper:

```bash
npm install @qkitt/queue @qkitt/queue-config
```

## Quick start

Compose layers from the inside out:

```ts
import {
  buildQueue,
  withWorker,
  withSnapshotPersist,
  createMemorySnapshotStore,
} from '@qkitt/queue'

type Job = { id: string }

// bare → persist → worker
const queue = withWorker(
  withSnapshotPersist(buildQueue<Job>(), createMemorySnapshotStore()),
  async (job) => {
    // handle job
  },
  { concurrency: 2 },
)

await queue.hydrate()
queue.enqueue({ id: '1' })
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

Failed items are **not** re-queued. Use `retryWorker` for in-call retries, or handle `worker:failed` and re-enqueue yourself if you need a dead-letter path.

**Persist lifecycle** (when using `withSnapshotPersist` / `withRowPersist`):

1. Build stack: bare → persist → worker (**persist inside, worker outside**).
2. `await queue.hydrate()` before enqueue.
3. Mutate as usual — `enqueue` / `dequeue` stay sync.
4. `await queue.flush()` before process exit to promote pending writes.

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
| [`worker-drain`](./examples/worker-drain/main.ts) | Concurrent backlog drain |
| [`retry-pipeline`](./examples/retry-pipeline/main.ts) | Multi-step job + flaky retry |
| [`persist-restart`](./examples/persist-restart/main.ts) | Crash, hydrate, finish work |
| [`router-topics`](./examples/router-topics/main.ts) | Topic publish → queues |
| [`with-config`](./examples/with-config/main.ts) | Same idea via config |

```bash
npm run build
npx tsx examples/worker-drain/main.ts
# or all: npm run examples
```

## Docs

| Link | Covers |
| --- | --- |
| [`packages/queue`](./packages/queue/README.md) | Composition guide, [Recipes](./packages/queue/README.md#recipes), [API reference](./packages/queue/README.md#api-reference), benchmarks |
| [`packages/queue-config`](./packages/queue-config/README.md) | Config schema, [API reference](./packages/queue-config/README.md#api-reference) |
| [`packages/bench`](./packages/bench/README.md) | Benchmark harness — how to re-run |
| [`examples/`](./examples) | Runnable use cases |

## Develop

Requires Node.js >= 18. CI runs on Node 20, 22, 24, and 26.

```bash
npm install
npm test
npm run build
npm run bench
```

## Benchmarks

Details and setup: [`packages/bench`](./packages/bench) · re-run: `npm run bench` · shorter summary in the [queue README](./packages/queue/README.md#benchmark-summary)

> AMD Ryzen 7 4800HS (8c/16t) · 16 GB · Windows 11 · Node 22.19.0 · `tinybench` via `tsx --expose-gc` · 2026-07-19 · YMMV

### Bare queue — 50k enqueue + dequeue

| Library | ops/s (med) | heap Δ |
| --- | ---: | ---: |
| **@qkitt/queue** `buildQueue` | 1,467 | 1.19 MiB |
| denque | 1,849 | 1.36 MiB |
| yocto-queue | 2,361 | 1.92 MiB |
| native `Array` push/shift | 7 | 1.18 MiB |

### Worker drain — N async no-op jobs, concurrency C

| Library | 1k c=1 | 1k c=4 | 10k c=1 | 10k c=4 | heap Δ (10k c=1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **6,246** | **6,532** | **622** | **635** | **243 KiB** |
| fastq | 4,144 | 3,883 | 109 | 106 | 6.82 MiB |
| async.queue | 2,512 | 2,939 | 185 | 213 | 5.00 MiB |
| p-queue | 1,251 | 1,214 | 82 | 78 | 10.84 MiB |

Median ops/s, higher is better. Heap Δ = retained memory measured with all items still held (worker paused).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code style, and PR expectations. For usage questions, prefer [GitHub Discussions](https://github.com/eugene-p/qkitt-queue/discussions).

## License

[ISC](./LICENSE)
