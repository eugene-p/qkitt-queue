# @qkitt/queue-bench

Benchmarks for [`@qkitt/queue`](../queue).

Measures in-process throughput and retained heap. It does not cover brokers or end-to-end application latency. Summary numbers live in the [root README](../../README.md#benchmarks) and [queue README](../queue/README.md#benchmark-summary).

## Peers

Each suite compares the matching queue layer with similar libraries.

| Suite | Libraries | Role of peers |
| --- | --- | --- |
| Bare queue | `@qkitt/queue` (`buildQueue`), [denque](https://github.com/invertase/denque), [yocto-queue](https://github.com/sindresorhus/yocto-queue) | Pure enqueue/dequeue structures — no worker API |
| Scheduler drain | `@qkitt/queue` (`withWorker`), [fastq](https://github.com/mcollina/fastq), [p-queue](https://github.com/sindresorhus/p-queue), [async.queue](https://caolan.github.io/async/v3/docs.html#queue) | Raw async-no-op scheduling overhead |
| Payload worker drain | Same worker peers | 1 KiB job objects plus a full-body validation pass and async yield |
| Durable lifecycle | `@qkitt/queue` + `MemoryRowStore` | Internal regression: write/flush and hydrate/drain/flush without device I/O |
| Workload shapes | `@qkitt/queue` | Internal regression: 1 KiB payloads under burst drain and a yielding producer |

## Run

From the monorepo root (after `npm install`):

```bash
npm run bench
npm run bench:fifo
npm run bench:worker
npm run bench:payload
npm run bench:durable
npm run bench:workloads
```

Or from this package:

```bash
npm run bench -w @qkitt/queue-bench
```

Build `@qkitt/queue` first if dist is missing:

```bash
npm run build:queue
npm run bench
```

## What is measured

Each library (or worker cell) runs alone.

| Metric | Question it answers |
| --- | --- |
| **ops/s med** | Median full-cycle throughput. FIFO: enqueue N + dequeue N; worker: enqueue N and drain N. |
| **heap Δ (held N)** | Median retained heap from seven post-GC samples with N items held. |

Timing uses tinybench p50 (median; mean fallback only if p50 is unavailable). Heap Δ uses seven post-GC samples. The FIFO table compares `buildQueue`'s Promise API with synchronous peer FIFOs; payload, workload, and durable suites are qkitt-only regression checks.

## How a suite runs

Each library runs in isolation. FIFO and payload print one table; scheduler prints one table per jobs/concurrency cell.

## Fairness

- Same job bodies and counts across peers; payloads are preallocated.
- Per-library `tinybench` warmup and one drain wait.
- Worker matrix: 1k / 10k jobs × concurrency 1 / 4.
- Results are machine-dependent; compare them relatively.

## Layout

```
src/
  index.ts       # CLI entry (all | fifo | worker | payload | durable | workloads)
  fifo.ts        # Bare enqueue/dequeue — isolated per library
  worker.ts      # Async no-op scheduler matrix — isolated per cell
  payload-worker.ts # Payload + validation peer drain
  durable.ts     # Durable row lifecycle — internal regression suite
  workloads.ts   # Payload and steady-producer regression scenarios
  memory.ts      # Retained-heap helpers + metric docs
  helpers.ts     # Constants, timeAlone
  report.ts      # Progress + aggregated tables
```
