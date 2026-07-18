import { buildQueue } from '@qkitt/queue'
import { Bench } from 'tinybench'
import Denque from 'denque'
import Queue from 'yocto-queue'
import { FIFO_N, printHeader } from './helpers.js'
import { measureRetained, printMemoryTable } from './memory.js'

/**
 * Bare FIFO microbench: enqueue N then dequeue N.
 * Structure-only — no workers, events, or async.
 */
export const runFifoBench = async (): Promise<void> => {
  printHeader(`Bare FIFO (enqueue+dequeue × ${FIFO_N.toLocaleString()})`)

  const bench = new Bench({ time: 500, warmupTime: 100 })

  bench
    .add('@qkitt/queue buildQueue', () => {
      const q = buildQueue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      for (let i = 0; i < FIFO_N; i++) q.dequeue()
    })
    .add('denque', () => {
      const q = new Denque<number>()
      for (let i = 0; i < FIFO_N; i++) q.push(i)
      for (let i = 0; i < FIFO_N; i++) q.shift()
    })
    .add('yocto-queue', () => {
      const q = new Queue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      for (let i = 0; i < FIFO_N; i++) q.dequeue()
    })
    .add('native Array push/shift', () => {
      const q: number[] = []
      for (let i = 0; i < FIFO_N; i++) q.push(i)
      for (let i = 0; i < FIFO_N; i++) q.shift()
    })

  await bench.run()
  console.table(bench.table())

  // Retained heap with N items still in the queue (structure cost).
  printMemoryTable([
    measureRetained('@qkitt/queue buildQueue', () => {
      const q = buildQueue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      return q
    }),
    measureRetained('denque', () => {
      const q = new Denque<number>()
      for (let i = 0; i < FIFO_N; i++) q.push(i)
      return q
    }),
    measureRetained('yocto-queue', () => {
      const q = new Queue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      return q
    }),
    measureRetained('native Array', () => {
      const q: number[] = []
      for (let i = 0; i < FIFO_N; i++) q.push(i)
      return q
    }),
  ])
}
