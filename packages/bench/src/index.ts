import { runFifoBench } from './fifo.js'
import { runDurableBench } from './durable.js'
import { runWorkloadBench } from './workloads.js'
import { runWorkerBench } from './worker.js'
import { runPayloadWorkerBench } from './payload-worker.js'

const suite = (process.argv[2] ?? 'all').toLowerCase()

const main = async (): Promise<void> => {
  console.log('@qkitt/queue-bench')
  console.log(`Node ${process.version} · suite=${suite}`)
  console.log(
    'Each row reports ops/s (throughput) and heap Δ (size while holding N). See suite legends.',
  )

  if (suite === 'all' || suite === 'fifo') {
    await runFifoBench()
  }
  if (suite === 'all' || suite === 'worker') {
    await runWorkerBench()
  }
  if (suite === 'all' || suite === 'payload') {
    await runPayloadWorkerBench()
  }
  if (suite === 'all' || suite === 'durable') {
    await runDurableBench()
  }
  if (suite === 'all' || suite === 'workloads') {
    await runWorkloadBench()
  }

  if (suite !== 'all' && suite !== 'fifo' && suite !== 'worker' && suite !== 'payload' && suite !== 'durable' && suite !== 'workloads') {
    console.error(`Unknown suite "${suite}". Use: all | fifo | worker | payload | durable | workloads`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
