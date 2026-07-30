# Examples

Runnable scripts for [`@qkitt/queue`](../packages/queue) and [`@qkitt/queue-config`](../packages/queue-config).

Start with `worker-drain` if you are new: it is the smallest useful queue—a FIFO plus a concurrent worker. Pick the example whose outcome matches your problem, run it, then open its `main.ts`; each is intentionally self-contained rather than a production starter kit.

Requires Node.js 20+. From the monorepo root after `npm install` and `npm run build`:

```bash
npx tsx examples/worker-drain/main.ts
npx tsx examples/retry-pipeline/main.ts
npx tsx examples/fs-row-store/main.ts
npx tsx examples/router-topics/main.ts
npx tsx examples/with-config/main.ts
npx tsx examples/with-loop/main.ts
npx tsx examples/with-dlq/main.ts
npx tsx examples/loop-and-dlq/main.ts
npx tsx examples/with-config-loop-dlq/main.ts
npx tsx examples/lifecycle/main.ts

# or all:
npm run examples
```

| Example | Task | Layers / package |
| --- | --- | --- |
| [`worker-drain`](./worker-drain/main.ts) | Concurrent jobs + drain wait | `buildQueue` → `withWorker` |
| [`lifecycle`](./lifecycle/main.ts) | `whenIdle` drain vs `gracefulStop` | `buildQueue` → `withWorker` |
| [`retry-pipeline`](./retry-pipeline/main.ts) | Retries / multi-step | `pipelineWorker` + `retryWorker` → `withWorker` |
| [`fs-row-store`](./fs-row-store/main.ts) | Survive restart via custom file `RowStore` | custom `RowStore` + `buildQueue({ store })` |
| [`router-topics`](./router-topics/main.ts) | Topic fan-out | `buildRouter` + worker queues |
| [`with-config`](./with-config/main.ts) | Declarative multi-queue | `@qkitt/queue-config` |
| [`with-loop`](./with-loop/main.ts) | Same-queue re-entry, hop cap, hop-based `delay` | `buildQueue({ name })` → `withWorker` → `withLoop` |
| [`with-dlq`](./with-dlq/main.ts) | Failed items → distinct sink | `withWorker` → `withDeadLetter` / `withDlq` |
| [`loop-and-dlq`](./loop-and-dlq/main.ts) | Hop, then dead-letter via filters | `withWorker` → `withLoop` → `withDlq` |
| [`with-config-loop-dlq`](./with-config-loop-dlq/main.ts) | Same chain from config | `@qkitt/queue-config` `loop` + `dlq` |

The examples demonstrate one concern at a time. For API contracts and production boundaries—especially persistence, shutdown, and failure handling—continue with the linked guide: [Recipes](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/README.md#recipes) · [Composition](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/composition.md) · [Lifecycle](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/lifecycle.md) · [Failure routing](https://github.com/eugene-p/qkitt-queue/blob/main/packages/queue/docs/failure-routing.md)
