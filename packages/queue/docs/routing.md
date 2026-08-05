# Topics & routing

Use routing when one producer should publish a named event and zero, one, or many in-process consumers can react independently. Publish on topics; bind queues with MQTT/AMQP-style patterns (`*`, `#`).

This is in-process fan-out, not a network message broker: all bound queues live in the same application. Use it to keep features such as billing, fulfillment, and analytics decoupled without making the publisher know every consumer.

[README](../README.md) · [Composition](./composition.md) · [API `buildRouter`](./api.md#buildrouter)

## Patterns

Each matching binding receives its own `{ topic, data }` message. Choose exact topics for a single consumer, `*` for one varying segment, and `#` when a queue owns a whole topic family.

| Pattern | Matches |
| --- | --- |
| `orders.created` | Exact topic |
| `orders.*` | One segment (`orders.created`, not `orders.a.b`) |
| `orders.#` | Zero or more trailing segments |
| `#` | Everything |

Wildcards are only valid as a whole segment (`orders*`, `ord#` are rejected).

```ts
import { buildQueue, buildRouter, withWorker, type RouteMessage } from '@qkitt/queue'

type Order = { id: number; total: number }

const router = buildRouter()
const created = buildQueue<RouteMessage<Order>>()
const allOrders = buildQueue<RouteMessage>()

router.bind('orders.created', created)
router.bind('orders.#', allOrders)

withWorker(created, async ({ topic, data }) => {
  console.log(topic, data.id, data.total)
})

router.publish('orders.created', { id: 1, total: 42 })
// both queues get { topic, data }

const unbind = router.bind('jobs.*', buildQueue())
unbind()
```

## Unmatched publishes

**Unmatched** publishes can go to a sink queue. `publish` returns the number of **bindings** that matched — the unmatched sink is not a binding, so the return value stays `0` even when the sink enqueues. Use `router:unmatched` (`delivered`) or the sink queue's `size()` for sink metrics.

An unmatched sink is useful for observability or a catch-all workflow when publishers may use topics that no consumer has claimed. It is not a retry path: a publish with a matched queue whose worker later fails belongs to [failure routing](./failure-routing.md).

Workers on router-bound queues receive `{ topic, data }` (a `RouteMessage`), not the bare payload.

```ts
const unrouted = buildQueue<RouteMessage>()
const router = buildRouter({ unmatchedTarget: unrouted })

router.publish('no.binding', { id: 1 })
router.unmatchedCount()
router.lastUnmatched()
router.clearUnmatched() // stats only
router.setUnmatchedTarget(unrouted) // or undefined to clear
```

If a matched binding’s `enqueue` throws or rejects, `publish` still counts that binding as matched and does not deliver to the unmatched sink (see `router:error`).

For durable targets, use `publishAsync` when the caller must await acceptance:

```ts
const result = await router.publishAsync('orders.created', { id: 1 })
// { matched: 2, accepted: 2, failed: 0 }
```

`publish` remains the synchronous fire-and-forget form; `publishAsync` waits for
all matching enqueues and reports fulfilled versus failed targets.

**Not the same as dead letter.** Router unmatched is for publishes with no binding. [Dead letter](./failure-routing.md) is for **worker processing failures** after dequeue.

Runnable demo: [`examples/router-topics`](../../../examples/router-topics).
