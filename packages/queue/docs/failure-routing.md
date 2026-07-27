# Failure routing

**Failed worker items are not re-queued by default.** Choose a path after `worker:failed`:

| Approach | When |
| --- | --- |
| [`retryWorker`](./composition.md#4-worker-helpers) | In-call retries before the failure event |
| `withLoop` | Re-enter the **same** queue with hop meta |
| `withDeadLetter` / `withDlq` | Forward failed items to a **distinct** sink |
| Handle `worker:failed` | Log, alert, or re-enqueue yourself |

[README](../README.md) · [Composition](./composition.md) · [API](./api.md#withdeadletter--withdlq)

## Dead letter (`withDeadLetter` / `withDlq`)

Forward `worker:failed` items to a **distinct** destination with `enqueue`. Apply **after** the worker:

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

**Full destination is misconfiguration.** A bounded dead-letter sink that throws `QueueFullError` is not an overflow strategy: size it for worst-case failure volume, leave it unbounded, or **drain** it. Destination `enqueue` / `map` / `filter` failures emit `dlq:error` with `DeadLetterEnqueueError` (cause preserved) and **do not** rethrow. **Subscribe to `dlq:error` in production** if the sink can throw — the source item is already gone, and ignoring this event loses the failure quietly.

`withDlq` is an alias of `withDeadLetter`. Stacking multiple dead-letter layers registers multiple handlers (each destination receives the failure).

Runnable demo: [`examples/with-dlq`](../../../examples/with-dlq).

## Loop (`withLoop`)

On `worker:failed`, re-enqueue onto the **same** worker queue. Requires a **named** queue (`buildQueue({ name: 'jobs' })`). Library hop bookkeeping lives under the reserved key `__qkittQueue` (`QKITT_QUEUE_KEY`):

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
| `delay` | `number \| (hops: number) => number` | `0` | Wait this many ms before re-enqueue. Function form gets the 1-based hop count only (e.g. `hops => 100 * 2 ** (hops - 1)`). Same shape as `retryWorker` delay. Static invalid values throw at wrap; invalid function results emit `loop:error`. **Not durable** — see disclaimer below. |

Hop key is the queue’s `name` (not an option). `map` / `filter` receive hop `ctx: { name, previousHops, hops }`.

**Stack:** `buildQueue({ name, store? })` → `withWorker` → `withLoop`.

`__qkittQueue` is **library-owned**. If `map` returns a payload whose `__qkittQueue` differs from the original, the library emits `loop:meta-override` and **overwrites** with the correct hop stamp (re-enqueue still happens). Unchanged bag (e.g. `return item`) is fine.

Pending delayed re-entries do not occupy queue slots; `loop:enqueued` fires when the item is actually re-queued. The worker may go idle while a delay is pending. `stop` does not cancel pending delays.

**Disclaimer — restart / crash loses delayed items.** While waiting, the payload is held only in a process-local timer (not in the queue, not in the durable store). App restart, crash, or process exit **drops** those items with no recovery. Longer delays widen that window; prefer short delays when loss is unacceptable.

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
