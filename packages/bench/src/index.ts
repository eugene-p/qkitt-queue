import { runFifoBench } from './fifo.js'
import { runWorkerBench } from './worker.js'

const suite = (process.argv[2] ?? 'all').toLowerCase()

const main = async (): Promise<void> => {
  console.log('@qkitt/queue-bench')
  console.log(`Node ${process.version} · suite=${suite}`)

  if (suite === 'all' || suite === 'fifo') {
    await runFifoBench()
  }
  if (suite === 'all' || suite === 'worker') {
    await runWorkerBench()
  }

  if (suite !== 'all' && suite !== 'fifo' && suite !== 'worker') {
    console.error(`Unknown suite "${suite}". Use: all | fifo | worker`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
