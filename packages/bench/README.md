# @qkitt/queue-bench

Benchmarks for [`@qkitt/queue`](../queue).

Compares in-process bare-queue and worker-drain performance against similar libraries. Runs locally and in CI from the monorepo root. Published summary numbers live in the [root README](../../README.md#benchmarks) and the [queue package README](../queue/README.md#benchmark-summary) — re-run from here after changing the core.

This is a maintainer harness, not a reason to choose a queue in isolation. It answers two narrow questions: how quickly an in-process queue completes a representative cycle, and how much memory it retains while work is waiting. It does not measure networked brokers, durability guarantees, or end-to-end application latency.

## Peers

`@qkitt/queue` is two layers: a bare queue (`buildQueue`) and an optional concurrent drain (`withWorker`). Each suite picks peers that actually do the same job as the layer being tested.

| Suite | Libraries | Role of peers |
| --- | --- | --- |
| Bare queue | `@qkitt/queue` (`buildQueue`), [denque](https://github.com/invertase/denque), [yocto-queue](https://github.com/sindresorhus/yocto-queue), native `Array` | Pure enqueue/dequeue structures — no worker API |
| Worker drain | `@qkitt/queue` (`withWorker`), [fastq](https://github.com/mcollina/fastq), [p-queue](https://github.com/sindresorhus/p-queue), [async.queue](https://caolan.github.io/async/v3/docs.html#queue) | In-process concurrent job runners |
| Durable lifecycle | `@qkitt/queue` + `MemoryRowStore` | Internal regression: write/flush and hydrate/drain/flush without device I/O |
| Workload shapes | `@qkitt/queue` | Internal regression: 1 KiB payloads under burst drain and a yielding producer |

## Run

From the monorepo root (after `npm install`):

```bash
npm run bench
npm run bench:fifo
npm run bench:worker
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

Each library (or worker cell) is measured **alone**. The table shows two numbers that answer different questions:

| Metric | Question it answers |
| --- | --- |
| **ops/s med** | How fast can it finish a full cycle? FIFO: enqueue N + dequeue N. Worker: enqueue N jobs and drain until N finished. |
| **heap Δ (held N)** | Median retained heap across seven post-GC samples while it **still holds N** items. FIFO: full queue after N enqueues. Worker: N pending jobs with the worker **paused** (`autoStart: false` / `pause()`). |

The durable suite reports timing only. Its `MemoryRowStore` deliberately removes browser, filesystem, or database latency so it can catch queue bookkeeping regressions; it is not a durability-performance claim for a real backend.

The workload suite reports qkitt-only scenarios. It uses preallocated 1 KiB payloads so scheduling work, rather than payload allocation, is timed. It covers a full burst and a yielding producer; it is a regression check, not a peer claim.

Why two measurements: the ops/s loop **empties or drains** each iteration, so it cannot answer “size while holding N.” heap Δ is a short post-GC fill that keeps N live — not peak during the throughput loop, and not GC churn while draining.

## How a suite runs

1. Print legend (ops/s vs heap Δ for this suite).
2. For each library (worker: each N × concurrency cell), alone:
   - progress: timing… → ops/s sample
   - progress: memory (held N…) → heap Δ sample
3. Print results:
   - FIFO: one table
   - Worker: **four tables** (one per N × concurrency setup); jobs/c are the section title, not columns

One-at-a-time runs keep long tinybench windows from interleaving and make progress obvious while timing is the slow part.

## Fairness

- Same asynchronous no-op job body and job counts across libraries
- Warmup via `tinybench` (per-library Bench instance)
- Every worker runner waits once for its queue to drain (`whenIdle`, `drain`, or `onIdle`); no optional per-job completion promises or callbacks are included for fastq / async.queue
- Worker matrix (**4 cells**): jobs **1k / 10k** × concurrency **1 / 4**
- Memory: median of seven post-GC samples. Scripts use `--expose-gc`; values remain machine-specific rather than exact allocation accounting.
- Results vary by machine/Node version; treat as relative, not absolute claims

## Layout

```
src/
  index.ts       # CLI entry (all | fifo | worker | durable | workloads)
  fifo.ts        # Bare enqueue/dequeue — isolated per library
  worker.ts      # Drain matrix — isolated per cell
  durable.ts     # Durable row lifecycle — internal regression suite
  workloads.ts   # Payload and steady-producer regression scenarios
  memory.ts      # Retained-heap helpers + metric docs
  helpers.ts     # Constants, timeAlone
  report.ts      # Progress + aggregated tables
```
