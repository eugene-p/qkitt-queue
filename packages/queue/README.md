<img src="https://raw.githubusercontent.com/eugene-p/qkitt-queue/main/assets/logo.svg" alt="qkitt-queue" width="150" height="150">

# @qkitt/queue

[![CI](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/eugene-p/qkitt-queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qkitt/queue.svg)](https://www.npmjs.com/package/@qkitt/queue)
[![License: ISC](https://img.shields.io/npm/l/@qkitt/queue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@qkitt/queue.svg)](https://nodejs.org)

Composable **in-process** queues for TypeScript — zero runtime dependencies.

Layers you can stack: bare queue (FIFO), concurrent worker, optional persistence, topic routing, failure routing (loop / dead letter). Worker helpers (`retryWorker`, `pipelineWorker`) return functions you pass to `withWorker`. ESM only. Runs in Node.js 20+ and modern browsers. Requires TypeScript **5.0+** with `moduleResolution` `node16`, `nodenext`, or `bundler`.

**Out of scope:** work that spans machines or processes.

**Versioning:** pre-1.0 — SemVer; on `0.x`, breaking changes ship in minor bumps (`0.5` → `0.6`). Check the changelog on minor upgrades.

Guides live on GitHub (not in the npm tarball). Suggested path: [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) → [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) → [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) → [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md). Jump by task via [Recipes](#recipes).

| Guide | Covers |
| --- | --- |
| [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) | Bare queue → worker → persist → helpers → config |
| [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) | Snapshot / row, stores, custom backends |
| [Topics & routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/routing.md) | MQTT-style patterns, unmatched sink |
| [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) | `withLoop`, `withDlq`, chaining |
| [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) | `whenIdle`, `gracefulStop` |
| [API reference](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/api.md) | Public signatures, events, package layout |

## Install

```bash
npm install @qkitt/queue
```

```ts
import {
  buildQueue,
  withWorker,
  withPersist,
  pipelineWorker,
  retryWorker,
  buildRouter,
  createMemorySnapshotStore,
  createMemoryRowStore,
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

queue.enqueue({ id: '1' })
```

Add persistence (stack: **bare → persist → worker**):

```ts
import {
  buildQueue,
  withWorker,
  withPersist,
  createMemorySnapshotStore,
} from '@qkitt/queue'

const queue = withWorker(
  withPersist(buildQueue<Job>(), createMemorySnapshotStore()),
  async (job) => {
    // handle job
  },
  { concurrency: 2 },
)

await queue.hydrate()
queue.enqueue({ id: '1' })
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

Failed items are **not** re-queued. Use `retryWorker` for in-call retries, or [failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md) (`withLoop` / `withDlq`).

When stacks grow (many queues, router, stores), prefer [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config).

## Recipes

| Task | Jump to |
| --- | --- |
| Concurrent jobs | [Composition §2](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#2-add-a-worker) |
| Drain / graceful stop | [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) |
| Retries / multi-step | [Composition §4](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#4-worker-helpers) |
| Survive restart (snapshot) | [Persistence](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md) · [Composition §3](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md#3-add-persistence) |
| DB-style row persist | [Row](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#row) |
| Custom store (file, etc.) | [Custom stores](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/persistence.md#custom-stores) |
| Topic fan-out | [Topics & routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/routing.md) |
| Same-queue re-entry / loop delay | [Loop](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#loop-withloop) |
| Dead-letter sink | [Dead letter](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#dead-letter-withdeadletter--withdlq) |
| Hop, then dead-letter | [Chaining loop + DLQ](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md#chaining-withloop--withdlq) |
| Declarative multi-queue | [`@qkitt/queue-config`](https://www.npmjs.com/package/@qkitt/queue-config) |

Runnable scenarios: [examples/](https://github.com/eugene-p/qkitt-queue/tree/main/examples) in the monorepo.

## Benchmark summary

In-process peers only. Full tables and setup: [root README](https://github.com/eugene-p/qkitt-queue/blob/main/README.md#benchmarks). Re-run: [`packages/bench`](https://github.com/eugene-p/qkitt-queue/tree/main/packages/bench) (`npm run bench` from repo root).

**Strength is worker drain** (throughput + low retained backlog memory). Bare `buildQueue` is a solid FIFO with lower heap than typical peer structures; pure enqueue/dequeue ops trail denque / yocto-queue, and beat `Array#shift` by orders of magnitude.

**Worker drain** — 10 000 no-op jobs (ops/s · pending-job heap)

| Library | c=1 | c=4 | heap Δ (c=1) |
| --- | ---: | ---: | ---: |
| **@qkitt/queue** `withWorker` | **846** | **874** | **247 KiB** |
| fastq | 107 | 100 | 6.80 MiB |
| async.queue | 195 | 220 | 4.94 MiB |
| p-queue | 82 | 71 | 11.04 MiB |

**Bare queue** — 50 000 enqueue + dequeue (ops/s median · retained heap)

| Library | ops/s | heap Δ |
| --- | ---: | ---: |
| **@qkitt/queue** `buildQueue` | 789 | 1.19 MiB |
| denque | 1,462 | 1.73 MiB |
| yocto-queue | 2,161 | 1.92 MiB |
| native `Array` push/shift | 7 | 1.18 MiB |

Relative numbers (Node 22.23.1, Windows laptop, 2026-07-22). YMMV.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration guidance.

## License

[ISC](./LICENSE)
