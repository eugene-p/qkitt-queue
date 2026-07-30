# Delivery and idempotency

**Durable workers provide at-least-once delivery, not exactly-once effects.**
Use an application-owned idempotency key whenever a job changes an external
system. A job handler can finish its side effect and the process can stop
before the queue persists its acknowledgement; after `hydrate()`, that job is
available to run again. With `leaseTtlMs`, a slow handler can also be
redelivered while its first invocation is still running.

This is the normal durable-queue tradeoff. The queue atomically owns its row
state, but it cannot atomically commit a database update, send an HTTP request,
or publish to another system and then acknowledge its own row.

[README](../README.md) · [Persistence](./persistence.md) · [Failure routing](./failure-routing.md) · [API `Job`](./api.md#job--createjob)

## What is delivered at least once

A worker uses a lease: claim a row, run the handler, then acknowledge the
lease. A durable row that was leased at shutdown is made available during the
next `hydrate()`. Consequently, a successful invocation can happen again if
the acknowledgement did not complete.

This does not turn every outcome into a permanent retry. A handler failure
follows its configured recovery policy: the default fail path drops the item
when no DLQ is registered. Use `withRetry` and/or `withDeadLetter` when the
failure must be retained for another attempt or inspection. Always call
`flush()` during graceful shutdown so completed acknowledgements and recovery
writes have finished.

## Use `Job.id` as the idempotency key

Use the opt-in `Job<T>` envelope for durable application work. Give every
logical operation one stable `id`; retain that id when a producer retries an
enqueue or an outbox relay sends the record again. The queue's numeric row id
is internal and must not be used as an idempotency key.

```ts
import { buildQueue, createJob, withWorker, type Job } from '@qkitt/queue'

type Email = { to: string; body: string }

const jobs = withWorker(
  buildQueue<Job<Email>>({ store }),
  async (job) => {
    await emailProvider.send({
      to: job.payload.to,
      body: job.payload.body,
      // Name and exact API vary by provider; use job.id on every delivery.
      idempotencyKey: job.id,
    })
  },
)

await jobs.enqueue(
  createJob(
    { to: 'a@example.com', body: 'Welcome' },
    { id: `welcome:${accountId}` },
  ),
)
```

Choose the key at the business boundary, not in the worker. Good keys identify
the effect, such as `invoice:${invoiceId}:charge` or an immutable source event
id. Do not generate a fresh random key inside a retrying producer or handler:
that makes a redelivery look like a new operation.

### When the target has no idempotency-key API

Persist the key with a uniqueness constraint in the system that owns the
effect. Reserve or record the key atomically with the local state change; a
duplicate delivery then sees the existing record and becomes a no-op.

```ts
async function handle(job: Job<{ accountId: string }>) {
  await db.transaction(async (tx) => {
    const inserted = await tx.processedJobs.insertIgnore({ jobId: job.id })
    if (!inserted) return // this delivery already committed its local effect

    await tx.accounts.markWelcomeSent(job.payload.accountId)
  })
}
```

For an effect outside that database, use the target's idempotency mechanism
when it has one. If it has none, keep a durable intent/status record and design
the reconciliation path explicitly; a uniqueness row alone cannot make an
uncooperative remote call exactly once.

## Transactional stores and the outbox pattern

`RowStore` is deliberately a small persistence boundary. The queue calls its
`put`, `remove`, and optional batch methods; it does not expose or assume a
database transaction API. If a custom store is backed by the same database as
your application, its write methods are the integration point for queue row
durability, but acknowledgement is still separate from application work.

For a business write that must reliably cause a job, use a transactional
outbox. In one database transaction, commit the business change and an outbox
record containing the stable `Job` envelope. A relay reads outbox records and
enqueues them. It may enqueue a record more than once if it stops between
`enqueue` and marking the outbox record dispatched, which is why the consumer
still uses `Job.id` as its idempotency key.

```ts
// Request transaction: both records commit, or neither does.
await db.transaction(async (tx) => {
  await tx.orders.insert(order)
  await tx.outbox.insert({
    id: `order:${order.id}:receipt`,
    payload: { orderId: order.id },
  })
})

// Relay: safe to retry this whole operation.
for (const row of await db.outbox.pending()) {
  await jobs.enqueue(createJob(row.payload, { id: row.id }))
  await db.outbox.markDispatched(row.id)
}
```

Make the outbox relay durable and observable, and retain enough state to retry
or reconcile it. Do not use browser Web Storage for this pattern: it is neither
transactional nor safe for multiple owning tabs.
