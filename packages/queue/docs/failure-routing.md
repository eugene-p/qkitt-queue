# Failure routing

**Failed worker items are not re-queued by default.** This is intentional: retries, re-entry, and retention each imply a different product decision. Choose the path that says what should happen to an item after its worker has exhausted its normal attempt:

| Approach | When |
| --- | --- |
| [`retryWorker`](./composition.md#4-worker-helpers) | In-call retries before the failure event |
| `withLoop` | Re-enter the **same** queue with hop meta |
| `withDeadLetter` / `withDlq` | Forward failed items to a **distinct** sink |
| Handle `worker:failed` | Log, alert, or re-enqueue yourself |

[README](../README.md) · [Composition](./composition.md) · [API](./api.md#withdeadletter--withdlq)

## Dead letter (`withDeadLetter` / `withDlq`)

Forward `worker:failed` items to a **distinct** destination with `enqueue`. Apply **after** the worker:

Choose a dead-letter queue when a failed item needs inspection, alerting, or a separate recovery workflow. It makes failure visible without making the main worker retry forever.

```ts
import {
  buildQueue,
  withWorker,
  withDeadLetter,
  withDlq,
} from '@qkitt/queue'

const failed = buildQueue<Job>()
const jobs = withDlq(
  withWorker(buildQueue<Job>(), async (job) => handle(job)),
  failed,
  // optional: { map: (item, error) => ({ item, error }), filter }
)
```

**Stack:** `buildQueue({ store? })` → `withWorker` → `withDeadLetter`.

**Same queue is rejected.** `withDeadLetter(q, q)` throws — use [`withLoop`](#loop-withloop) for same-queue re-entry with hop meta.

**Not the same as router unmatched.** Router `unmatchedTarget` / config `unmatchedQueue` is for publishes with no binding. Dead letter is for **worker processing failures** after dequeue.

**Full destination is misconfiguration.** A bounded dead-letter sink that throws `QueueFullError` is not an overflow strategy: size it for worst-case failure volume, leave it unbounded, or **drain** it. Destination `enqueue` / `map` / `filter` failures emit `dlq:error` with `DeadLetterEnqueueError` (cause preserved), then requeue the source with a 1-second backoff. **Subscribe to `dlq:error` in production** if the sink can throw.

`withDlq` is an alias of `withDeadLetter`. A worker queue supports one dead-letter destination.

Runnable demo: [`examples/with-dlq`](../../../examples/with-dlq).

## Loop (`withLoop`)

On `worker:failed`, re-enqueue onto the **same** worker queue. Requires a **named** queue (`buildQueue({ name: 'jobs' })`). Library hop bookkeeping lives under the reserved key `__qkittQueue` (`QKITT_QUEUE_KEY`):

Choose a loop only when the same job can become valid later and you can state a stopping rule. Put a hop cap or delay in the policy; without one, a consistently failing worker can consume capacity indefinitely.

```ts
job.__qkittQueue.loop.jobs.hops // 1, 2, …
```

```ts
import {
  buildQueue,
  withWorker,
  withLoop,
  getLoopHops,
  getQueueName,
  QKITT_QUEUE_KEY,
} from '@qkitt/queue'

const q = withLoop(
  withWorker(buildQueue<Job>({ name: 'jobs' }), run),
  // optional: { map, filter, delay }
)
// getQueueName(q) → 'jobs'
// getLoopHops(job, 'jobs')
// Non-plain objects become { value, __qkittQueue: { loop: { jobs: { hops } } } }.
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `map` | `(item, error, ctx) => U` | identity | Runs on the **original** item; library always re-stamps `__qkittQueue` |
| `filter` | `(item, error, ctx) => boolean` | always true | Skip re-enqueue when false (e.g. max hops) |
| `delay` | `number \| (hops: number) => number` | `0` | Wait this many ms before re-enqueue. Function form gets the 1-based hop count only (e.g. `hops => 100 * 2 ** (hops - 1)`). Same shape as `retryWorker` delay. Static invalid values throw at wrap; invalid function results emit `loop:error`. |

Hop key is the queue’s `name` (not an option). `map` / `filter` receive hop `ctx: { name, previousHops, hops }`.

**Stack:** `buildQueue({ name, store? })` → `withWorker` → `withLoop`.

`__qkittQueue` is **library-owned**. If `map` returns a payload whose `__qkittQueue` differs from the original, the library emits `loop:meta-override` and **overwrites** with the correct hop stamp (re-enqueue still happens). Unchanged bag (e.g. `return item`) is fine.

Pending delayed re-entries do not occupy queue slots; `loop:enqueued` fires when the item is actually re-queued. The worker may go idle while a delay is pending. `stop` does not cancel pending delays.

**Durable delay.** On a queue with a `RowStore`, loop delay is persisted as the row’s `availableAt` timestamp and survives restart. Bare queues keep delayed items only in process memory.

A worker that always throws can spin forever — stop the worker, `filter` on hops, or set `delay`. This is **not** a dead-letter sink; use `withDeadLetter` for a separate queue.

```ts
const q = withLoop(withWorker(buildQueue<Job>({ name: 'jobs' }), run), {
  delay: (hops) => 100 * 2 ** (hops - 1), // hop-based backoff
  filter: (_item, _error, ctx) => ctx.hops <= 5,
})
```

Runnable demo: [`examples/with-loop`](../../../examples/with-loop).

## Chaining `withLoop` + `withDlq`

Recovery is a **single path** on the worker (not dual independent listeners):

This is the common “try again a few times, then retain for review” policy. The loop owns temporary recovery; the DLQ owns the final outcome.

1. `withLoop` sets recovery policy to **`loop`**.
2. On failure, the loop `filter` / `map` / `delay` run.
3. If the loop `filter` returns **false**, recovery falls through to the **fail** path: DLQ when `withDlq` is registered, otherwise drop (`worker:dropped`).

| Setup | Result |
| --- | --- |
| `withLoop` only, filter false | Drop (ack) — no requeue |
| `withLoop` + `withDlq`, filter false | Dead-letter via fail path |
| Loop filter always true | Requeue forever (or until success) — size the hop cap |

Use complementary filters so hop-capped items reach the DLQ:

```ts
import {
  buildQueue,
  getLoopHops,
  withDlq,
  withLoop,
  withWorker,
} from '@qkitt/queue'

const MAX = 3
const failed = buildQueue<Job>({ name: 'failed' })

const jobs = withDlq(
  withLoop(
    withWorker(buildQueue<Job>({ name: 'jobs' }), run),
    {
      filter: (_item, _error, ctx) => (ctx.previousHops ?? 0) < MAX,
    },
  ),
  failed,
  {
    filter: (item) => (getLoopHops(item, 'jobs') ?? 0) >= MAX,
  },
)
```

Runnable demo: [`examples/loop-and-dlq`](../../../examples/loop-and-dlq). Declarative form: [`@qkitt/queue-config`](../../queue-config) (`loop` + `dlq` on a queue) and [`examples/with-config-loop-dlq`](../../../examples/with-config-loop-dlq).

Signatures and events: [API — `withDeadLetter`](./api.md#withdeadletter--withdlq) · [API — `withLoop`](./api.md#withloop).
