export type MemRow = {
  name: string
  /** heapUsed after − before (bytes). */
  heapDelta: number
  /** rss after − before (bytes). */
  rssDelta: number
}

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
 * Call once per library under the same N so rows are comparable.
 */
export const measureRetained = (name: string, build: () => unknown): MemRow => {
  tryGc()
  const before = process.memoryUsage()
  const held = build()
  const after = process.memoryUsage()

  // Keep graph live across the sample (and defeat DCE).
  if (held === null || held === undefined) {
    throw new Error(`measureRetained(${name}): build() must return a held value`)
  }
  // Touch so V8 cannot prove the value is unused before `after`.
  void (held as { constructor?: unknown }).constructor

  return {
    name,
    heapDelta: after.heapUsed - before.heapUsed,
    rssDelta: after.rss - before.rss,
  }
}

export const printMemoryTable = (rows: readonly MemRow[]): void => {
  console.log('Memory (retained heap while structure holds all items):')
  console.table(
    rows.map((row) => ({
      name: row.name,
      'heap Δ': formatBytes(row.heapDelta),
      'rss Δ': formatBytes(row.rssDelta),
      'heap Δ (B)': row.heapDelta,
    })),
  )
  if (!isGcExposed()) {
    console.log(
      '  tip: tighter deltas with GC — npm run bench -- --expose-gc  (or NODE_OPTIONS=--expose-gc)',
    )
  }
}
