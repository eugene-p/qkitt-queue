import { runDurableBench } from './durable.js'
import { runWorkloadBench } from './workloads.js'
import { runWorkerBench } from './worker.js'
import { runPayloadWorkerBench } from './payload-worker.js'

const suite = (process.argv[2] ?? 'all').toLowerCase()

const main = async (): Promise<void> => {
  console.log('@qkitt/queue-bench')
  console.log(`Node ${process.version} · suite=${suite}`)
  console.log(
    'Each row reports ops/s (throughput) and heap Δ (retained size while holding N). See suite legends.',
  )

  // Default product suite: payload + durable + workloads (not worker).
  if (suite === 'all' || suite === 'payload') {
    await runPayloadWorkerBench()
  }
  if (suite === 'all' || suite === 'durable') {
    await runDurableBench()
  }
  if (suite === 'all' || suite === 'workloads') {
    await runWorkloadBench()
  }
  // Optional diagnostic only — not part of default `all`.
  if (suite === 'worker') {
    await runWorkerBench()
  }

  if (
    suite !== 'all' &&
    suite !== 'worker' &&
    suite !== 'payload' &&
    suite !== 'durable' &&
    suite !== 'workloads'
  ) {
    console.error(
      `Unknown suite "${suite}". Use: all | payload | durable | workloads | worker`,
    )
    console.error(
      '  all (default) = payload + durable + workloads; worker is optional diagnostic only',
    )
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})