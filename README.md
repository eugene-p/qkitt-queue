# qkitt-queue

Fast, composable in-process queues for TypeScript — zero runtime dependencies.

| Package | What it is |
| --- | --- |
| [`@qkitt/queue`](./packages/queue) | Queue, worker, persist, router, retry, pipeline |
| [`@qkitt/queue-config`](./packages/queue-config) | Optional: build a system from a config object |
| [`@qkitt/queue-bench`](./packages/bench) | Private (not published): benchmarks vs in-process peers |

Most apps only need `@qkitt/queue`. Compose in code. Use `@qkitt/queue-config` when you want a declarative setup.

**Why this exists**

- **Speed** — higher worker-drain throughput and lower retained memory vs in-process peers under backlog (see [Benchmarks](#benchmarks))
- **Composability** — bare queue → worker → persist; add layers as needed
- **Zero runtime dependencies** — typed, ESM, Node 18+
- **Worker helpers** — `retryWorker` and `pipelineWorker` return functions you pass to `withWorker`
- **Optional config** — same stacks from a JS/JSON object via `@qkitt/queue-config`

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

## Docs

- [`packages/queue/README.md`](./packages/queue/README.md) — composition guide, API reference, benchmark summary (also on npm)
- [`packages/queue-config/README.md`](./packages/queue-config/README.md) — config schema and API
- [`packages/bench/README.md`](./packages/bench/README.md) — how to re-run benchmarks

## Develop

```bash
npm install
npm test
npm run build
npm run bench
```

## Benchmarks

Compare `@qkitt/queue` against in-process peers. Private harness: [`packages/bench`](./packages/bench). A shorter summary ships on the package README for npm: [packages/queue § Benchmarks](./packages/queue/README.md#benchmarks-summary).

```bash
npm run bench
npm run bench:fifo
npm run bench:worker
```

### Environment

| | |
| --- | --- |
| **Date** | 2026-07-18 |
| **Machine** | ASUS ROG Zephyrus G14 (GA401IU) |
| **CPU** | AMD Ryzen 7 4800HS (8 cores / 16 threads) |
| **RAM** | 16 GB |
| **OS** | Windows 11 Pro 24H2 (build 26200), x64 |
| **Runtime** | Node.js v22.19.0, npm 10.8.2 |
| **Harness** | `tinybench` via `tsx --expose-gc` (`@qkitt/queue-bench`) |

Relative numbers only — re-run on your machine before drawing absolute conclusions.

### Method (short)

- **Bare queue**: enqueue then dequeue **50 000** items (structure only). Memory = retained `heapUsed` with all items still held.
- **Worker**: drain **N** async no-op jobs at concurrency **C**. Completion = **N jobs finished** (job counter / `Promise.all` / task callbacks — not `worker:idle`). Memory = retained heap with N jobs **pending** (pump paused / `autoStart: false`).
- Throughput below is **median ops/s** (higher is better). Full suite details: [packages/bench/README.md](./packages/bench/README.md).

### Why different peer libraries per suite?

`@qkitt/queue` is two layers: a bare queue (`buildQueue`) and an optional concurrent drain (`withWorker`). Each suite compares libraries that do **the same job**:

| Suite | What is measured | Peers | Why these |
| --- | --- | --- | --- |
| Bare queue | enqueue / dequeue only | `denque`, `yocto-queue`, native `Array` | Pure in-process queues — no worker, no task scheduling |
| Worker drain | enqueue + concurrent async jobs | `fastq`, `p-queue`, `async.queue` | In-process job runners with concurrency — closest to `withWorker` |

The sets differ on purpose. Bare-queue peers have no concurrent worker API. Worker peers always carry task / promise machinery, so stuffing them into a bare push/shift microbench would measure that overhead, not the queue structure. Redis-backed systems (BullMQ, …) are out of scope — different cost model.

### Bare queue (50 000 enqueue + dequeue)

| Library | Throughput (ops/s, med) | Retained heap Δ |
| --- | ---: | ---: |
| **@qkitt/queue** `buildQueue` | 1 414 | 1.19 MiB |
| denque | 1 729 | 1.45 MiB |
| yocto-queue | 2 237 | 1.92 MiB |
| native `Array` push/shift | 7 | 1.18 MiB |

`buildQueue` is comparable to dedicated queue structures and much faster than naive `Array#shift`. Events cost nothing when nobody is subscribed.

### Worker drain

**1 000 jobs**

| Library | c=1 ops/s | c=1 heap Δ | c=4 ops/s | c=4 heap Δ |
| --- | ---: | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **6 812** | **39 KiB** | **5 724** | **34 KiB** |
| fastq | 3 834 | 704 KiB | 3 724 | 700 KiB |
| async.queue | 2 523 | 523 KiB | 2 991 | 533 KiB |
| p-queue | 1 223 | 1.15 MiB | 1 198 | 1.14 MiB |

**10 000 jobs**

| Library | c=1 ops/s | c=1 heap Δ | c=4 ops/s | c=4 heap Δ |
| --- | ---: | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **601** | **238 KiB** | **624** | **238 KiB** |
| fastq | 110 | 6.80 MiB | 101 | 6.81 MiB |
| async.queue | 173 | 4.95 MiB | 219 | 4.92 MiB |
| p-queue | 79 | 10.88 MiB | 75 | 10.44 MiB |

On the worker path, `@qkitt/queue` has higher throughput and lower retained memory in this suite. Pending work is the job payload in the queue; the pump dequeues and runs your function up to `concurrency`. Peers that allocate per-task promises or queue nodes use more memory under a large backlog.

## License

[ISC](./LICENSE)
