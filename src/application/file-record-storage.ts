import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionRecordStorageBackend, StorageWriteResult } from './record-storage.js'

/**
 * File-backed create-once storage backend. One JSON row per key with the
 * canonical string stored alongside the value so identity comparisons do not
 * re-serialize the stored object.
 *
 * This is not the DSH Storage Domain adapter; it exists as an on-disk
 * development backend that can be replaced by the real domain writer.
 */
export class FileDecisionRecordStorageBackend implements DecisionRecordStorageBackend {
  constructor(private readonly directory: string) {}

  async putIfAbsent(key: string, value: unknown, canonical: string): Promise<StorageWriteResult> {
    await mkdir(this.directory, { recursive: true })
    const file = join(this.directory, `${key}.json`)
    try {
      await writeFile(file, JSON.stringify({ value, canonical }), { flag: 'wx' })
      return 'stored'
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable'
      try {
        const existing = JSON.parse(await readFile(file, 'utf8')) as { canonical?: unknown }
        return existing.canonical === canonical ? 'identical' : 'conflict'
      } catch {
        return 'unavailable'
      }
    }
  }

  async read(key: string): Promise<unknown | undefined> {
    const file = join(this.directory, `${key}.json`)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      return (JSON.parse(raw) as { value?: unknown }).value
    } catch {
      // Distinguish a corrupt existing row from an absent key; callers must
      // not treat unreadable durable data as "never written".
      throw new Error(`managed record "${key}" is corrupt`)
    }
  }

  async drain(): Promise<void> {
    // File writes are completed before putIfAbsent returns.
  }
}
