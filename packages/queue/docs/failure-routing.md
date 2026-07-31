# Failure routing

**Failed worker items are not re-queued by default.** This is intentional: retries, re-entry, and retention each imply a different product decision. Choose the path that says what should happen to an item after its worker has exhausted its normal attempt:

| Approach | When |
| --- | --- |
| [`retryWorker`](./composition.md#4-worker-helpers) | In-call retries before the failure event |
| `withRetry` | Durable attempts with exponential backoff before the DLQ path |
| `withLoop` | Re-enter the **same** queue with hop meta |
| `withDeadLetter` / `withDlq` | Forward failed items to a **distinct** sink |
| Handle `worker:failed` | Log, alert, or re-enqueue yourself |

[README](../README.md) · [Composition](./composition.md) · [API](./api.md#withdeadletter--withdlq)

## Durable retry (`withRetry`)

Apply `withRetry` after a worker. Retry state belongs to the queue row, never
the application payload, so the scheduled next attempt survives a restart.
After the final attempt—or when `classify` returns `'fail'`—the normal fail
path runs: a registered DLQ receives the job, otherwise it is dropped.

```ts
const failed = buildQueue<Job>()
const jobs = withDeadLetter(
  withRetry(
    withWorker(buildQueue<Job>({ store }), run),
    {
      maxAttempts: 5,
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitter: 0.2,
      classify: ({ error }) => error instanceof TypeError ? 'fail' : 'retry',
    },
  ),
  failed,
)
```

`maxAttempts` includes the first delivery (default `3`). Delay starts at
`initialDelayMs` for attempt 2 and doubles until `maxDelayMs`; jitter is a
symmetric 0–1 spread and defaults to `0.2`. Set `jitter: 0` for a fixed
schedule. Observe `retry:scheduled` and `retry:exhausted` for operations.

`withRetry` and `withLoop` are alternative recovery policies and cannot be
combined. `retryWorker` remains useful for short, in-call retries; it does not
persist attempt state or release worker capacity between attempts.

## Choosing a retry mechanism

Use the smallest mechanism that matches why the work failed:

| Use | Choose | Why |
| --- | --- | --- |
| A brief transient failure inside one delivery (for example, one HTTP request timing out) | `retryWorker` | Retries happen immediately in the same worker call. No queue write or scheduling is needed. |
| A job should wait, survive restart, and eventually reach a DLQ after a bounded number of deliveries | `withRetry` | Attempts and delay are persisted in the row; the worker capacity is released between attempts. |
| The original job needs to re-enter the same queue with altered state or a domain-specific readiness rule | `withLoop` | Its `map`, `filter`, and named-queue hop metadata support application-controlled re-entry. |

### `retryWorker`: immediate, in-call retries

Choose this for small, fast retries where keeping one worker slot occupied is
acceptable. It is ideal for a request that often succeeds on a second try and
does not need to survive process restart while waiting. It does **not** persist
the retry count or delay, so it is not the durable-job default.

### `withRetry`: durable, bounded delivery retries

Choose this for normal background-job recovery: retry a known number of times,
back off between deliveries, then send the final failure to `withDlq` when one
is configured. This is usually the best choice for flaky downstream services.
Use `classify` to skip retrying permanent failures such as validation errors.

### `withLoop`: intentional re-entry

Choose this only when the application needs to change the item, wait for an
external condition, or make the stopping rule itself. A loop can be unbounded;
always add a `filter` hop cap or another clear exit condition, and normally add
a delay. If all you need is capped exponential retry, prefer `withRetry`.

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

**Full destination is misconfiguration.** A bounded dead-letter sink that throws `QueueFullError` is not an overflow strategy: size it for worst-case failure volume, leave it unbounded, or **drain** it. Destination `enqueue` / `map` / `filter` failures emit `dlq:error` with `DeadLetterEnqueueError` (cause preserved). A failed destination handoff is retried with a 1-second backoff up to `maxHandoffAttempts` (default `3`); the source is then acknowledged and emits `worker:dropped`. Handoff state is stored only while it is pending, so durable queues preserve the cap across restart. **Subscribe to `dlq:error` in production** if the sink can throw.

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
