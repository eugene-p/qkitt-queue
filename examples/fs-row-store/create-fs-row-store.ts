/** Simple file-backed RowStore (JSON array of rows). Demo only — no locking or multi-process. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RowRecord, RowStore } from '@qkitt/queue'

const cloneRecord = <T>(row: RowRecord<T>): RowRecord<T> => ({
  id: row.id,
  item: row.item,
  availableAt: row.availableAt,
  leaseGeneration: row.leaseGeneration,
  leaseExpiresAt: row.leaseExpiresAt,
})

/**
 * File-backed row store. Each mutation rewrites the full JSON array.
 * Suitable for demos only — not for high throughput or multi-process use.
 */
export const createFsRowStore = <T>(filePath: string): RowStore<T> => {
  let rows: RowRecord<T>[] = []
  let loaded = false

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return
    try {
      const raw = await readFile(filePath, 'utf8')
      const data: unknown = JSON.parse(raw)
      if (!Array.isArray(data)) {
        throw new Error(`row store at ${filePath} must be a JSON array`)
      }
      rows = (data as RowRecord<T>[]).map((r) => cloneRecord(r))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        rows = []
      } else {
        throw error
      }
    }
    loaded = true
  }

  const persist = async (): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
    await rename(tmpPath, filePath)
  }

  return {
    loadAll: async () => {
      await ensureLoaded()
      return rows.map((r) => cloneRecord(r))
    },
    put: async (record) => {
      await ensureLoaded()
      const next = cloneRecord(record)
      const index = rows.findIndex((r) => r.id === next.id)
      if (index === -1) rows.push(next)
      else rows[index] = next
      await persist()
    },
    remove: async (id) => {
      await ensureLoaded()
      rows = rows.filter((r) => r.id !== id)
      await persist()
    },
    clear: async () => {
      await ensureLoaded()
      rows = []
      await persist()
    },
    replaceAll: async (records) => {
      rows = records.map((r) => cloneRecord(r))
      loaded = true
      await persist()
    },
  }
}
