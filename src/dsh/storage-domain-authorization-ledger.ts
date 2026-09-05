import { canonicalJson } from '../domain/json.js'
import {
  authorizationChainTipHash,
  authorizationLedgerKey,
  extractionCheckpointChainTipHash,
  genesisAuthorizationHash,
  genesisExtractionCheckpointHash,
  parseAuthorizationEntryV1,
  parseExtractionCheckpointV1,
} from '../domain/authorization-ledger.js'
import type { AuthorizationEntryV1, ExtractionCheckpointV1 } from '../domain/authorization-ledger.js'
import type { StorageDomainFacility, StorageDomainHandle } from './storage-domain-decision-record.js'

export type AuthorizationLedgerWriteResult = 'created' | 'identical' | 'conflict' | 'unavailable'

/** Per-lifecycle ordered chain index row; an integrity index, never authorization. */
interface AuthorizationChainV1 { readonly version: 1; readonly lifecycleFingerprint: string; readonly keys: readonly string[]; readonly tipHash: string; readonly canonical: string }

function parseChain(tipDomain: 'authorization' | 'checkpoint', value: unknown): AuthorizationChainV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(tipDomain + '-chain')
  const o = value as Record<string, unknown>
  const expected = ['version', 'lifecycleFingerprint', 'keys', 'tipHash', 'canonical']
  if (Object.keys(o).length !== expected.length || expected.some(k => !Object.hasOwn(o, k)) || o.version !== 1 || typeof o.lifecycleFingerprint !== 'string' || !Array.isArray(o.keys) || o.keys.some(k => typeof k !== 'string') || new Set(o.keys).size !== o.keys.length || typeof o.tipHash !== 'string' || typeof o.canonical !== 'string') throw new TypeError(tipDomain + '-chain')
  const p = { version: 1 as const, lifecycleFingerprint: o.lifecycleFingerprint, keys: Object.freeze([...o.keys] as string[]), tipHash: o.tipHash }
  if (o.canonical !== canonicalJson(p)) throw new TypeError(tipDomain + '-chain')
  return Object.freeze({ ...p, canonical: o.canonical })
}

const spec = Object.freeze({
  name: 'afm_authorization_ledger',
  version: 1,
  layout: 'per-record',
  tables: Object.freeze({
    entries: Object.freeze({ valueSchema: Object.freeze({ parse: parseAuthorizationEntryV1 }) }),
    entry_chains: Object.freeze({ valueSchema: Object.freeze({ parse: (value: unknown) => parseChain('authorization', value) }) }),
    checkpoints: Object.freeze({ valueSchema: Object.freeze({ parse: parseExtractionCheckpointV1 }) }),
    checkpoint_chains: Object.freeze({ valueSchema: Object.freeze({ parse: (value: unknown) => parseChain('checkpoint', value) }) }),
  }),
})

function entryKey(lifecycle: string, entryHash: string) { return authorizationLedgerKey(lifecycle) + '_e_' + entryHash.slice('sha256:'.length) }
function checkpointKey(lifecycle: string, checkpointHash: string) { return authorizationLedgerKey(lifecycle) + '_c_' + checkpointHash.slice('sha256:'.length) }
function entryChainKey(lifecycle: string) { return authorizationLedgerKey(lifecycle) + '_entry_chain' }
function checkpointChainKey(lifecycle: string) { return authorizationLedgerKey(lifecycle) + '_checkpoint_chain' }

function makeEntryChain(lifecycleFingerprint: string, keys: readonly string[], entryHash: string): AuthorizationChainV1 {
  const p = { version: 1 as const, lifecycleFingerprint, keys: Object.freeze([...keys]), tipHash: authorizationChainTipHash(lifecycleFingerprint, entryHash) }
  return Object.freeze({ ...p, canonical: canonicalJson(p) })
}

function makeCheckpointChain(lifecycleFingerprint: string, keys: readonly string[], checkpointHash: string): AuthorizationChainV1 {
  const p = { version: 1 as const, lifecycleFingerprint, keys: Object.freeze([...keys]), tipHash: extractionCheckpointChainTipHash(lifecycleFingerprint, checkpointHash) }
  return Object.freeze({ ...p, canonical: canonicalJson(p) })
}

/**
 * Private append-only authorization drawer (WP7-a). The Host is the sole
 * writer; every batch carries its extraction checkpoint so a replay of the
 * exact same input window is 'identical', any divergence is 'conflict', and a
 * crash tail may only be repaired as the exact next link of both chains. Disk
 * contents are an integrity index: reads re-validate parser, canonical form,
 * self hash, link continuity and tip before returning, and pollution reads as
 * missing (undefined). Live Session re-binding of each row happens in the
 * reader (parent-session-fact-source), never here.
 */
export class DshStorageDomainAuthorizationLedger {
  private readonly tails = new Map<string, Promise<void>>()
  private admissionOpen = true
  private readonly ready: Promise<StorageDomainHandle | undefined>

  constructor(facility: StorageDomainFacility | undefined, onUnavailable: () => void = () => {}) {
    this.ready = facility === undefined ? (onUnavailable(), Promise.resolve(undefined)) : facility.open(spec).catch(() => { onUnavailable(); return undefined })
  }

  /**
   * Append one extraction batch: its verified entries plus the checkpoint that
   * produced them. The batch must chain exactly onto both current tips. An
   * identical replay of an already-recorded checkpoint succeeds as 'identical'
   * without writing; a partially written tail may only be completed by the
   * exact same batch.
   */
  async appendBatch(lifecycleFingerprint: string, entries: readonly AuthorizationEntryV1[], checkpoint: ExtractionCheckpointV1): Promise<AuthorizationLedgerWriteResult> {
    let parsed: readonly AuthorizationEntryV1[]
    let parsedCheckpoint: ExtractionCheckpointV1
    try {
      parsed = entries.map(entry => parseAuthorizationEntryV1(entry))
      parsedCheckpoint = parseExtractionCheckpointV1(checkpoint)
    } catch { return 'conflict' }
    if (parsed.some(entry => entry.lifecycleFingerprint !== lifecycleFingerprint) || parsedCheckpoint.lifecycleFingerprint !== lifecycleFingerprint) return 'conflict'
    // Intra-batch shape: strictly increasing sourceSeq, link continuity, and the
    // checkpoint must list exactly the batch's entry hashes at or below throughSeq.
    // Intra-batch link continuity only: the FIRST entry's link targets the
    // persisted chain tip (or the crash-tail predecessor) and is validated
    // inside the serial section below against the real chain state.
    let previous: string | undefined
    let previousSeq = -1
    for (const entry of parsed) {
      if (previous !== undefined && entry.previousEntryHash !== previous) return 'conflict'
      if (entry.sourceSeq <= previousSeq || entry.sourceSeq > parsedCheckpoint.throughSeq) return 'conflict'
      previous = entry.entryHash
      previousSeq = entry.sourceSeq
    }
    if (parsedCheckpoint.producedEntryHashes.length !== parsed.length || parsed.some((entry, index) => parsedCheckpoint.producedEntryHashes[index] !== entry.entryHash)) return 'conflict'
    return this.serial(lifecycleFingerprint, async () => {
      if (!this.admissionOpen) return 'unavailable'
      const domain = await this.ready
      if (!domain) return 'unavailable'
      try {
        const entriesTable = domain.table('entries')
        const entryChains = domain.table('entry_chains')
        const checkpointsTable = domain.table('checkpoints')
        const checkpointChains = domain.table('checkpoint_chains')
        const rawEntryChain = entryChains.get(entryChainKey(lifecycleFingerprint))
        const oldEntryChain = rawEntryChain === undefined ? undefined : parseChain('authorization', rawEntryChain)
        const rawCheckpointChain = checkpointChains.get(checkpointChainKey(lifecycleFingerprint))
        const oldCheckpointChain = rawCheckpointChain === undefined ? undefined : parseChain('checkpoint', rawCheckpointChain)
        const oldEntryKeys = oldEntryChain?.keys ?? []
        const oldCheckpointKeys = oldCheckpointChain?.keys ?? []
        const entryTipHash = oldEntryKeys.length === 0
          ? genesisAuthorizationHash(lifecycleFingerprint)
          : parseAuthorizationEntryV1(entriesTable.get(oldEntryKeys.at(-1)!)).entryHash
        const checkpointTipHash = oldCheckpointKeys.length === 0
          ? genesisExtractionCheckpointHash(lifecycleFingerprint)
          : parseExtractionCheckpointV1(checkpointsTable.get(oldCheckpointKeys.at(-1)!)).checkpointHash
        const ck = checkpointKey(lifecycleFingerprint, parsedCheckpoint.checkpointHash)
        // The commit point is the checkpoint chain tip: a batch whose checkpoint
        // is already the tip was fully recorded; replaying it is 'identical'.
        const committed = oldCheckpointKeys.length > 0 && oldCheckpointKeys.at(-1) === ck
        if (committed) {
          if (parsedCheckpoint.previousCheckpointHash !== (oldCheckpointKeys.length > 1
            ? parseExtractionCheckpointV1(checkpointsTable.get(oldCheckpointKeys.at(-2)!)).checkpointHash
            : genesisExtractionCheckpointHash(lifecycleFingerprint))) return 'conflict'
        } else {
          // A fresh batch must advance the checkpoint chain monotonically and link on.
          if (parsedCheckpoint.previousCheckpointHash !== checkpointTipHash) return 'conflict'
          if (oldCheckpointKeys.length > 0) {
            const tip = parseExtractionCheckpointV1(checkpointsTable.get(oldCheckpointKeys.at(-1)!))
            if (parsedCheckpoint.throughSeq <= tip.throughSeq) return 'conflict'
          }
        }
        const batchKeys = parsed.map(entry => entryKey(lifecycleFingerprint, entry.entryHash))
        // Crash tail: the entry chain may already end with exactly this batch
        // (entries + entry chain written, checkpoint chain not yet committed).
        // Only that exact suffix may be resumed; every other stale shape conflicts.
        const suffixApplied = batchKeys.length > 0
          && oldEntryKeys.length >= batchKeys.length
          && batchKeys.every((key, index) => oldEntryKeys[oldEntryKeys.length - batchKeys.length + index] === key)
        if (!committed && parsed.length > 0) {
          if (suffixApplied) {
            const preceding = oldEntryKeys.length === batchKeys.length
              ? genesisAuthorizationHash(lifecycleFingerprint)
              : parseAuthorizationEntryV1(entriesTable.get(oldEntryKeys[oldEntryKeys.length - batchKeys.length - 1]!)).entryHash
            if (parsed[0]!.previousEntryHash !== preceding) return 'conflict'
          } else if (parsed[0]!.previousEntryHash !== entryTipHash) return 'conflict'
        }
        if (committed && parsed.length > 0 && !suffixApplied) return 'conflict'
        // Create-once per entry key: identical canonical replays are tolerated,
        // any divergent payload under the same hash-derived key is a conflict.
        for (const entry of parsed) {
          const key = entryKey(lifecycleFingerprint, entry.entryHash)
          const existing = entriesTable.get(key)
          if (existing !== undefined && canonicalJson(parseAuthorizationEntryV1(existing)) !== canonicalJson(entry)) return 'conflict'
          if (existing === undefined) await entriesTable.put(key, entry)
        }
        const existingCheckpoint = checkpointsTable.get(ck)
        if (existingCheckpoint !== undefined && canonicalJson(parseExtractionCheckpointV1(existingCheckpoint)) !== canonicalJson(parsedCheckpoint)) return 'conflict'
        if (existingCheckpoint === undefined) await checkpointsTable.put(ck, parsedCheckpoint)
        if (parsed.length > 0 && !suffixApplied) {
          await entryChains.put(entryChainKey(lifecycleFingerprint), makeEntryChain(lifecycleFingerprint, [...oldEntryKeys, ...batchKeys], parsed.at(-1)!.entryHash))
        }
        if (!committed) {
          await checkpointChains.put(checkpointChainKey(lifecycleFingerprint), makeCheckpointChain(lifecycleFingerprint, [...oldCheckpointKeys, ck], parsedCheckpoint.checkpointHash))
        }
        // Re-validate both complete chains on every write: unrelated persistent
        // corruption fails closed (O(R+A), bounded drawer).
        if (this.validatedEntries(domain, lifecycleFingerprint) === undefined || this.validatedCheckpoints(domain, lifecycleFingerprint) === undefined) return 'unavailable'
        return committed ? 'identical' : 'created'
      } catch { return 'unavailable' }
    })
  }

  /** Undefined means unavailable or polluted; an empty array means the lifecycle has no drawer rows. */
  async read(lifecycleFingerprint: string): Promise<readonly AuthorizationEntryV1[] | undefined> {
    if (!this.admissionOpen) return undefined
    const domain = await this.ready
    return domain === undefined ? undefined : this.validatedEntries(domain, lifecycleFingerprint)
  }

  /** The validated checkpoint chain tip, or undefined when unavailable/polluted; null when none exists yet. */
  async readCheckpoint(lifecycleFingerprint: string): Promise<ExtractionCheckpointV1 | null | undefined> {
    if (!this.admissionOpen) return undefined
    const domain = await this.ready
    if (domain === undefined) return undefined
    const chain = this.validatedCheckpoints(domain, lifecycleFingerprint)
    if (chain === undefined) return undefined
    return chain.length === 0 ? null : chain.at(-1)!
  }

  async drain(): Promise<void> {
    this.admissionOpen = false
    await Promise.all(this.tails.values())
    const domain = await this.ready
    if (domain) await domain.close()
  }

  private validatedEntries(domain: StorageDomainHandle, lifecycleFingerprint: string): readonly AuthorizationEntryV1[] | undefined {
    try {
      const raw = domain.table('entry_chains').get(entryChainKey(lifecycleFingerprint))
      if (raw === undefined) return Object.freeze([])
      const chain = parseChain('authorization', raw)
      if (chain.lifecycleFingerprint !== lifecycleFingerprint || chain.keys.length === 0) return undefined
      let previous = genesisAuthorizationHash(lifecycleFingerprint)
      let previousSeq = -1
      const rows: AuthorizationEntryV1[] = []
      for (const key of chain.keys) {
        const entry = parseAuthorizationEntryV1(domain.table('entries').get(key))
        if (entry.lifecycleFingerprint !== lifecycleFingerprint || entry.sourceSeq <= previousSeq || entry.previousEntryHash !== previous) return undefined
        if (key !== entryKey(lifecycleFingerprint, entry.entryHash)) return undefined
        previous = entry.entryHash
        previousSeq = entry.sourceSeq
        rows.push(entry)
      }
      if (chain.tipHash !== authorizationChainTipHash(lifecycleFingerprint, previous)) return undefined
      return Object.freeze(rows)
    } catch { return undefined }
  }

  private validatedCheckpoints(domain: StorageDomainHandle, lifecycleFingerprint: string): readonly ExtractionCheckpointV1[] | undefined {
    try {
      const raw = domain.table('checkpoint_chains').get(checkpointChainKey(lifecycleFingerprint))
      if (raw === undefined) return Object.freeze([])
      const chain = parseChain('checkpoint', raw)
      if (chain.lifecycleFingerprint !== lifecycleFingerprint || chain.keys.length === 0) return undefined
      let previous = genesisExtractionCheckpointHash(lifecycleFingerprint)
      let previousSeq = -1
      const rows: ExtractionCheckpointV1[] = []
      for (const key of chain.keys) {
        const checkpoint = parseExtractionCheckpointV1(domain.table('checkpoints').get(key))
        if (checkpoint.lifecycleFingerprint !== lifecycleFingerprint || checkpoint.throughSeq <= previousSeq || checkpoint.previousCheckpointHash !== previous) return undefined
        if (key !== checkpointKey(lifecycleFingerprint, checkpoint.checkpointHash)) return undefined
        previous = checkpoint.checkpointHash
        previousSeq = checkpoint.throughSeq
        rows.push(checkpoint)
      }
      if (chain.tipHash !== extractionCheckpointChainTipHash(lifecycleFingerprint, previous)) return undefined
      return Object.freeze(rows)
    } catch { return undefined }
  }

  private serial<T>(lifecycle: string, operation: () => Promise<T>): Promise<T> {
    const before = this.tails.get(lifecycle) ?? Promise.resolve()
    const result = before.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(lifecycle, tail)
    return result.finally(() => { if (this.tails.get(lifecycle) === tail) this.tails.delete(lifecycle) })
  }
}
