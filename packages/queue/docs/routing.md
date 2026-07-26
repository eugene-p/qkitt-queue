# Topics & routing

Publish on topics; bind queues with MQTT/AMQP-style patterns (`*`, `#`).

[README](../README.md) · [Composition](./composition.md) · [API `buildRouter`](./api.md#buildrouter)

## Patterns

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

If a matched binding’s `enqueue` throws, `publish` still counts that binding as matched and does not deliver to the unmatched sink (see `router:error`).

**Not the same as dead letter.** Router unmatched is for publishes with no binding. [Dead letter](./failure-routing.md) is for **worker processing failures** after dequeue.

Runnable demo: [`examples/router-topics`](../../../examples/router-topics).
