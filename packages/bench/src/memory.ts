/**
 * Retained-heap measurement for bench structures.
 *
 * Answers: “how large is this structure when it holds N?”
 * - Measures retained process memory delta to build and **keep** N items live, after GC.
 * - Includes V8 `heapUsed` plus `arrayBuffers` so typed-array payloads (e.g. Uint8Array
 *   job bodies) are not under-counted when buffers live outside the V8 heap.
 * - Does not measure peak during ops/s, GC churn while draining, or “memory of the
 *   throughput loop.” ops/s empties/drains each iteration; this keeps N held.
 *
 * Payload / workloads / worker: N pending jobs with the worker paused / autoStart false.
 * Durable: N rows enqueued (or hydrated) and still pending — store writes may flush,
 * but jobs are not drained.
 */

export type MemRow = {
  name: string
  /** Retained bytes after − before (heapUsed + arrayBuffers), structure still held. */
  heapDelta: number
  /** rss after − before (bytes). Noisier than heap; informational. */
  rssDelta: number
  /** Human label for what was held (for tables / legends). */
  held: string
}

/** Process-retained bytes that product memory samples care about. */
const retainedBytes = (usage: NodeJS.MemoryUsage): number =>
  usage.heapUsed + usage.arrayBuffers

export const formatBytes = (bytes: number): string => {
  const sign = bytes < 0 ? '-' : ''
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 ** 2) return `${sign}${(abs / 1024).toFixed(1)} KiB`
  return `${sign}${(abs / 1024 ** 2).toFixed(2)} MiB`
}

/** Best-effort GC; enable with `node --expose-gc` / `tsx --expose-gc`. */
export const tryGc = (): void => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) gc()
}

export const isGcExposed = (): boolean =>
  typeof (globalThis as { gc?: () => void }).gc === 'function'

/**
 * Measure retained memory for a structure kept alive by `build`'s return value.
 * Isolated from timing: call on its own after GC, never mid-Bench-run.
 */
export const measureRetained = (
  name: string,
  held: string,
  build: () => unknown,
): MemRow => {
  tryGc()
  tryGc()
  const before = process.memoryUsage()
  const value = build()
  if (value === null || value === undefined) {
    throw new Error(`measureRetained(${name}): build() must return a held value`)
  }
  // Touch so V8 cannot prove the value is unused before `after`.
  void (value as { constructor?: unknown }).constructor
  // Drop build-side garbage so Δ ≈ retained structure.
  tryGc()
  const after = process.memoryUsage()
  void (value as { constructor?: unknown }).constructor

  return {
    name,
    held,
    heapDelta: retainedBytes(after) - retainedBytes(before),
    rssDelta: after.rss - before.rss,
  }
}

/**
 * Median of independent samples. Heap snapshots are noisy in both directions;
 * a median is a stable representative value instead of selecting an optimistic
 * or pessimistic outlier.
 */
export const measureRetainedMedian = (
  name: string,
  held: string,
  build: () => unknown,
  trials = 7,
): MemRow => {
  if (!Number.isSafeInteger(trials) || trials < 1 || trials % 2 === 0) {
    throw new Error('measureRetainedMedian: trials must be a positive odd integer')
  }
  const rows: MemRow[] = []
  for (let i = 0; i < trials; i++) {
    rows.push(measureRetained(name, held, build))
  }
  rows.sort((a, b) => a.heapDelta - b.heapDelta)
  return rows[(rows.length - 1) / 2]!
}

/**
 * Async variant of {@link measureRetained} for builders that must await
 * (durable enqueue / hydrate).
 */
export const measureRetainedAsync = async (
  name: string,
  held: string,
  build: () => unknown | Promise<unknown>,
): Promise<MemRow> => {
  tryGc()
  tryGc()
  const before = process.memoryUsage()
  const value = await build()
  if (value === null || value === undefined) {
    throw new Error(
      `measureRetainedAsync(${name}): build() must return a held value`,
    )
  }
  void (value as { constructor?: unknown }).constructor
  tryGc()
  const after = process.memoryUsage()
  void (value as { constructor?: unknown }).constructor

  return {
    name,
    held,
    heapDelta: retainedBytes(after) - retainedBytes(before),
    rssDelta: after.rss - before.rss,
  }
}

/** Median of independent async retained-heap samples. */
export const measureRetainedMedianAsync = async (
  name: string,
  held: string,
  build: () => unknown | Promise<unknown>,
  trials = 7,
): Promise<MemRow> => {
  if (!Number.isSafeInteger(trials) || trials < 1 || trials % 2 === 0) {
    throw new Error(
      'measureRetainedMedianAsync: trials must be a positive odd integer',
    )
  }
  const rows: MemRow[] = []
  for (let i = 0; i < trials; i++) {
    rows.push(await measureRetainedAsync(name, held, build))
  }
  rows.sort((a, b) => a.heapDelta - b.heapDelta)
  return rows[(rows.length - 1) / 2]!
}
