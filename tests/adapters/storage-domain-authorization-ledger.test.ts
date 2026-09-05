import { describe, expect, it, vi } from 'vitest'
import {
  authorizationLedgerKey,
  createAuthorizationEntryV1,
  createExtractionCheckpointV1,
  DshStorageDomainAuthorizationLedger,
  extractionInputHash,
  genesisAuthorizationHash,
  genesisExtractionCheckpointHash,
} from '../../src/index.js'
import type { AuthorizationEntryV1, ExtractionCheckpointV1, StorageDomainFacility } from '../../src/index.js'

const LIFE = 'life'
const EXTRACTOR = 'extractor-v1'

function fake() {
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let t = tables.get(name)
    if (!t) { t = new Map(); tables.set(name, t) }
    return { get: (k: string) => t!.get(k), put: async (k: string, v: unknown) => { t!.set(k, v) } }
  }
  const close = vi.fn(async () => {})
  return { tables, close, facility: { open: async () => ({ table, close }) } as StorageDomainFacility }
}

function batch(sourceSeqs: readonly number[], previousEntryHash: string, previousCheckpointHash: string, afterSeq = -1): { entries: AuthorizationEntryV1[]; checkpoint: ExtractionCheckpointV1 } {
  let previous = previousEntryHash
  const entries = sourceSeqs.map(seq => {
    const entry = createAuthorizationEntryV1({
      lifecycleFingerprint: LIFE,
      sourceSeq: seq,
      occurredAt: 1000 + seq,
      quote: 'allow it ' + seq,
      effect: 'grant',
      coverage: 'action',
      summary: 'grant ' + seq,
      extractorVersion: EXTRACTOR,
      previousEntryHash: previous,
    })
    previous = entry.entryHash
    return entry
  })
  const throughSeq = sourceSeqs.length === 0 ? afterSeq : sourceSeqs.at(-1)!
  const checkpoint = createExtractionCheckpointV1({
    lifecycleFingerprint: LIFE,
    throughSeq,
    extractorVersion: EXTRACTOR,
    inputHash: extractionInputHash(sourceSeqs.map(seq => ({ seq, text: 'allow it ' + seq }))),
    producedEntryHashes: entries.map(entry => entry.entryHash),
    previousCheckpointHash,
  })
  return { entries, checkpoint }
}

const genesis = () => ({ entry: genesisAuthorizationHash(LIFE), checkpoint: genesisExtractionCheckpointHash(LIFE) })

describe('DshStorageDomainAuthorizationLedger', () => {
  it('appends chained batches and reads them back in order', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12, 30], g.entry, g.checkpoint)
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('created')
    const b = batch([44], a.entries.at(-1)!.entryHash, a.checkpoint.checkpointHash)
    await expect(ledger.appendBatch(LIFE, b.entries, b.checkpoint)).resolves.toBe('created')
    expect((await ledger.read(LIFE))!.map(entry => entry.sourceSeq)).toEqual([12, 30, 44])
    expect((await ledger.readCheckpoint(LIFE))!.throughSeq).toBe(44)
  })
  it('replays the identical committed batch as identical without duplicating rows', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('created')
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('identical')
    expect((await ledger.read(LIFE))!).toHaveLength(1)
    expect(f.tables.get('entry_chains')!.size).toBe(1)
  })
  it('repairs a crash tail that committed entries but not the checkpoint chain', async () => {
    const f = fake()
    const original = f.facility.open
    let fail = true
    f.facility.open = async spec => {
      const h = await original(spec)
      return { ...h, table: (name: string) => { const t = h.table(name); return name === 'checkpoint_chains' ? { ...t, put: async (k: string, v: unknown) => { if (fail) { fail = false; throw new Error('crash') }; await t.put(k, v) } } : t } }
    }
    const g = genesis()
    const a = batch([12, 30], g.entry, g.checkpoint)
    await expect(new DshStorageDomainAuthorizationLedger(f.facility).appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('unavailable')
    const recovered = new DshStorageDomainAuthorizationLedger(f.facility)
    await expect(recovered.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('created')
    expect((await recovered.read(LIFE))!).toHaveLength(2)
    expect((await recovered.readCheckpoint(LIFE))!.throughSeq).toBe(30)
  })
  it('conflicts on a divergent batch at a consumed checkpoint position', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await ledger.appendBatch(LIFE, a.entries, a.checkpoint)
    const divergent = batch([12], g.entry, g.checkpoint)
    const { version: _v, entryHash: _h, canonical: _c, ...rest } = a.entries[0]!
    divergent.entries[0] = createAuthorizationEntryV1({ ...rest, summary: 'rewritten' })
    await expect(ledger.appendBatch(LIFE, divergent.entries, divergent.checkpoint)).resolves.toBe('conflict')
    const forward = batch([20], a.entries.at(-1)!.entryHash, a.checkpoint.checkpointHash)
    expect(await ledger.appendBatch(LIFE, forward.entries, forward.checkpoint)).toBe('created')
  })
  it('rejects broken links, descending seqs, and chain-index pollution', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await ledger.appendBatch(LIFE, a.entries, a.checkpoint)
    const wrongLink = batch([30], genesisAuthorizationHash(LIFE), a.checkpoint.checkpointHash)
    await expect(ledger.appendBatch(LIFE, wrongLink.entries, wrongLink.checkpoint)).resolves.toBe('conflict')
    const descending = batch([5], a.entries.at(-1)!.entryHash, a.checkpoint.checkpointHash)
    await expect(ledger.appendBatch(LIFE, descending.entries, descending.checkpoint)).resolves.toBe('conflict')
    const chainKey = authorizationLedgerKey(LIFE) + '_entry_chain'
    const row = f.tables.get('entry_chains')!.get(chainKey) as { keys: string[]; lifecycleFingerprint: string; tipHash: string }
    f.tables.get('entry_chains')!.set(chainKey, { ...row, tipHash: 'sha256:' + 'c'.repeat(64) })
    await expect(ledger.read(LIFE)).resolves.toBeUndefined()
  })
  it('rejects a batch whose intra-batch entry links are broken, writing nothing', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const first = createAuthorizationEntryV1({
      lifecycleFingerprint: LIFE, sourceSeq: 1, occurredAt: 1001, quote: 'allow it 1',
      effect: 'grant', coverage: 'action', summary: 'grant 1', extractorVersion: EXTRACTOR,
      previousEntryHash: genesisAuthorizationHash(LIFE),
    })
    // The second entry links back to genesis instead of to the first entry:
    // without the intra-batch link check this batch would persist rows and
    // only be caught later by the full re-validation, polluting the drawer.
    const broken = createAuthorizationEntryV1({
      lifecycleFingerprint: LIFE, sourceSeq: 2, occurredAt: 1002, quote: 'allow it 2',
      effect: 'grant', coverage: 'action', summary: 'grant 2', extractorVersion: EXTRACTOR,
      previousEntryHash: genesisAuthorizationHash(LIFE),
    })
    const checkpoint = createExtractionCheckpointV1({
      lifecycleFingerprint: LIFE, throughSeq: 2, extractorVersion: EXTRACTOR,
      inputHash: extractionInputHash([{ seq: 1, text: 'allow it 1' }, { seq: 2, text: 'allow it 2' }]),
      producedEntryHashes: [first.entryHash, broken.entryHash],
      previousCheckpointHash: genesisExtractionCheckpointHash(LIFE),
    })
    await expect(ledger.appendBatch(LIFE, [first, broken], checkpoint)).resolves.toBe('conflict')
    expect(await ledger.readCheckpoint(LIFE)).toBeNull()
    expect(await ledger.read(LIFE)).toEqual([])
  })
  it('treats unknown rows as missing and drains safely', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await ledger.appendBatch(LIFE, a.entries, a.checkpoint)
    const key = authorizationLedgerKey(LIFE) + '_e_' + a.entries[0]!.entryHash.slice(7)
    f.tables.get('entries')!.set(key, { version: 99 })
    await expect(ledger.read(LIFE)).resolves.toBeUndefined()
    await ledger.drain()
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('unavailable')
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('fails closed on absent or rejecting storage facilities', async () => {
    const onUnavailable = vi.fn()
    const absent = new DshStorageDomainAuthorizationLedger(undefined, onUnavailable)
    await expect(absent.read(LIFE)).resolves.toBeUndefined()
    expect(onUnavailable).toHaveBeenCalledOnce()
    const rejected = new DshStorageDomainAuthorizationLedger({ open: async () => { throw new Error('offline') } } as unknown as StorageDomainFacility, onUnavailable)
    await expect(rejected.readCheckpoint(LIFE)).resolves.toBeUndefined()
    expect(onUnavailable).toHaveBeenCalledTimes(2)
  })
  it('returns null checkpoint for a lifecycle with no extractions and empty rows for a fresh drawer', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    await expect(ledger.readCheckpoint(LIFE)).resolves.toBeNull()
    await expect(ledger.read(LIFE)).resolves.toEqual([])
  })
  it('accepts an empty-entry batch that only advances the checkpoint', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const empty = batch([], g.entry, g.checkpoint, 77)
    await expect(ledger.appendBatch(LIFE, empty.entries, empty.checkpoint)).resolves.toBe('created')
    expect(await ledger.read(LIFE)).toEqual([])
    expect((await ledger.readCheckpoint(LIFE))!.throughSeq).toBe(77)
  })
})

describe('DshStorageDomainAuthorizationLedger health (WP8-b)', () => {
  function batchFor(lifecycle: string, sourceSeqs: readonly number[], previousEntryHash: string, previousCheckpointHash: string, afterSeq = -1) {
    let previous = previousEntryHash
    const entries = sourceSeqs.map(seq => {
      const entry = createAuthorizationEntryV1({
        lifecycleFingerprint: lifecycle, sourceSeq: seq, occurredAt: 1000 + seq,
        quote: 'allow it ' + seq, effect: 'grant', coverage: 'action', summary: 'grant ' + seq,
        extractorVersion: EXTRACTOR, previousEntryHash: previous,
      })
      previous = entry.entryHash
      return entry
    })
    const throughSeq = sourceSeqs.length === 0 ? afterSeq : sourceSeqs.at(-1)!
    const checkpoint = createExtractionCheckpointV1({
      lifecycleFingerprint: lifecycle, throughSeq, extractorVersion: EXTRACTOR,
      inputHash: extractionInputHash(sourceSeqs.map(seq => ({ seq, text: 'allow it ' + seq }))),
      producedEntryHashes: entries.map(entry => entry.entryHash),
      previousCheckpointHash,
    })
    return { entries, checkpoint }
  }

  it('reports a null watermark for a fresh drawer', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    await expect(ledger.health()).resolves.toEqual({ entries: 0, checkpoints: 0, maxThroughSeq: null })
  })

  it('counts entries and checkpoints and tracks the extractor watermark, with replay idempotence', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12, 30], g.entry, g.checkpoint)
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('created')
    // An identical replay of the committed tip batch must not double-count.
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('identical')
    await expect(ledger.health()).resolves.toEqual({ entries: 2, checkpoints: 1, maxThroughSeq: 30 })
    const b = batch([44], a.entries.at(-1)!.entryHash, a.checkpoint.checkpointHash)
    await expect(ledger.appendBatch(LIFE, b.entries, b.checkpoint)).resolves.toBe('created')
    await expect(ledger.appendBatch(LIFE, b.entries, b.checkpoint)).resolves.toBe('identical')
    await expect(ledger.health()).resolves.toEqual({ entries: 3, checkpoints: 2, maxThroughSeq: 44 })
    // A crash-tail resume (entries + entry chain written, checkpoint chain not)
    // counts the batch exactly once.
    const c = batch([50], b.entries.at(-1)!.entryHash, b.checkpoint.checkpointHash)
    await expect(ledger.appendBatch(LIFE, c.entries, c.checkpoint)).resolves.toBe('created')
    await expect(ledger.health()).resolves.toEqual({ entries: 4, checkpoints: 3, maxThroughSeq: 50 })
  })

  it('aggregates across lifecycles', async () => {
    const f = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await ledger.appendBatch(LIFE, a.entries, a.checkpoint)
    const other = batchFor('life-two', [7], genesisAuthorizationHash('life-two'), genesisExtractionCheckpointHash('life-two'))
    await expect(ledger.appendBatch('life-two', other.entries, other.checkpoint)).resolves.toBe('created')
    await expect(ledger.health()).resolves.toEqual({ entries: 2, checkpoints: 2, maxThroughSeq: 12 })
  })

  it('returns undefined when unavailable, drained, or when the gauge row is polluted', async () => {
    const absent = new DshStorageDomainAuthorizationLedger(undefined, () => {})
    await expect(absent.health()).resolves.toBeUndefined()
    const f = fake()
    const drained = new DshStorageDomainAuthorizationLedger(f.facility)
    await drained.drain()
    await expect(drained.health()).resolves.toBeUndefined()
    const f2 = fake()
    const ledger = new DshStorageDomainAuthorizationLedger(f2.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await ledger.appendBatch(LIFE, a.entries, a.checkpoint)
    f2.tables.get('stats')!.set('stats', { version: 99 })
    await expect(ledger.health()).resolves.toBeUndefined()
    expect(await ledger.read(LIFE)).toHaveLength(1)
  })

  it('a failing gauge bump never fails the authoritative batch', async () => {
    const f = fake()
    const original = f.facility.open
    f.facility.open = async spec => {
      const h = await original(spec)
      return {
        ...h,
        table: (name: string) => {
          const t = h.table(name)
          return name === 'stats' ? { ...t, put: async () => { throw new Error('gauge down') } } : t
        },
      }
    }
    const ledger = new DshStorageDomainAuthorizationLedger(f.facility)
    const g = genesis()
    const a = batch([12], g.entry, g.checkpoint)
    await expect(ledger.appendBatch(LIFE, a.entries, a.checkpoint)).resolves.toBe('created')
    expect(await ledger.read(LIFE)).toHaveLength(1)
    await expect(ledger.health()).resolves.toBeUndefined()
  })
})
