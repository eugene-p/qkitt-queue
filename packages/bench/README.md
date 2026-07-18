# @qkitt/queue-bench

Private, non-publishable benchmarks for [`@qkitt/queue`](../queue).

Compares in-process bare-queue and worker-drain performance against fair peers. Not published; lives in the monorepo for local and CI runs.

## Peers

`@qkitt/queue` is two layers: a bare queue (`buildQueue`) and an optional concurrent drain (`withWorker`). Each suite uses **different peers** so the comparison stays apples-to-apples for that layer only.

| Suite | Libraries | Role of peers |
| --- | --- | --- |
| Bare queue | `@qkitt/queue` (`buildQueue`), [denque](https://github.com/invertase/denque), [yocto-queue](https://github.com/sindresorhus/yocto-queue), native `Array` | Pure enqueue/dequeue structures — no worker API |
| Worker drain | `@qkitt/queue` (`withWorker`), [fastq](https://github.com/mcollina/fastq), [p-queue](https://github.com/sindresorhus/p-queue), [async.queue](https://caolan.github.io/async/v3/docs.html#queue) | In-process concurrent job runners |

**Why not one shared set?**

- Bare-queue peers (`denque`, `yocto-queue`, `Array`) do not provide a concurrent worker; they cannot run the drain suite fairly.
- Worker peers always allocate task / promise machinery. Putting them in the bare-queue suite would dominate with scheduling overhead, not queue structure cost.
- Redis/Mongo job systems (BullMQ, Agenda, …) are intentionally out of scope — different cost model (I/O, serialization, durability).

## Run

From the monorepo root (after `npm install`):

```bash
npm run bench
npm run bench:fifo
npm run bench:worker
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

## Fairness

- Same job body (sync no-op) and job counts across libraries
- Warmup via `tinybench`
- Worker suite measures end-to-end drain (enqueue + process until **N jobs finished**)
- `@qkitt/queue` completion is a **job counter inside the worker fn** (same idea as `Promise.all` / task callbacks on peers), not `worker:idle` — so the bench does not depend on the event path for correctness
- Worker matrix (**4 cells**): jobs **1k / 10k** × concurrency **1 / 4** (`WORKER_JOB_COUNTS`, `WORKER_CONCURRENCIES` in `src/helpers.ts`)
- **Memory**: retained `heapUsed` / `rss` while all N items are still held (full queue; worker with pump paused / not started). Scripts use `--expose-gc` for cleaner deltas.
- Results vary by machine/Node version; treat as relative, not absolute claims

## Layout

```
src/
  index.ts       # CLI entry (all | fifo | worker)
  fifo.ts        # Bare enqueue/dequeue + retained memory
  worker.ts      # Concurrent worker drain + pending-job memory
  memory.ts      # heap/rss helpers
  helpers.ts     # Shared constants / formatting
```
