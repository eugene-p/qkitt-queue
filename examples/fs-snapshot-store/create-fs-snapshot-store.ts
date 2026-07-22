/** Simple file SnapshotStore (JSON array). Demo only — no locking or multi-process. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SnapshotStore } from '@qkitt/queue'

export const createFsSnapshotStore = <T>(filePath: string): SnapshotStore<T> => ({
  async load(): Promise<readonly T[]> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const data: unknown = JSON.parse(raw)
      if (!Array.isArray(data)) {
        throw new Error(`snapshot at ${filePath} must be a JSON array`)
      }
      return data as T[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  },

  async save(items: readonly T[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    // Write temp then rename so a crash mid-write is less likely to corrupt.
    const tmpPath = `${filePath}.${process.pid}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
    await rename(tmpPath, filePath)
  },
})
