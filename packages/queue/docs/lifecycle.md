# Waiting for drain / graceful stop

Use lifecycle helpers when callers need a clear answer to either “has all queued work finished?” or “can this process stop without cutting off work already running?” They solve different shutdown problems, so choose deliberately rather than polling worker state.

[README](../README.md) · [Composition](./composition.md) · [API](./api.md#whenidle--gracefulstop)

```ts
import { whenIdle, gracefulStop } from '@qkitt/queue'

queue.enqueue(job)
await whenIdle(queue) // empty + nothing in flight

// SIGTERM: finish in-flight, leave remaining items queued
await gracefulStop(queue)
// durable exit — also await pending persist writes
await gracefulStop(queue, { flush: true })
// same as queue.gracefulStop({ flush: true }) when using withWorker
```

| Helper | Waits for | Stops pump? | Flush |
| --- | --- | --- | --- |
| `whenIdle(queue, { timeoutMs? })` | Empty + not processing (`worker:idle`) | No | — |
| `gracefulStop(queue, { flush?, timeoutMs? })` | In-flight only (items may remain) | Yes | Opt-in (`flush: true`) |

`whenIdle` does **not** call `stop()`. Idle also never fires if items remain and the pump is not running (`stop()`, or `autoStart: false` without `start()`) — use `timeoutMs`, `start()`, or drain/clear first.

Use `whenIdle` in tests, batch commands, or a controlled drain where you want every queued item to finish. Use `gracefulStop` on shutdown when it is acceptable to leave unstarted items for a later process; pass `flush: true` for durable queues so accepted writes are settled.

Both reject with `LifecycleTimeoutError` when `timeoutMs` elapses. The timeout only rejects the promise; it does not cancel in-flight workers or an in-progress `flush`. Prefer these helpers over busy-polling `isProcessing`.

Runnable demo: [`examples/lifecycle`](../../../examples/lifecycle).
