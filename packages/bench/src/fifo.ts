import { buildQueue } from '@qkitt/queue'
import Denque from 'denque'
import Queue from 'yocto-queue'
import {
  FIFO_N,
  printHeader,
  printNote,
  timeAlone,
} from './helpers.js'
import { measureRetainedMedian, tryGc } from './memory.js'
import { mergeResult, printFifoTable, printProgress } from './report.js'

type Case = {
  name: string
  /** One timed iteration: enqueue N then dequeue N. */
  run: () => void
  /** Build a full structure of N items and return it (held for memory sample). */
  hold: () => unknown
}

const cases = (): Case[] => [
  {
    name: '@qkitt/queue buildQueue',
    run: () => {
      const q = buildQueue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      for (let i = 0; i < FIFO_N; i++) q.dequeue()
    },
    hold: () => {
      const q = buildQueue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      return q
    },
  },
  {
    name: 'denque',
    run: () => {
      const q = new Denque<number>()
      for (let i = 0; i < FIFO_N; i++) q.push(i)
      for (let i = 0; i < FIFO_N; i++) q.shift()
    },
    hold: () => {
      const q = new Denque<number>()
      for (let i = 0; i < FIFO_N; i++) q.push(i)
      return q
    },
  },
  {
    name: 'yocto-queue',
    run: () => {
      const q = new Queue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      for (let i = 0; i < FIFO_N; i++) q.dequeue()
    },
    hold: () => {
      const q = new Queue<number>()
      for (let i = 0; i < FIFO_N; i++) q.enqueue(i)
      return q
    },
  },
]

/**
 * Bare FIFO: each library measured alone, then one table.
 * ops/s and heap Δ answer different questions (speed vs size when full).
 */
export const runFifoBench = async (): Promise<void> => {
  printHeader(`Bare FIFO (per library; N=${FIFO_N.toLocaleString()})`)
  printNote([
    'Libraries run one at a time (no interleaving).',
    `ops/s  — median throughput; one op = enqueue ${FIFO_N.toLocaleString()} + dequeue ${FIFO_N.toLocaleString()}.`,
    `heap Δ — retained heap with a full queue of ${FIFO_N.toLocaleString()} items still live.`,
    'ops/s empties the queue each iteration, so heap Δ is measured on a fill that is kept (not peak mid-loop).',
  ])

  const heldLabel = `full queue of ${FIFO_N.toLocaleString()} items`
  const results = []
  const list = cases()

  for (let i = 0; i < list.length; i++) {
    const c = list[i]!
    const label = `[${i + 1}/${list.length}] ${c.name}`

    printProgress(`${label} — timing…`)
    tryGc()
    const timing = await timeAlone(c.name, c.run, {
      time: 500,
      warmupTime: 100,
    })

    printProgress(`${label} — memory (${heldLabel})…`)
    const mem = measureRetainedMedian(c.name, heldLabel, c.hold)
    results.push(mergeResult(timing, mem))
  }

  printFifoTable(FIFO_N, results)
}
