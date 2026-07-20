# qkitt-queue

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm @qkitt/queue](https://img.shields.io/npm/v/@qkitt/queue.svg?label=%40qkitt%2Fqueue)](https://www.npmjs.com/package/@qkitt/queue)
[![npm @qkitt/queue-config](https://img.shields.io/npm/v/@qkitt/queue-config.svg?label=%40qkitt%2Fqueue-config)](https://www.npmjs.com/package/@qkitt/queue-config)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Fast, composable in-process queues for TypeScript — zero runtime dependencies.

| Package | What it is |
| --- | --- |
| [`@qkitt/queue`](./packages/queue) | Queue, worker, persist, router, retry, pipeline |
| [`@qkitt/queue-config`](./packages/queue-config) | Optional: build a system from a config object |
| [`@qkitt/queue-bench`](./packages/bench) | Benchmarks against in-process peers (monorepo only) |

Most apps only need `@qkitt/queue` — compose layers in code and reach for `@qkitt/queue-config` when you want a declarative setup instead.

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
| [`packages/queue`](./packages/queue/README.md) | Composition guide, [API reference](./packages/queue/README.md#api-reference), benchmark summary |
| [`packages/queue-config`](./packages/queue-config/README.md) | Config schema, [API reference](./packages/queue-config/README.md#api-reference) |
| [`packages/bench`](./packages/bench/README.md) | Benchmark harness — how to re-run |
| [`examples/`](./examples) | Runnable use cases |

## Develop

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
| **@qkitt/queue** `buildQueue` | 1,016 | 1.19 MiB |
| denque | 1,307 | 1.43 MiB |
| yocto-queue | 1,657 | 1.92 MiB |
| native `Array` push/shift | 6 | 1.18 MiB |

### Worker drain — N async no-op jobs, concurrency C

| Library | 1k c=1 | 1k c=4 | 10k c=1 | 10k c=4 | heap Δ (10k c=1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **4,558** | **4,627** | **457** | **451** | **239 KiB** |
| fastq | 3,004 | 2,714 | 90 | 86 | 6.81 MiB |
| async.queue | 1,647 | 2,204 | 133 | 180 | 4.96 MiB |
| p-queue | 760 | 620 | 57 | 57 | 11.04 MiB |

Median ops/s, higher is better. Heap Δ = retained memory measured with all items still held (worker paused).

## License

[ISC](./LICENSE)
