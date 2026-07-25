# Examples

Runnable scripts for [`@qkitt/queue`](../packages/queue) and [`@qkitt/queue-config`](../packages/queue-config).

Requires Node.js 20+. From the monorepo root after `npm install` and `npm run build`:

```bash
npx tsx examples/worker-drain/main.ts
npx tsx examples/retry-pipeline/main.ts
npx tsx examples/persist-restart/main.ts
npx tsx examples/fs-snapshot-store/main.ts
npx tsx examples/router-topics/main.ts
npx tsx examples/with-config/main.ts
npx tsx examples/with-loop/main.ts
npx tsx examples/with-dlq/main.ts
npx tsx examples/loop-and-dlq/main.ts
npx tsx examples/with-config-loop-dlq/main.ts

# or all:
npm run examples
```

| Example | Task | Layers / package |
| --- | --- | --- |
| [`worker-drain`](./worker-drain/main.ts) | Concurrent jobs + drain wait | `buildQueue` → `withWorker` |
| [`retry-pipeline`](./retry-pipeline/main.ts) | Retries / multi-step | `pipelineWorker` + `retryWorker` → `withWorker` |
| [`persist-restart`](./persist-restart/main.ts) | Survive restart (snapshot) | `withPersist` → `withWorker` |
| [`fs-snapshot-store`](./fs-snapshot-store/main.ts) | File snapshot store | custom `SnapshotStore` + `withPersist` |
| [`router-topics`](./router-topics/main.ts) | Topic fan-out | `buildRouter` + worker queues |
| [`with-config`](./with-config/main.ts) | Declarative multi-queue | `@qkitt/queue-config` |
| [`with-loop`](./with-loop/main.ts) | Same-queue re-entry + hop cap | `buildQueue({ name })` → `withWorker` → `withLoop` |
| [`with-dlq`](./with-dlq/main.ts) | Poison → distinct sink | `withWorker` → `withDeadLetter` / `withDlq` |
| [`loop-and-dlq`](./loop-and-dlq/main.ts) | Hop then poison via filters | `withWorker` → `withLoop` → `withDlq` |
| [`with-config-loop-dlq`](./with-config-loop-dlq/main.ts) | Same chain from config | `@qkitt/queue-config` `loop` + `dlq` |

Task index and composition patterns: [Recipes](../packages/queue/README.md#recipes) · [Waiting for drain](../packages/queue/README.md#waiting-for-drain)
