<img src="https://raw.githubusercontent.com/eugene-p/qkitt-queue/main/assets/logo.svg" alt="qkitt-queue" width="96" height="96">

# @qkitt/queue — durable in-process job queues for TypeScript

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue.svg)](https://www.npmjs.com/package/@qkitt/queue)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Reliable background jobs in one Node process or browser: concurrent workers, retries, topic routing, and optional persistence. Zero runtime dependencies.

Layers you can stack: bare queue (FIFO), concurrent worker, optional persistence, topic routing, and failure routing (durable retry / loop / dead letter). Worker helpers (`retryWorker`, `pipelineWorker`) return functions you pass to `withWorker`. ESM only. Runs in Node.js 20+ and modern browsers. Requires TypeScript **5.0+** with `moduleResolution` `node16`, `nodenext`, or `bundler`.

**Out of scope:** work that spans machines or processes.

> Need only a fast, memory-only queue? Use the sibling project [`@qkitt/tinyq`](https://github.com/eugene-p/tinyq). Choose this package when unfinished jobs must survive restart or you need declarative multi-queue configuration.

## What it is for

Use `@qkitt/queue` to move slow or retryable work out of the immediate path of an application: process webhooks, send notifications, generate files, or run a small workflow with a concurrency limit. Start with an in-memory FIFO and add only the layer that earns its place:

1. `buildQueue()` holds work in FIFO order.
2. `withWorker()` consumes it with a concurrency limit.
3. A `store` makes unfinished work recoverable after restart.
4. Helpers and decorators add retry, failure handling, or routing.

This is deliberately not a distributed queue. If producers and consumers need to run on different machines or survive independent deploys, use a broker or job system designed for that boundary.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

Guides live on GitHub (not in the npm tarball). Suggested path: [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) → [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) → [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) → [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md). Jump by task via [Recipes](#recipes).

| Guide | Covers |
| --- | --- |
| [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) | Bare / durable queue → worker → helpers → config |
| [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) | `buildQueue({ store })`, row stores, custom backends |
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

For most apps, this is the whole starting point: it accepts jobs now and handles up to two at a time. `enqueue` resolves after the queue accepts the job; the worker runs in the background.

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

Need a different outcome? Persist jobs across restart with [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md); retry a flaky call with [worker helpers](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#4-worker-helpers); or decide where permanent failures go with [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md).

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

Failed items are **not** re-queued by default. Use `retryWorker` for in-call retries, or durable [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) (`withRetry`, `withLoop`, `withDlq`).

When stacks grow (many queues, router, stores), prefer [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config).

## Recipes

| Task | Jump to |
| --- | --- |
| Concurrent jobs | [Composition §2](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#2-add-a-worker) |
| Drain / graceful stop | [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) |
| Retries / multi-step | [Composition §4](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#4-worker-helpers) |
| Survive restart | [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) · [Composition §3](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#3-add-persistence) |
| Browser Web Storage | [Browser storage](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#browser-storage) |
| Custom store (file, etc.) | [Custom stores](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#custom-stores) |
| Topic fan-out | [Topics & routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/routing.md) |
| Same-queue re-entry / loop delay | [Loop](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#loop-withloop) |
| Dead-letter sink | [Dead letter](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#dead-letter-withdeadletter--withdlq) |
| Hop, then dead-letter | [Chaining loop + DLQ](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#chaining-withloop--withdlq) |
| Declarative multi-queue | [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config) |

Runnable scenarios: [examples/](https://github.com/eugene-p/qkitt-queue/tree/main/examples) in the monorepo.

## Benchmark summary

In-process peers only. Full tables and setup: [root README](https://github.com/eugene-p/qkitt-queue/blob/main/README.md#benchmarks). Re-run: [`packages/bench`](https://github.com/eugene-p/qkitt-queue/tree/main/packages/bench) (`npm run bench` from repo root).

**Strength is retained backlog memory and a durable queue model.** In a raw asynchronous no-op drain, fastq is faster; `withWorker` keeps far less heap while jobs wait. Bare `buildQueue` also trails dedicated FIFO structures in pure enqueue/dequeue throughput. Choose it for persistence and explicit composition, not a claim to be the fastest memory-only runner.

**Worker drain** — 10 000 no-op jobs (ops/s · pending-job heap)

| Library | c=1 | c=4 | heap Δ (c=1) |
| --- | ---: | ---: | ---: |
| @qkitt/queue `withWorker` | 495 | 524 | **82.5 KiB** |
| fastq | **937** | **926** | 1.76 MiB |
| async.queue | 235 | 297 | 3.89 MiB |
| p-queue | 121 | 117 | 6.19 MiB |

**Bare queue** — 50 000 enqueue + dequeue (ops/s median · retained heap)

| Library | ops/s | heap Δ |
| --- | ---: | ---: |
| @qkitt/queue `buildQueue` | 761 | 410.5 KiB |
| denque | 2,273 | 515.0 KiB |
| yocto-queue | 2,377 | 1.91 MiB |
| native `Array` push/shift | 8 | 397.5 KiB |

**Browser (Chromium)** — in-memory vs durable worker drain, 5k jobs c=1: bare ~2 ms · localStorage ~410 ms (`npm run compare:stores`).

Retained heap is the median of seven post-GC samples. Relative numbers (Node 26.5.0, Windows laptop, 2026-07-30). YMMV.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration guidance.

## License

[ISC](./LICENSE)
