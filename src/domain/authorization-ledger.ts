import { createHash } from 'node:crypto'
import { canonicalJson } from './json.js'

/**
 * WP7-a phase-2 authorization drawer (approval-ledger plan §5).
 *
 * An AuthorizationEntryV1 is an append-only, hash-linked record of one
 * Host-verified verbatim quote from a direct human user message, classified by
 * the idle extractor as a grant or a denial with a bounded coverage scope. The
 * LLM extractor is only a parser: the Host re-verifies every quote against the
 * exact live Session event before writing and before any row enters a hot
 * packet (authorization-verification.ts). A drawer row is provenance evidence
 * for the Reviewer, never an authorization by itself, and never produces an
 * automatic allow on its own.
 *
 * The disk chain is an integrity index, not a trust root -- the same rule as
 * the sealed execution chain (WP4). Pollution, chain breaks and unknown fields
 * are read as missing (fail closed).
 */
export const AUTHORIZATION_LEDGER_VERSION = 1 as const
export const AUTHORIZATION_ENTRY_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/authorization/v1\0'
export const AUTHORIZATION_GENESIS_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/authorization-genesis/v1\0'
export const AUTHORIZATION_TIP_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/authorization-tip/v1\0'
export const EXTRACTION_CHECKPOINT_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/extraction-checkpoint/v1\0'
export const EXTRACTION_CHECKPOINT_GENESIS_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/extraction-checkpoint-genesis/v1\0'
export const EXTRACTION_CHECKPOINT_TIP_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/extraction-checkpoint-tip/v1\0'
export const EXTRACTION_INPUT_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/extraction-input/v1\0'

/** Per-entry verbatim quote ceiling (UTF-8 bytes). */
export const MAX_AUTHORIZATION_QUOTE_BYTES = 2_000
/** Per-entry extractor summary ceiling (UTF-8 bytes); a summary is provenance, not an authorization fact. */
export const MAX_AUTHORIZATION_SUMMARY_BYTES = 500

/**
 * WP7-c2a: the reader validates the ENTIRE drawer (no truncation — silently
 * dropping authorization rows would falsify the approval semantics), and the
 * dossier compiler gates the projected row count at this bound, failing
 * closed with ledger-budget-overflow above it. Both sides resolve to the
 * single constant below (the same single-source rule as
 * DEFAULT_MAX_SEALED_HISTORY_WINDOW for the sealed-tail/ledger pair).
 */
export const DEFAULT_MAX_AUTHORIZATION_ENTRIES = 64

const HASH = /^sha256:[0-9a-f]{64}$/

/** What the quoted user language does to the actions it covers. */
export type AuthorizationEffectV1 = 'grant' | 'deny'
/**
 * How far the quoted language reaches: one specifically described action, the
 * turn it was uttered in, or the standing session. The extractor chooses from
 * this closed set; anything else is a parse failure, never a widening.
 */
export type AuthorizationCoverageV1 = 'action' | 'turn' | 'session'

export interface AuthorizationEntryV1 {
  readonly version: 1
  readonly lifecycleFingerprint: string
  /** Event seq of the user/message event whose extracted text contains the quote verbatim. */
  readonly sourceSeq: number
  /** Event time of that same user/message event (re-bound live on read). */
  readonly occurredAt: number
  /** Verbatim substring of the Host-extracted user text at sourceSeq. */
  readonly quote: string
  readonly effect: AuthorizationEffectV1
  readonly coverage: AuthorizationCoverageV1
  /** Bounded extractor-written summary of the covered action; review aid only. */
  readonly summary: string
  readonly extractorVersion: string
  readonly previousEntryHash: string
  readonly entryHash: string
  readonly canonical: string
}

/**
 * One completed incremental extraction. The checkpoint chain records which
 * exact input window (inputHash over {seq, textSha256} items) was consumed up
 * to throughSeq and which entry hashes the batch produced, so an idempotent
 * replay of the same window is detectable and a crash tail is repairable only
 * as the exact next link.
 */
export interface ExtractionCheckpointV1 {
  readonly version: 1
  readonly lifecycleFingerprint: string
  /** Last user/message event seq consumed by this checkpoint (exclusive lower bound for the next). */
  readonly throughSeq: number
  readonly extractorVersion: string
  /** Hash of the canonical {seq, textSha256} window actually delivered to the extractor. */
  readonly inputHash: string
  readonly producedEntryHashes: readonly string[]
  readonly previousCheckpointHash: string
  readonly checkpointHash: string
  readonly canonical: string
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name)
  return value as Record<string, unknown>
}

function keys(o: Record<string, unknown>, expected: readonly string[], name: string) {
  if (Object.keys(o).length !== expected.length || expected.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !expected.includes(k))) throw new TypeError(name)
}

function str(v: unknown, n: string): string { if (typeof v !== 'string' || v.length === 0) throw new TypeError(n); return v }

function int(v: unknown, n: string): number { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new TypeError(n); return v as number }

function bounded(v: unknown, n: string, maxBytes: number): string {
  const value = str(v, n)
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw new TypeError(n)
  return value
}

function digest(domain: string, value: unknown) {
  return 'sha256:' + createHash('sha256').update(domain).update(canonicalJson(value)).digest('hex')
}

export function genesisAuthorizationHash(lifecycleFingerprint: string): string {
  return digest(AUTHORIZATION_GENESIS_HASH_DOMAIN, { version: 1, lifecycleFingerprint })
}

export function authorizationEntryHash(input: Omit<AuthorizationEntryV1, 'entryHash' | 'canonical'> | Omit<AuthorizationEntryV1, 'canonical'>): string {
  const payload = { ...(input as Record<string, unknown>) }
  delete payload.entryHash
  return digest(AUTHORIZATION_ENTRY_HASH_DOMAIN, payload)
}

export function authorizationChainTipHash(lifecycleFingerprint: string, entryHash: string): string {
  return digest(AUTHORIZATION_TIP_HASH_DOMAIN, { version: 1, lifecycleFingerprint, entryHash })
}

export function genesisExtractionCheckpointHash(lifecycleFingerprint: string): string {
  return digest(EXTRACTION_CHECKPOINT_GENESIS_HASH_DOMAIN, { version: 1, lifecycleFingerprint })
}

export function extractionCheckpointChainTipHash(lifecycleFingerprint: string, checkpointHash: string): string {
  return digest(EXTRACTION_CHECKPOINT_TIP_HASH_DOMAIN, { version: 1, lifecycleFingerprint, checkpointHash })
}

export function extractionCheckpointHash(input: Omit<ExtractionCheckpointV1, 'checkpointHash' | 'canonical'> | Omit<ExtractionCheckpointV1, 'canonical'>): string {
  const payload = { ...(input as Record<string, unknown>) }
  delete payload.checkpointHash
  return digest(EXTRACTION_CHECKPOINT_HASH_DOMAIN, payload)
}

/** Hash the exact extraction input window delivered to the extractor (seq + per-text sha256). */
export function extractionInputHash(items: readonly { readonly seq: number; readonly text: string }[]): string {
  const window = items.map(item => ({
    seq: int(item.seq, 'input.seq'),
    textHash: 'sha256:' + createHash('sha256').update(EXTRACTION_INPUT_HASH_DOMAIN).update(item.text, 'utf8').digest('hex'),
  }))
  return digest(EXTRACTION_INPUT_HASH_DOMAIN, { version: 1, items: window })
}

const EFFECTS: readonly string[] = ['grant', 'deny']
const COVERAGES: readonly string[] = ['action', 'turn', 'session']

export function parseAuthorizationEntryV1(input: unknown): AuthorizationEntryV1 {
  const o = object(input, 'authorization')
  keys(o, ['version', 'lifecycleFingerprint', 'sourceSeq', 'occurredAt', 'quote', 'effect', 'coverage', 'summary', 'extractorVersion', 'previousEntryHash', 'entryHash', 'canonical'], 'authorization')
  if (o.version !== 1) throw new TypeError('authorization.version')
  const parsed: Omit<AuthorizationEntryV1, 'canonical'> = {
    version: 1,
    lifecycleFingerprint: str(o.lifecycleFingerprint, 'authorization.lifecycle'),
    sourceSeq: int(o.sourceSeq, 'authorization.sourceSeq'),
    occurredAt: int(o.occurredAt, 'authorization.occurredAt'),
    quote: bounded(o.quote, 'authorization.quote', MAX_AUTHORIZATION_QUOTE_BYTES),
    effect: EFFECTS.includes(o.effect as string) ? o.effect as AuthorizationEffectV1 : (() => { throw new TypeError('authorization.effect') })(),
    coverage: COVERAGES.includes(o.coverage as string) ? o.coverage as AuthorizationCoverageV1 : (() => { throw new TypeError('authorization.coverage') })(),
    summary: bounded(o.summary, 'authorization.summary', MAX_AUTHORIZATION_SUMMARY_BYTES),
    extractorVersion: str(o.extractorVersion, 'authorization.extractorVersion'),
    previousEntryHash: str(o.previousEntryHash, 'authorization.previous'),
    entryHash: str(o.entryHash, 'authorization.entryHash'),
  }
  if (!HASH.test(parsed.previousEntryHash) || !HASH.test(parsed.entryHash) || parsed.entryHash !== authorizationEntryHash(parsed)) throw new TypeError('invalid authorization')
  if (o.canonical !== canonicalJson(parsed)) throw new TypeError('invalid authorization')
  return Object.freeze({ ...parsed, canonical: o.canonical as string })
}

export function createAuthorizationEntryV1(input: Omit<AuthorizationEntryV1, 'version' | 'entryHash' | 'canonical'>): AuthorizationEntryV1 {
  const base = { version: 1 as const, ...input }
  const hashed = { ...base, entryHash: authorizationEntryHash(base) }
  return parseAuthorizationEntryV1({ ...hashed, canonical: canonicalJson(hashed) })
}

export function parseExtractionCheckpointV1(input: unknown): ExtractionCheckpointV1 {
  const o = object(input, 'checkpoint')
  keys(o, ['version', 'lifecycleFingerprint', 'throughSeq', 'extractorVersion', 'inputHash', 'producedEntryHashes', 'previousCheckpointHash', 'checkpointHash', 'canonical'], 'checkpoint')
  if (o.version !== 1) throw new TypeError('checkpoint.version')
  if (!Array.isArray(o.producedEntryHashes) || o.producedEntryHashes.some(h => typeof h !== 'string' || !HASH.test(h))) throw new TypeError('checkpoint.producedEntryHashes')
  const parsed: Omit<ExtractionCheckpointV1, 'canonical'> = {
    version: 1,
    lifecycleFingerprint: str(o.lifecycleFingerprint, 'checkpoint.lifecycle'),
    throughSeq: int(o.throughSeq, 'checkpoint.throughSeq'),
    extractorVersion: str(o.extractorVersion, 'checkpoint.extractorVersion'),
    inputHash: str(o.inputHash, 'checkpoint.inputHash'),
    producedEntryHashes: Object.freeze([...(o.producedEntryHashes as string[])]),
    previousCheckpointHash: str(o.previousCheckpointHash, 'checkpoint.previous'),
    checkpointHash: str(o.checkpointHash, 'checkpoint.checkpointHash'),
  }
  if (!HASH.test(parsed.inputHash) || !HASH.test(parsed.previousCheckpointHash) || !HASH.test(parsed.checkpointHash) || parsed.checkpointHash !== extractionCheckpointHash(parsed)) throw new TypeError('invalid checkpoint')
  if (o.canonical !== canonicalJson(parsed)) throw new TypeError('invalid checkpoint')
  return Object.freeze({ ...parsed, canonical: o.canonical as string })
}

export function createExtractionCheckpointV1(input: Omit<ExtractionCheckpointV1, 'version' | 'checkpointHash' | 'canonical'>): ExtractionCheckpointV1 {
  const base = { version: 1 as const, ...input, producedEntryHashes: Object.freeze([...input.producedEntryHashes]) }
  const hashed = { ...base, checkpointHash: extractionCheckpointHash(base) }
  return parseExtractionCheckpointV1({ ...hashed, canonical: canonicalJson(hashed) })
}

/**
 * Derive the storage key root for one lifecycle's authorization drawer. The
 * hash hides the session/call identity from the storage layout, mirroring
 * sealedFactKey ('l1_') with its own 'z1_' domain separator.
 */
export function authorizationLedgerKey(lifecycleFingerprint: string): string {
  return 'z1_' + createHash('sha256').update('z1\0').update(lifecycleFingerprint).digest('hex')
}
