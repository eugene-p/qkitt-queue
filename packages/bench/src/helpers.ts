/** Items per FIFO round (enqueue then dequeue all). */
export const FIFO_N = 50_000

/**
 * Worker drain matrix (2×2 = 4 cells).
 * Corners only: small vs large backlog × serial vs modest concurrency.
 * Midpoints (5k, concurrency 2) added little signal.
 */
export const WORKER_JOB_COUNTS = [1_000, 10_000] as const
export const WORKER_CONCURRENCIES = [1, 4] as const

export const printHeader = (title: string): void => {
  console.log('')
  console.log(`=== ${title} ===`)
  console.log('')
}
