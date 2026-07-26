# API reference

Guides show composition patterns; this page covers public signatures.

[README](../README.md) · [Composition](./composition.md) · [Persistence](./persistence.md) · [Topics & routing](./routing.md) · [Failure routing](./failure-routing.md) · [Lifecycle](./lifecycle.md)

**Primary (most apps):** `buildQueue`, `withWorker`, `whenIdle`, `gracefulStop`, `withDeadLetter` / `withDlq`, `withLoop`, `retryWorker`, `pipelineWorker`, `pipelineDone`, `withPersist`, memory/web store factories, `buildRouter`, common types (`Queue`, `WorkerFn`, `RowRecord`, `RouteMessage`, store interfaces).

Everything else (`tryDequeue` / `tryPeek` / `QueueSlot`, `replaceAll`, `emit`) is for specialized use — see individual entries below.

## `buildQueue`

```ts
buildQueue<T>(options?: BuildQueueOptions): Queue<T>
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxSize` | `number` | — | Safe integer ≥ 1. `enqueue` / `replaceAll` throw `QueueFullError` when full. |
| `name` | `string` | — | Logical id (trimmed, non-empty). Used by `withLoop` hop meta and tracking (`getQueueName`). |

**Methods**

| Method | Returns | Description |
| --- | --- | --- |
| `enqueue(item)` | `void` | Add to tail |
| `dequeue()` | `T \| undefined` | Remove head (`undefined` if empty; ambiguous when `T` may be `undefined`) |
| `peek()` | `T \| undefined` | Head without removing (same ambiguity as `dequeue`) |
| `tryDequeue()` | `QueueSlot<T> \| undefined` | Nullish-safe: `{ value }` or `undefined` if empty |
| `tryPeek()` | `QueueSlot<T> \| undefined` | Nullish-safe peek |
| `size()` | `number` | Item count |
| `isEmpty()` | `boolean` | |
| `clear()` | `void` | Remove all; emits `queue:cleared` |
| `replaceAll(items)` | `void` | Silent replace (no queue events). Used by persist hydrate — not a substitute for looping `enqueue`. |
| `toArray()` | `T[]` | Snapshot head → tail |
| `on` | `() => void` | Subscribe; returns unsubscribe |
| `emit` | `void` | Advanced; prefer domain methods so invariants hold |

`null` / `undefined` are valid payloads. Prefer `tryDequeue` / `tryPeek` when `T` may be nullish so emptiness is structural (`undefined` return) rather than inferred from the value.

**Errors:** `QueueFullError` (`maxSize`); `InvalidQueueOptionError` for invalid `maxSize`.

**Events**

| Event | Payload |
| --- | --- |
| `queue:enqueued` | `{ item, size }` |
| `queue:dequeued` | `{ item, size }` |
| `queue:emptied` | `undefined` |
| `queue:cleared` | `{ removed }` |

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

**Controls** (added to the queue)

| Method | Description |
| --- | --- |
| `start()` | Begin taking items |
| `stop()` | Stop taking new items; in-flight finish (sync; does not wait) |
| `gracefulStop(options?)` | Stop, await in-flight, optional `flush: true` / `timeoutMs` |
| `isRunning()` | Whether the pump may take work |
| `isProcessing()` | Any in-flight items |
| `activeCount()` | In-flight count |

Methods added by inner layers (e.g. `flush`, `hydrate`) remain accessible on the decorated queue. See also standalone [`whenIdle`](#whenidle--gracefulstop) / `gracefulStop` and the [lifecycle guide](./lifecycle.md).

**Events**

| Event | Payload | When |
| --- | --- | --- |
| `worker:started` | `{ item }` | Before run |
| `worker:completed` | `{ item, result }` | Resolved |
| `worker:failed` | `{ item, error }` | Rejected |
| `worker:idle` | `undefined` | Empty and nothing in flight |
| `worker:pump-error` | `{ error }` | Unexpected `tryDequeue` failure (worker stops) |

The pump uses `tryDequeue` so nullish payloads are processed. While a stacked persist layer is hydrating, `tryDequeue` throws `QueueHydratingError`; the pump waits for the post-hydrate kick. Other unexpected dequeue failures emit `worker:pump-error` and stop the worker — call `start()` after fixing the cause.

**Errors:** `InvalidWorkerOptionError` for invalid `concurrency` / invalid lifecycle `timeoutMs`; `LifecycleTimeoutError` when `whenIdle` / `gracefulStop` exceed `timeoutMs`.

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
  deadLetter: DeadLetterTarget<U>, // { enqueue(item: U): void }
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
| `delay` | `number \| (hops: number) => number` | `0` | Finite ms ≥ 0 before re-enqueue; function receives 1-based hop count only. **Not durable:** restart/crash drops pending delayed items (timer-only; not in queue/persist). Prefer short delays. |

`ctx` (`LoopMapContext`): `{ name, previousHops, hops }`. Hop key is the queue’s `name`. Patterns, meta-override behavior, and spin risk: [Failure routing — loop](./failure-routing.md#loop-withloop).

**Events**

| Event | Payload | When |
| --- | --- | --- |
| `loop:enqueued` | `{ item, error, loopItem }` | Re-enqueue succeeded (after any `delay`) |
| `loop:meta-override` | `{ item, error, name, attempted, applied }` | `map` changed `__qkittQueue`; library stamp still applied |
| `loop:error` | `{ item, error, cause }` | `filter`, `map`, `delay`, or re-enqueue threw (`cause` is `LoopEnqueueError`) |

**Errors:** `InvalidQueueCompositionError` (no worker layer); `InvalidLoopOptionError` at wrap (no `name`, or invalid static `delay`). Invalid function `delay` results and `map` / re-enqueue failures emit `loop:error` with `LoopEnqueueError` (`cause` may be `InvalidLoopOptionError`).

### Chaining `withLoop` + `withDlq`

Both layers subscribe to the **same** `worker:failed` event independently — not “loop until filter fails, then DLQ.” Default filters on both sides **duplicate** (re-enqueue and dead-letter every failure). Complementary filters: [Failure routing — chaining](./failure-routing.md#chaining-withloop--withdlq).

---

## `withPersist`

```ts
withPersist<T>(queue: Queue<T>, store: SnapshotStore<T>): QueueWithPersist<T, 'snapshot'>
withPersist<T>(queue: Queue<T>, store: RowStore<T>): QueueWithPersist<T, 'row'>
```

Strategy is inferred from the store's method shape at runtime:
- `load` + `save` → snapshot
- `loadAll` + `insert` + `remove` + `clear` → row

Strategy options are read from `store.persistOptions` (set by factories, or on your store). Omitted options use defaults.

**Snapshot options** (via factory or `persistOptions`):

| Option | Type | Default |
| --- | --- | --- |
| `autoSave` | `boolean` | `true` |
| `autoSaveDebounceMs` | `number` | `0` (microtask coalesce) |

**Row options** (via factory or `persistOptions`):

| Option | Type | Default |
| --- | --- | --- |
| `createId` | `() => string` | Library default (nanoid-style) |

When `autoSave` is true, burst mutations are coalesced: `0` (default) schedules one save per microtask; `> 0` waits that many ms after the last mutation.

**Snapshot added methods:** `hydrate()`, `persist()`, `flush()`.

**Row added methods:** `hydrate()`, `flush()`, `rowIds()`.

**Snapshot events:** `persist:loaded`, `persist:saved`, `persist:error` (`operation`: `'load' | 'save'`).

**Row events:** `persist:loaded`, `persist:inserted`, `persist:removed`, `persist:cleared`, `persist:error`.

**Errors:** `QueueHydratingError` on concurrent mutation during hydrate; `HydrateInProgressError` if a second `hydrate()` starts while one is running; `InvalidQueueCompositionError` for wrong stack order or double persist; `InvalidStoreError` if the store matches both shapes or neither; `InvalidPersistOptionError` for bad snapshot options; `InvalidRowIdError` / `DuplicateRowIdError` for bad or colliding row ids.

Guide: [Persistence](./persistence.md).

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

| Factory | Strategy |
| --- | --- |
| `createMemorySnapshotStore<T>()` | Snapshot |
| `createMemoryRowStore<T>()` | Row |
| `createLocalStorageSnapshotStore(key, options?)` | Snapshot |
| `createLocalStorageRowStore(key, options?)` | Row |
| `createSessionStorageSnapshotStore(key, options?)` | Snapshot |
| `createSessionStorageRowStore(key, options?)` | Row |
| `createWebSnapshotStore` / `createWebRowStore` | Custom `WebStorageLike` |

**Errors:** `StorageCodecError` on bad JSON in web stores; `StorageUnavailableError` when `localStorage` / `sessionStorage` is missing and no explicit `storage` was passed.

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
| `Queue<T>` | Bare queue surface |
| `QueueWithWorker<T, R>` | Queue + worker controls |
| `QueueWithPersist<T, S>` | Persist-decorated queue (`S` = `'snapshot'` or `'row'`) |
| `WorkerFn<T, R>` | `(item) => R \| Promise<R>` |
| `WorkerControls` | `start` / `stop` / `gracefulStop` / … |
| `WhenIdleOptions`, `GracefulStopOptions` | Lifecycle helper options |
| `WithWorkerOptions`, `BuildQueueOptions` | Options objects |
| `RowRecord<T>`, `RowStore<T>`, `SnapshotStore<T>` | Persist contracts |
| `RowPersistEvents<T>`, `SnapshotPersistEvents` | Persist event maps for `.on('persist:…')` |
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
| `@qkitt/queue/queue` | `buildQueue`, `getQueueName`, `withWorker`, `whenIdle`, `gracefulStop`, `withDeadLetter` / `withDlq`, `withLoop`, queue + worker types | Persist, stores |
| `@qkitt/queue/worker` | `pipelineWorker`, `pipelineDone`, `retryWorker`, related errors/types | `withWorker` |
| `@qkitt/queue/router` | `buildRouter`, router types | — |
| `@qkitt/queue/persist` | `withPersist`, stores, contracts, event types, `QueueHydratingError` | `buildQueue`, `withWorker` |
| `@qkitt/queue/persist/stores` | Memory + web store factories only | `withPersist`, strategy runtime |
| `@qkitt/queue/persist/stores/memory` | Memory store factories | Web storage |
| `@qkitt/queue/persist/stores/web-storage` | Web storage factories + `StorageCodecError` | Memory stores |
| `@qkitt/queue/events` | `buildEventEmitter`, … | — |

Companion: [`@qkitt/queue-config`](../../queue-config) — declarative `defineConfig` / `buildFromConfig`.

`@qkitt/queue/worker` is worker **helpers** only. The queue worker decorator (`withWorker`) lives under `@qkitt/queue/queue`. The persist decorator (`withPersist`) and all store factories live under `@qkitt/queue/persist`. Prefer `@qkitt/queue/persist/stores/*` when you want store factories without pulling strategy code via a narrow subpath (root and `/persist` still re-export stores for convenience; modern bundlers tree-shake unused chunks when `sideEffects` is false).
