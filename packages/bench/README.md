# @qkitt/queue-bench

Local benchmarks and retained-memory regression for [`@qkitt/queue`](../queue).

Not published. Measures in-process throughput and retained heap under fixed inputs.
It does not cover message brokers or end-to-end application latency.

## Package boundary

`@qkitt/queue` is **persistence-first and memory-conscious**: durable row stores,
correct lifecycle (hydrate / flush / leases), and predictable retained heap under
backlog matter as much as raw drain speed.

Simpler in-process workers (for example a memory-only drain loop with no store)
optimize for scheduler throughput. Use them when you only need concurrency and
have no durability or restart story. Do not treat bare peer drain numbers as the
product scoreboard for this library.

### Priority (highest first)

1. **Persistence and correctness** — durable lifecycle, idle/flush, restart shape
2. **Retained memory** — total heap and heap per pending job under a full backlog
3. **Throughput** — median ops/s for representative full-cycle work

## Suites

| Suite | What it protects | Default? |
| --- | --- | --- |
| **payload** | Representative worker drain with job-shaped 1 KiB payloads; peer context (fastq, p-queue, async.queue) for severe regression evidence; retained heap total + per job | Yes (`all`) |
| **durable** | Internal regression for persistence lifecycle (enqueue+flush, hydrate+drain+flush) on `MemoryRowStore`; retained heap for held pending rows | Yes (`all`) |
| **workloads** | Internal regression: burst drain and yielding steady producer with real payload bytes; retained heap for burst pending N | Yes (`all`) |
| **worker** | Optional diagnostic: async no-op scheduler matrix vs peers (jobs × concurrency). Not a product scoreboard | No — `bench:worker` only |

Peers (when present) supply **workload context and regression evidence**, not a
competitive ranking to optimize against.

## Run

From the monorepo root (after `npm install`):

```bash
# Default product suite: payload + durable + workloads
npm run bench

# Optional scheduler diagnostic only
npm run bench:worker

# Individual suites
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

CLI suites: `all` (default) | `payload` | `durable` | `workloads` | `worker`.

## What is measured

| Metric | Question it answers |
| --- | --- |
| **ops/s med** | Median full-cycle throughput (tinybench p50; mean fallback if p50 is missing). One op is a complete scenario (e.g. enqueue N and drain N). |
| **heap Δ total** | Median retained process memory from seven post-GC samples with N items still held (`heapUsed` + `arrayBuffers`; not peak mid-drain). |
| **heap Δ / job** | Total retained heap ÷ N pending jobs (bytes rounded, printed as KiB/MiB). |

Timing empties or drains each iteration. Heap samples **keep** N held (worker
paused / `autoStart: false`, or durable rows flushed but not drained).

### Fixed inputs (release compares)

| Suite | N | Payload | Other |
| --- | --- | --- | --- |
| payload | 5_000 | 1_024 B job body | concurrency 4 |
| durable | 5_000 | numeric rows | `MemoryRowStore` |
| workloads | 5_000 | 1_024 B `Uint8Array` | concurrency 4; burst + steady |
| worker (optional) | 1_000 / 10_000 | number jobs | concurrency 1 / 4 |

## Release baseline (0.13.3)

Captured 2026-07-31 · Node v26.5.0 · win32 x64 · AMD Ryzen 7 4800HS class ·
16 GB · Windows 11 · `tsx --expose-gc`. Median ops/s (tinybench p50) and
median of seven post-GC retained samples (`heapUsed` + `arrayBuffers`).
Also summarized in the [root README](../../README.md#benchmarks).

### Payload — 5k × 1 KiB jobs, c=4

| Library | ops/s med | heap Δ total | heap Δ / job |
| --- | ---: | ---: | ---: |
| @qkitt/queue `withWorker` | 78 | 5.58 MiB | 1.1 KiB |
| fastq | 106 | 6.40 MiB | 1.3 KiB |
| async.queue | 94 | 7.47 MiB | 1.5 KiB |
| p-queue | 72 | 8.82 MiB | 1.8 KiB |

### Durable — 5k rows, `MemoryRowStore`

| Operation | ops/s med | heap Δ (pending, not drained) |
| --- | ---: | ---: |
| enqueue + flush | 80 | 571.3 KiB total · 117 B/job |
| hydrate + worker drain + flush | 97 | — |

### Workloads — 5k × 1 KiB, c=4

| Scenario | ops/s med | heap Δ (burst pending) |
| --- | ---: | ---: |
| burst drain | 263 | 5.90 MiB total · 1.2 KiB/job |
| steady producer | 224 | — |

### How to re-capture

1. `npm run build:queue` then `npm run bench` (optionally `npm run bench:worker`).
2. Record Node version, platform, and the printed medians (ops/s, heap Δ total,
   heap Δ / job). Prefer the suite’s seven-sample median; do not hand-pick
   single samples.
3. Compare on the **same Node major/minor** and similar machine class. Look for
   sustained retained-heap increases first, then large ops/s drops. Peers are
   context only — not ranking targets.

## Fairness

- Same job bodies and counts across peers in a suite; payloads preallocated for timing.
- Per-library `tinybench` warmup and one drain wait.
- Heap samples allocate a fresh held backlog so totals include payloads + bookkeeping.
- Results are machine-dependent; compare relatively on the same runtime.

## Policy

### Material retained-memory regressions

Initially: re-run the same suite on the same Node major/minor and machine class
after a change. Investigate any **sustained** increase in total retained heap or
heap per pending job (not a one-off noisy sample).

Numeric CI hard-fail tolerances should be set only after enough baseline runs
document observed variance. Until then, treat memory as a **release review**
signal, not an automated gate.

### Ranking-driven micro-optimizations

Do not add complexity only to move peer ranking numbers. Prefer fixes that
protect correctness, retained memory under backlog, or clear full-cycle
regressions in the default suites.

## Layout

```
src/
  index.ts           # CLI: all | payload | durable | workloads | worker
  payload-worker.ts  # Payload + validation peer drain + heap
  durable.ts         # Durable row lifecycle + pending heap
  workloads.ts       # Burst / steady producer + burst pending heap
  worker.ts          # Optional async no-op scheduler matrix
  memory.ts          # Retained-heap helpers
  helpers.ts         # Constants, timeAlone
  report.ts          # Progress, tables, heap columns
```
