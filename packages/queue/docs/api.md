# API reference

Guides show composition patterns; this page covers public signatures. If you are deciding whether this library fits your application or wiring your first queue, start with the [package README](../README.md) and [Composition](./composition.md). Return here when you need an exact option, return type, event, or error contract.

[README](../README.md) · [Composition](./composition.md) · [Persistence](./persistence.md) · [Delivery & idempotency](./delivery.md) · [Topics & routing](./routing.md) · [Failure routing](./failure-routing.md) · [Lifecycle](./lifecycle.md)

**Primary (most apps):** `buildQueue`, `withWorker`, `whenIdle`, `gracefulStop`, `withRetry`, `withDeadLetter` / `withDlq`, `withLoop`, `retryWorker`, `pipelineWorker`, `pipelineDone`, Web Storage row store factories, `buildRouter`, common types (`Queue`, `WorkerFn`, `RowRecord`, `RowStore`, `RouteMessage`).

Everything else (`tryDequeue` / `tryPeek` / `QueueSlot`, `replaceAll`, `claim` / `ack`, `emit`) is for specialized use — see individual entries below.

## `buildQueue`

```ts
buildQueue<T>(options?: BuildQueueOptions): Queue<T>
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxSize` | `number` | — | Safe integer ≥ 1. `enqueue` / `replaceAll` throw `QueueFullError` when full. |
| `name` | `string` | — | Logical id (trimmed, non-empty). Used by `withLoop` hop meta and tracking (`getQueueName`). |
| `store` | `RowStore<T>` | — | Durable backend. When set, mutations write rows; call `hydrate()` / `flush()`. |
| `leaseTtlMs` | `number` | — | In-process lease TTL (safe integer ≥ 1). Omitted → reclaim leases on hydrate/restart only. The worker context aborts at this deadline. |

**Methods**

| Method | Returns | Description |
| --- | --- | --- |
| `enqueue(item, opts?)` | `Promise<void>` | Add to tail; optional `{ delayMs }` |
| `claim()` | `Promise<Lease<T> \| undefined>` | Worker path: take head under a lease |
| `ack(lease)` | `Promise<void>` | Complete lease (remove durable row) |
| `release(lease)` | `Promise<void>` | Return leased item to available |
| `reschedule(lease, next)` | `Promise<void>` | Settle lease with a new item / delay |
| `dequeue()` | `Promise<T \| undefined>` | Admin drop of head available (`undefined` if empty; ambiguous when `T` may be `undefined`) |
| `tryDequeue()` | `Promise<QueueSlot<T> \| undefined>` | Nullish-safe admin drop: `{ value }` or `undefined` if empty |
| `peek()` | `T \| undefined` | Head without removing (same ambiguity as `dequeue`) |
| `tryPeek()` | `QueueSlot<T> \| undefined` | Nullish-safe peek |
| `size()` | `number` | Non-acked rows (available + delayed + leased) |
| `readyCount()` | `number` | Claimable available rows only |
| `stats()` | `QueueStats` | `{ available, delayed, leased }` |
| `isEmpty()` | `boolean` | |
| `clear()` | `Promise<void>` | Remove all; emits `queue:cleared` |
| `replaceAll(items)` | `Promise<void>` | Silent replace (no queue events) |
| `toArray()` | `T[]` | Snapshot available → delayed → leased |
| `rowIds()` | `number[]` | Durable / delayed / leased ids (bare available has no stable ids until claim) |
| `hydrate()` | `Promise<void>` | Load from `store` (no-op without store) |
| `flush()` | `Promise<void>` | Await durable write chain (no-op without store) |
| `on` | `() => void` | Subscribe; returns unsubscribe |
| `emit` | `void` | Advanced; prefer domain methods so invariants hold |

`null` / `undefined` are valid payloads. Prefer `tryDequeue` / `tryPeek` when `T` may be nullish so emptiness is structural (`undefined` return) rather than inferred from the value.

Treat a `Lease` as invalid after `ack`, `release`, or `reschedule`; the queue may recycle it and release its payload reference immediately.

Bare (no `store`) mutators resolve immediately after the in-memory update. Durable mutators serialize through a write chain.

**Errors:** `QueueFullError` (`maxSize`); `InvalidQueueOptionError` for bad options; `InvalidStoreError` if `store` is not a `RowStore`; `HydrateWhileActiveError` during hydrate or with active leases; `LeaseMismatchError` on stale leases; `InvalidRowIdError` / `DuplicateRowIdError` on bad hydrate rows; `IdSpaceExhaustedError` when ids run out.

**Events**

| Event | Payload |
| --- | --- |
| `queue:enqueued` | `{ item, size }` |
| `queue:dequeued` | `{ item, size }` |
| `queue:emptied` | `undefined` |
| `queue:cleared` | `{ removed }` |
| `persist:loaded` | `{ size }` |
| `persist:lease-expired` | `{ id, item }` |
| `persist:id-space-low` | `{ remaining }` |
| `persist:error` | `{ operation, error, id? }` |

Guide: [Persistence](./persistence.md).

---

## `Job` / `createJob`

The queue stays payload-agnostic. When a persisted job needs a stable
application id and correlation metadata, use the opt-in envelope rather than
putting queue bookkeeping into the payload:

```ts
import { buildQueue, createJob, type Job } from '@qkitt/queue'

type Email = { to: string; body: string }

const queue = buildQueue<Job<Email>>()
await queue.enqueue(
  createJob(
    { to: 'a@example.com', body: 'Hello' },
    { id: 'mail_01H...', metadata: { traceId: 'trace_123' } },
  ),
)
```

```ts
type Job<T, TMetadata = Record<string, unknown>> = {
  id: string
  payload: T
  enqueuedAt: number
  metadata?: TMetadata
}

createJob(payload, { id, metadata?, enqueuedAt? }): Job
```

`id` is application-owned and intended for idempotency at external side
effects; it is distinct from the queue's internal numeric row id. `createJob`
trims and validates a non-empty id and assigns `Date.now()` unless
`enqueuedAt` is supplied (useful for imports and tests). `isJob` is a
structural guard. The envelope intentionally does not alter `Queue<T>`
semantics. Durable worker delivery is at-least-once: use the same `id` on
every delivery at the effect boundary. See [Delivery & idempotency](./delivery.md).

---

## `withWorker`

```ts
withWorker<T, R>(
  queue: Queue<T>,
  worker: WorkerFn<T, R>,
  options?: WithWorkerOptions,
): QueueWithWorker<T, R>
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `concurrency` | `number` | `1` | Safe integer ≥ 1 |
| `autoStart` | `boolean` | `true` | If `false`, no pump until `start()` |
| `timeoutMs` | `number` | — | Finite ≥ 0. Cooperatively aborts the handler's `context.signal` after this duration; it does not forcibly stop JavaScript. |
| `traceContext` | `(item) => unknown` | `Job.metadata` | Derives the opaque tracing/correlation value in worker context. |
| `onFailure` | `RecoveryPolicy<T>` | `'fail'` | `'fail'` (DLQ if registered, else drop), `'loop'`, or custom result policy |

**Controls** (added to the queue)

| Method | Description |
| --- | --- |
| `start()` | Begin taking items |
| `stop()` | Stop taking new items; in-flight finish (sync; does not wait) |
| `gracefulStop(options?)` | Stop, await in-flight, optional `flush: true` / `timeoutMs` |
| `isRunning()` | Whether the pump may take work |
| `isProcessing()` | Any in-flight items |
| `activeCount()` | In-flight count |

Queue methods (`hydrate`, `flush`, `enqueue`, …) remain on the decorated queue. See also standalone [`whenIdle`](#whenidle--gracefulstop) / `gracefulStop` and the [lifecycle guide](./lifecycle.md).

Workers may accept a second `WorkerContext` argument. It contains `jobId` (for
`Job` envelopes), the 1-based durable `attempt`, `leaseDeadline` (epoch ms,
when configured), opaque `traceContext`, and a runtime `AbortSignal` `signal`.
`timeoutMs` and a lease deadline abort that signal with `WorkerTimeoutError` or
`WorkerLeaseExpiredError`; handlers must observe it and stop their own work.
The signal is always supplied by `withWorker`, although it is optional in the
standalone `WorkerFn` type so composed workers remain directly callable.

```ts
withWorker(queue, async (job, { jobId, attempt, signal }) => {
  const response = await fetch('/work', { signal })
  if (signal.aborted) throw signal.reason
  await recordDelivery({ jobId, attempt, response })
}, { timeoutMs: 30_000 })
```

**Events**

| Event | Payload | When |
| --- | --- | --- |
| `worker:started` | `{ item }` | Before run |
| `worker:completed` | `{ item, result }` | Resolved (lease acked) |
| `worker:failed` | `{ item, error }` | Rejected after recovery path |
| `worker:requeued` | `{ item, error?, delayMs? }` | Failure re-entered the queue |
| `worker:dropped` | `{ item, error? }` | Failure dropped (no DLQ / filter) |
| `worker:idle` | `undefined` | Empty and nothing in flight |
| `worker:pump-error` | `{ error }` | Unexpected claim/ack failure (worker stops) |

The pump uses **leases** (`claim` → run → `ack` on success). Default recovery is `'fail'`: forward to a DLQ registered via `withDeadLetter`, else drop. Use `onFailure: 'loop'` or [`withLoop`](#withloop) to requeue.

A custom `onFailure` returns `{ action: 'loop', item?, delayMs? }` or `{ action: 'fail' }`. A missing return follows the fail path, so a failed item is never left leased accidentally.

**Errors:** `InvalidWorkerOptionError` for invalid `concurrency` / worker `timeoutMs`; `WorkerTimeoutError` / `WorkerLeaseExpiredError` are `signal.reason` values for cooperative cancellation; `LifecycleTimeoutError` when `whenIdle` / `gracefulStop` exceed their own `timeoutMs`; `ConflictingRecoveryError` when recovery composition conflicts.

---

## `whenIdle` / `gracefulStop`

```ts
whenIdle(queue, options?: { timeoutMs?: number }): Promise<void>
gracefulStop(queue, options?: { flush?: boolean; timeoutMs?: number }): Promise<void>
// also: queue.gracefulStop(options?) on QueueWithWorker
```

| | `whenIdle` | `gracefulStop` |
| --- | --- | --- |
| Condition | Queue empty and not processing | Not processing (remainder may stay queued) |
| Calls `stop()` | No | Yes |
| `flush` | — | Opt-in (`false` by default) |

Full patterns: [Lifecycle](./lifecycle.md).

---

## `withDeadLetter` / `withDlq`

```ts
withDeadLetter<T, U = T>(
  source: QueueWithWorker<T, …>,
  deadLetter: DeadLetterTarget<U>, // { enqueue(item: U): void | Promise<void> }
  options?: WithDeadLetterOptions<T, U>,
): QueueWithWorker<T, …>
// withDlq — alias of withDeadLetter
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `map` | `(item, error) => U` | identity | Remap before enqueue |
| `filter` | `(item, error) => boolean` | always true | Skip enqueue when false |

Apply **after** `withWorker`. Destination must be a **distinct** reference (same queue throws). Patterns, full-sink warnings, and router-unmatched distinction: [Failure routing](./failure-routing.md).

**Events**

| Event | Payload | When |
| --- | --- | --- |
| `dlq:enqueued` | `{ item, error, deadLetterItem }` | Destination accepted the item |
| `dlq:error` | `{ item, error, cause }` | `filter`, `map`, or destination `enqueue` threw (`cause` is `DeadLetterEnqueueError`) |

**Errors:** `InvalidQueueCompositionError` (no worker layer); `InvalidDeadLetterOptionError` (destination is the same reference as source); `DeadLetterEnqueueError` on the `dlq:error` path.

---

## `withLoop`

```ts
withLoop<T, U = T>(
  queue: QueueWithWorker<T, …>,
  options?: WithLoopOptions<T, U>,
): QueueWithWorker<T, …>
```

Requires a **named** queue (`buildQueue({ name })`). Hop bookkeeping under `__qkittQueue` (`QKITT_QUEUE_KEY`); helpers: `getLoopHops`, `getQueueName`.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `map` | `(item, error, ctx) => U` | identity | Runs on the **original** item; library always re-stamps `__qkittQueue` |
| `filter` | `(item, error, ctx) => boolean` | always true | Skip re-enqueue when false (e.g. max hops) |
| `delay` | `number \| (hops: number) => number` | `0` | Finite ms ≥ 0 before re-enqueue; function receives 1-based hop count only. Durable queues persist the delayed row; bare queues keep it in memory. |

`ctx` (`LoopMapContext`): `{ name, previousHops, hops }`. Hop key is the queue’s `name`. Patterns, meta-override behavior, and spin risk: [Failure routing — loop](./failure-routing.md#loop-withloop).

**Events**

| Event | Payload | When |
| --- | --- | --- |
| `loop:enqueued` | `{ item, error, loopItem }` | Re-enqueue succeeded (after any `delay`) |
| `loop:meta-override` | `{ item, error, name, attempted, applied }` | `map` changed `__qkittQueue`; library stamp still applied |
| `loop:error` | `{ item, error, cause }` | `filter`, `map`, `delay`, or re-enqueue threw (`cause` is `LoopEnqueueError`) |

**Errors:** `InvalidQueueCompositionError` (no worker layer); `InvalidLoopOptionError` at wrap (no `name`, or invalid static `delay`). Invalid function `delay` results and `map` / re-enqueue failures emit `loop:error` with `LoopEnqueueError` (`cause` may be `InvalidLoopOptionError`).

### Chaining `withLoop` + `withDlq`

Single recovery path: loop policy first; loop `filter` false → fail path (DLQ if registered). See [Failure routing — chaining](./failure-routing.md#chaining-withloop--withdlq).

---

## `withRetry`

```ts
withRetry<T>(
  queue: QueueWithWorker<T, …>,
  options?: WithRetryOptions<T>,
): QueueWithWorker<T, …>
```

Apply after `withWorker`. Retry bookkeeping is stored as an optional row field;
old rows start at attempt 1. On retry, the queue reschedules the same row with
the next attempt and a persisted `availableAt`. Exhausted or classified failures
continue to `withDeadLetter` / `withDlq` when configured.

| Option | Default | Notes |
| --- | --- | --- |
| `maxAttempts` | `3` | Safe integer ≥ 1; includes first delivery |
| `initialDelayMs` | `1000` | Finite ms ≥ 0 before attempt 2 |
| `maxDelayMs` | `30000` | Finite ms ≥ `initialDelayMs` |
| `jitter` | `0.2` | Symmetric random spread, finite 0–1 |
| `classify` | retry | `({ item, error, attempt }) => 'retry' \| 'fail'`; fail skips to DLQ/drop |

**Events:** `retry:scheduled` (`item`, `error`, `attempt`, `nextAttempt`, `delayMs`) and `retry:exhausted` (`item`, `error`, `attempt`).

**Errors:** `InvalidQueueCompositionError` (no worker); `InvalidDurableRetryOptionError` for invalid bounds. It conflicts with `withLoop` and a non-fail explicit `onFailure` policy.

---

## Persistence (via `buildQueue`)

There is **no** `withPersist` decorator. Pass `store` (and optional `leaseTtlMs`) to [`buildQueue`](#buildqueue). Snapshot stores, `autoSave`, and `persist()` are removed — see [Persistence](./persistence.md#migration-from-withpersist--snapshot--07).

---

## `retryWorker`

```ts
retryWorker<T, R>(
  worker: WorkerFn<T, R>,
  options: RetryOptions | number,
): WorkerFn<T, R>
```

| Option | Type | Notes |
| --- | --- | --- |
| `retries` | `number` | Safe integer ≥ 0; total attempts = `retries + 1` |
| `delay` | `number \| (failedAttempt: number) => number` | Finite ms ≥ 0; `failedAttempt` is 1-based (attempt only — not the error) |
| `shouldRetry` | `(error: unknown, failedAttempt: number) => boolean` | Default: always retry |

Passing a number is shorthand for `{ retries: n }`.

**Errors:** `RetryExhaustedError` (`attempts`, `cause`); `InvalidRetryOptionError` for invalid `retries` / `delay`.

---

## `pipelineWorker`

```ts
pipelineWorker<T, R = unknown>(steps: readonly PipelineStep[]): WorkerFn<T, R>
pipelineDone<T>(value: T): PipelineDone<T>
```

Each step is `StepFn` or `{ name, fn, metadata? }`. Bare functions get names like `step[0]`.

**Early exit:** `return pipelineDone(value)` from a step — remaining steps are skipped; the worker **resolves** with `value` (marker is unwrapped). Not a failure; `retryWorker` will not retry.

**Errors:** `PipelineStepError` (`stepName`, `stepIndex`, `metadata`, `cause`); `InvalidPipelineError` for empty steps or invalid step entries.

---

## `buildRouter`

```ts
buildRouter(options?: BuildRouterOptions): Router
```

| Option | Type | Notes |
| --- | --- | --- |
| `unmatchedTarget` | `{ enqueue(msg) }` | Sink for unmatched publishes |

**Methods:** `bind(pattern, target)` → unbind fn, `unbind(pattern, target?)`, `publish(topic, data)` → matched binding count (unmatched sink excluded), `unmatchedCount()`, `lastUnmatched()`, `clearUnmatched()`, `setUnmatchedTarget(target?)`, `on` / `emit`.

**Events**

| Event | Payload |
| --- | --- |
| `router:bound` | `{ pattern }` |
| `router:unbound` | `{ pattern, removed }` |
| `router:published` | `{ topic, data, matched }` |
| `router:unmatched` | `{ topic, data, delivered }` |
| `router:error` | `{ operation, error, topic?, pattern? }` |

**Errors:** `InvalidRoutePatternError` on bad bind patterns; `InvalidTopicError` on bad publish topics (also emitted on `router:error` before throw).

Guide: [Topics & routing](./routing.md).

---

## Stores

Durable factories (use with `buildQueue({ store })` for real persistence):

| Factory | Notes |
| --- | --- |
| `createLocalStorageRowStore(key, options?)` | Browser `localStorage` rows |
| `createSessionStorageRowStore(key, options?)` | Browser `sessionStorage` rows |
| `createWebRowStore({ key, storage?, itemCodec? })` | Custom `WebStorageLike` |

`RowStore` requires `loadAll` / `put` / `remove` / `clear` (optional batch helpers). Records use **numeric** ids and lease fields — see [Persistence](./persistence.md#row-records).

For in-process work with no durability, use bare `buildQueue()` (no store). Custom backends implement `RowStore` themselves.

**Errors:** `StorageCodecError` on bad JSON in web stores; `StorageUnavailableError` when `localStorage` / `sessionStorage` is missing and no explicit `storage` was passed; `InvalidStoreError` when `buildQueue({ store })` receives a non-`RowStore`.

---

## Events (standalone)

```ts
import { buildEventEmitter } from '@qkitt/queue'
// or '@qkitt/queue/events'

const bus = buildEventEmitter<{ 'app:ready': undefined }>()
bus.on('app:ready', () => {})
```

Also: `createTypedEmit`, types `EventEmitter`, `EventMap`, `EventCallback`, `MergeEventMaps`.

---

## Types (selected)

| Type | Role |
| --- | --- |
| `QueueSlot<T>` | `{ value: T }` — structural wrapper for `tryDequeue` / `tryPeek` |
| `Job<T>` / `CreateJobOptions<TMetadata>` | Opt-in application job envelope / factory options |
| `Lease<T>` | `{ id, item, generation }` — worker ownership token |
| `QueueStats` | `{ available, delayed, leased }` |
| `Queue<T>` | Queue surface (FIFO + leases + optional durable store) |
| `QueueWithWorker<T, R>` | Queue + worker controls |
| `WorkerFn<T, R>` | `(item) => R \| Promise<R>` |
| `WorkerControls` | `start` / `stop` / `gracefulStop` / … |
| `WhenIdleOptions`, `GracefulStopOptions` | Lifecycle helper options |
| `WithWorkerOptions`, `BuildQueueOptions` | Options objects |
| `RowRecord<T>`, `RowStore<T>` | Durable row contracts |
| `PersistEvents` | Persist event map (`persist:loaded`, …) |
| `RouteMessage<T>`, `Router`, `Binding` | Router |
| `DeadLetterTarget<U>`, `WithDeadLetterOptions<T, U>` | Dead-letter destination / options |
| `LoopMapContext`, `WithLoopOptions<T, U>` | Loop hop context / options |
| `DelayPolicy` | `number \| (attempt: number) => number` — shared by `retryWorker` and `withLoop` delay |
| `RetryOptions`, `PipelineStep`, `PipelineStepContext` | Worker helpers |

Internals (`*.util`, codecs, write chain) are not part of the public contract.

## Package layout

**Default:** import from `@qkitt/queue`. Subpaths are optional for bundle splitting or narrower imports.

| Subpath | Exports | Does *not* contain |
| --- | --- | --- |
| `@qkitt/queue` | Everything | — |
| `@qkitt/queue/queue` | `buildQueue`, `getQueueName`, `withWorker`, `whenIdle`, `gracefulStop`, `withDeadLetter` / `withDlq`, `withLoop`, queue + worker types | Store factories |
| `@qkitt/queue/worker` | `pipelineWorker`, `pipelineDone`, `retryWorker`, related errors/types | `withWorker` |
| `@qkitt/queue/router` | `buildRouter`, router types | — |
| `@qkitt/queue/persist` | `RowStore` contracts, errors, store factories | `buildQueue`, `withWorker` |
| `@qkitt/queue/persist/stores` | Store factories only | Contracts-only usage |
| `@qkitt/queue/persist/stores/web-storage` | Web Storage factories + `StorageCodecError` | — |
| `@qkitt/queue/events` | `buildEventEmitter`, … | — |

Companion: [`@qkitt/queue-config`](../../queue-config) — declarative `defineConfig` / `buildFromConfig`.

`@qkitt/queue/worker` is worker **helpers** only. The queue worker decorator (`withWorker`) lives under `@qkitt/queue/queue`. Store factories live under `@qkitt/queue/persist` (and root). Prefer `@qkitt/queue/persist/stores/*` for narrow imports (root and `/persist` still re-export stores; modern bundlers tree-shake unused chunks when `sideEffects` is false).
