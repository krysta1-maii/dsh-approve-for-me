import { describe, expect, it } from 'vitest'
import {
  authorizationChainTipHash,
  authorizationEntryHash,
  authorizationLedgerKey,
  createAuthorizationEntryV1,
  createExtractionCheckpointV1,
  extractionCheckpointChainTipHash,
  extractionInputHash,
  genesisAuthorizationHash,
  genesisExtractionCheckpointHash,
  MAX_AUTHORIZATION_QUOTE_BYTES,
  parseAuthorizationEntryV1,
  parseExtractionCheckpointV1,
} from '../../src/index.js'
import type { AuthorizationEntryV1 } from '../../src/index.js'

const LIFE = 'life'
const HASH_A = 'sha256:' + 'a'.repeat(64)
const HASH_B = 'sha256:' + 'b'.repeat(64)

function entry(sourceSeq = 12, previousEntryHash = genesisAuthorizationHash(LIFE)): AuthorizationEntryV1 {
  return createAuthorizationEntryV1({
    lifecycleFingerprint: LIFE,
    sourceSeq,
    occurredAt: 1000 + sourceSeq,
    quote: 'allow deleting the build cache',
    effect: 'grant',
    coverage: 'action',
    summary: 'user allows removing the build cache directory',
    extractorVersion: 'extractor-v1',
    previousEntryHash,
  })
}

function checkpoint(throughSeq = 12, producedEntryHashes: readonly string[] = [], previousCheckpointHash = genesisExtractionCheckpointHash(LIFE)) {
  return createExtractionCheckpointV1({
    lifecycleFingerprint: LIFE,
    throughSeq,
    extractorVersion: 'extractor-v1',
    inputHash: extractionInputHash([{ seq: 12, text: 'please allow deleting the build cache' }]),
    producedEntryHashes,
    previousCheckpointHash,
  })
}

describe('authorization ledger domain', () => {
  it('creates and round-trips an entry with a self-consistent hash and canonical form', () => {
    const e = entry()
    const same = entry()
    expect(same.entryHash).toBe(e.entryHash)
    expect(same.canonical).toBe(e.canonical)
    const { canonical: _canonical, ...withoutCanonical } = e
    expect(authorizationEntryHash(withoutCanonical)).toBe(e.entryHash)
    expect(parseAuthorizationEntryV1({ ...JSON.parse(e.canonical), canonical: e.canonical })).toEqual(e)
  })
  it('rejects unknown fields, bad enums, oversized text, and recomputed-hash tampering', () => {
    const e = entry()
    expect(() => parseAuthorizationEntryV1({ ...JSON.parse(e.canonical), canonical: e.canonical, extra: 1 })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...e, effect: 'maybe' as never })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...e, coverage: 'forever' as never })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...e, quote: 'x'.repeat(MAX_AUTHORIZATION_QUOTE_BYTES + 1) })).toThrow(TypeError)
    const tampered = { ...JSON.parse(e.canonical), canonical: e.canonical, summary: 'rewritten' }
    expect(() => parseAuthorizationEntryV1(tampered)).toThrow(TypeError)
    expect(() => parseAuthorizationEntryV1({ ...e, canonical: e.canonical.replace('build', 'root') })).toThrow(TypeError)
  })
  it('rejects empty quote/summary/extractorVersion and negative or non-integer seqs', () => {
    expect(() => createAuthorizationEntryV1({ ...entry(), quote: '' })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...entry(), summary: '' })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...entry(), extractorVersion: '' })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...entry(), sourceSeq: -1 })).toThrow(TypeError)
    expect(() => createAuthorizationEntryV1({ ...entry(), sourceSeq: 1.5 })).toThrow(TypeError)
  })
  it('chains entries by previousEntryHash with a domain-separated genesis', () => {
    const a = entry(12)
    const b = entry(30, a.entryHash)
    expect(b.previousEntryHash).toBe(a.entryHash)
    expect(a.previousEntryHash).toBe(genesisAuthorizationHash(LIFE))
    expect(genesisAuthorizationHash('other')).not.toBe(genesisAuthorizationHash(LIFE))
    expect(authorizationChainTipHash(LIFE, b.entryHash)).not.toBe(authorizationChainTipHash(LIFE, a.entryHash))
  })
  it('creates and round-trips a checkpoint with produced entry hashes', () => {
    const a = entry(12)
    const c = checkpoint(12, [a.entryHash])
    expect(parseExtractionCheckpointV1({ ...JSON.parse(c.canonical), canonical: c.canonical })).toEqual(c)
    expect(() => parseExtractionCheckpointV1({ ...JSON.parse(c.canonical), canonical: c.canonical, producedEntryHashes: ['sha256:zz'] })).toThrow(TypeError)
    expect(() => parseExtractionCheckpointV1({ ...JSON.parse(c.canonical), canonical: c.canonical, unknown: true })).toThrow(TypeError)
    const c2 = checkpoint(44, [], c.checkpointHash)
    expect(c2.previousCheckpointHash).toBe(c.checkpointHash)
    expect(extractionCheckpointChainTipHash(LIFE, c2.checkpointHash)).not.toBe(authorizationChainTipHash(LIFE, c2.checkpointHash))
  })
  it('hashes the exact extraction input window deterministically', () => {
    const a = extractionInputHash([{ seq: 1, text: 'one' }, { seq: 5, text: 'two' }])
    expect(a).toBe(extractionInputHash([{ seq: 1, text: 'one' }, { seq: 5, text: 'two' }]))
    expect(a).not.toBe(extractionInputHash([{ seq: 1, text: 'one!' }, { seq: 5, text: 'two' }]))
    expect(a).not.toBe(extractionInputHash([{ seq: 5, text: 'two' }, { seq: 1, text: 'one' }]))
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  it('derives per-lifecycle storage keys without exposing the lifecycle text', () => {
    const key = authorizationLedgerKey(LIFE)
    expect(key).toMatch(/^z1_[0-9a-f]{64}$/)
    expect(key).not.toContain(LIFE)
    expect(key).not.toBe(authorizationLedgerKey('other'))
  })
  it('rejects hash fields that are not sha256 digests', () => {
    expect(() => createAuthorizationEntryV1({ ...entry(), previousEntryHash: 'md5:abc' })).toThrow(TypeError)
    expect(() => createExtractionCheckpointV1({ ...checkpoint(), inputHash: 'zzz' })).toThrow(TypeError)
  })
  it('accepts an empty produced entry list only with a well-formed input hash', () => {
    const c = checkpoint(99, [])
    expect(parseExtractionCheckpointV1({ ...JSON.parse(c.canonical), canonical: c.canonical }).producedEntryHashes).toEqual([])
    expect(c.inputHash).toBe(extractionInputHash([{ seq: 12, text: 'please allow deleting the build cache' }]))
    void HASH_A; void HASH_B
  })
})
