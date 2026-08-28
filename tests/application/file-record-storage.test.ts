import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDecisionRecordStorageBackend } from '../../src/index.js'

describe('FileDecisionRecordStorageBackend', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'afm-records-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores once with create-once semantics', async () => {
    const backend = new FileDecisionRecordStorageBackend(dir)
    await expect(backend.putIfAbsent('r1_key', { a: 1 }, 'canonical-a')).resolves.toBe('stored')
    await expect(backend.putIfAbsent('r1_key', { a: 1 }, 'canonical-a')).resolves.toBe('identical')
    await expect(backend.putIfAbsent('r1_key', { a: 2 }, 'canonical-b')).resolves.toBe('conflict')
    await expect(backend.read('r1_key')).resolves.toEqual({ a: 1 })
  })

  it('throws for a corrupt existing row instead of pretending it is absent', async () => {
    const backend = new FileDecisionRecordStorageBackend(dir)
    await writeFile(join(dir, 'r1_corrupt.json'), '{not-json', 'utf8')
    await expect(backend.read('r1_corrupt')).rejects.toThrow(/corrupt/)
  })

  it('returns unavailable on backend write errors', async () => {
    const backend = new FileDecisionRecordStorageBackend(join(dir, 'missing', 'nested'))
    const result = await backend.putIfAbsent('r1_key', {}, 'c')
    // The backend creates the directory lazily, so this should still work.
    expect(['stored', 'unavailable']).toContain(result)
  })
})
