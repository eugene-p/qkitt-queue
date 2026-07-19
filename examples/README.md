# Examples

Runnable scripts for [`@qkitt/queue`](../packages/queue) and [`@qkitt/queue-config`](../packages/queue-config).

From the monorepo root after `npm install` and `npm run build`:

```bash
npx tsx examples/worker-drain/main.ts
npx tsx examples/retry-pipeline/main.ts
npx tsx examples/persist-restart/main.ts
npx tsx examples/router-topics/main.ts
npx tsx examples/with-config/main.ts

# or all:
npm run examples
```

| Example | Story | Layers / package |
| --- | --- | --- |
| [`worker-drain`](./worker-drain/main.ts) | Concurrent backlog drain | `buildQueue` → `withWorker` |
| [`retry-pipeline`](./retry-pipeline/main.ts) | Multi-step job + flaky retry | `pipelineWorker` + `retryWorker` → `withWorker` |
| [`persist-restart`](./persist-restart/main.ts) | Crash, hydrate, finish work | `withSnapshotPersist` → `withWorker` |
| [`router-topics`](./router-topics/main.ts) | Topic publish → queues | `buildRouter` + worker queues |
| [`with-config`](./with-config/main.ts) | Same idea via config | `@qkitt/queue-config` |
