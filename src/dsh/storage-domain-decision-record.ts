import { createHash } from 'node:crypto'
import { canonicalJson } from '../domain/json.js'
import { parseGateDecisionRecord } from '../application/gate-pipeline.js'
import { GATE_FAILURE_CODES } from '../application/gate-failure.js'
import type {
  GateDecisionRecord,
  GateDecisionRecordResult,
  GateDecisionRecordStore,
} from '../application/gate-pipeline.js'
import type { GateFailureCode } from '../application/gate-failure.js'

/** Minimal structural view of the alpha.1 Storage Domain API.
 *
 * The production package is deliberately accessed structurally so this plugin's
 * legacy rc.2 test installation cannot impersonate the alpha.1 storage form.
 * `storageDomain` remains a required Cordis injection in the target profile.
 */
export interface StorageDomainTable {
  get(key: string): unknown | undefined
  put(key: string, value: unknown): Promise<void>
}

export interface StorageDomainHandle {
  table(name: string): StorageDomainTable
  close(): Promise<void>
}

export interface StorageDomainFacility {
  open(spec: unknown): Promise<StorageDomainHandle>
}

interface StoredGateDecisionRecordV1 {
  readonly version: 1
  readonly canonical: string
  readonly record: GateDecisionRecord
}

/** WP5-c metadata-only failure-code row: only a request id key and reason code. */
interface StoredFailureCodeIndexV1 {
  readonly version: 1
  readonly failureCode: GateFailureCode
}

const decisionRecordDomainSpec = Object.freeze({
  name: 'afm_decision_records',
  version: 1,
  layout: 'per-record',
  tables: Object.freeze({
    records: Object.freeze({
      // The target host validates values with this Zod-compatible parser. The
      // application validates its closed decision shape before it reaches here.
      valueSchema: Object.freeze({
        parse(value: unknown): StoredGateDecisionRecordV1 {
          const row = value as Partial<StoredGateDecisionRecordV1>
          if (row?.version !== 1 || typeof row.canonical !== 'string' || row.record === undefined) {
            throw new TypeError('invalid approve-for-me decision record')
          }
          const record = parseGateDecisionRecord(row.record)
          if (row.canonical !== canonicalJson(record)) {
            throw new TypeError('approve-for-me decision record canonical form does not match')
          }
          return Object.freeze({ version: 1, canonical: row.canonical, record })
        },
      }),
    }),
    // WP5-c: read-only metadata-only reason-code index keyed by request id. It
    // deliberately stores ONLY the typed reason code (plus the row version) so a
    // renderer sidecar read never exposes a packet, action, rationale or hash.
    reasonCode: Object.freeze({
      valueSchema: Object.freeze({
        parse(value: unknown): StoredFailureCodeIndexV1 {
          const row = value as Partial<StoredFailureCodeIndexV1>
          if (row?.version !== 1) throw new TypeError('invalid approve-for-me reason-code index row')
          if (typeof row.failureCode !== 'string' || !GATE_FAILURE_CODES.includes(row.failureCode as GateFailureCode)) {
            throw new TypeError('approve-for-me reason-code index failureCode is invalid')
          }
          return Object.freeze({ version: 1, failureCode: row.failureCode as GateFailureCode })
        },
      }),
    }),
  }),
})

function matchesCanonicalRecord(value: unknown, canonical: string): boolean {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const row = value as Partial<StoredGateDecisionRecordV1>
    if (row.version !== 1 || row.canonical !== canonical || row.record === undefined) return false
    return canonicalJson(parseGateDecisionRecord(row.record)) === canonical
  } catch {
    return false
  }
}

function recordKey(record: GateDecisionRecord): string {
  // Per-record Storage Domain keys are path-safe. Hashing also avoids exposing
  // session/call identifiers in a backend's file layout.
  const identity = canonicalJson({
    parentSessionId: record.parentSessionId,
    parentLifecycleFingerprint: record.parentLifecycleFingerprint,
    requestId: record.requestId,
    callId: record.callId,
    actionHash: record.actionHash,
  })
  return `r_${createHash('sha256').update(identity).digest('hex')}`
}

/** WP5-c: validate a reason-code index row; a missing/malformed value is a miss. */
function parseReasonCodeIndex(value: unknown): StoredFailureCodeIndexV1 | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Partial<StoredFailureCodeIndexV1>
    if (row.version !== 1 || typeof row.failureCode !== 'string' || !GATE_FAILURE_CODES.includes(row.failureCode as GateFailureCode)) {
      return undefined
    }
    return Object.freeze({ version: 1, failureCode: row.failureCode as GateFailureCode })
  } catch {
    return undefined
  }
}

/**
 * Storage-Domain-backed durable gate record writer for the alpha.1 host.
 *
 * Storage Domain serializes its own writes, but `get → put` needs a private
 * per-key admission lane so two local asks can never both observe absence.
 * The table is intentionally not exposed, making this the sole writer in the
 * plugin process. Cross-profile concurrent writers are unsupported and fail
 * closed by profile ownership: only one machine policy slot can be active.
 */
export class DshStorageDomainGateDecisionRecordStore implements GateDecisionRecordStore {
  private readonly tails = new Map<string, Promise<void>>()
  private admissionOpen = true
  private readonly ready: Promise<StorageDomainHandle | undefined>

  constructor(facility: StorageDomainFacility | undefined) {
    this.ready = facility === undefined
      ? Promise.resolve(undefined)
      : facility.open(decisionRecordDomainSpec).catch(() => undefined)
  }

  async createConfirmed(record: GateDecisionRecord): Promise<GateDecisionRecordResult> {
    return this.write(record)
  }

  async recordBestEffort(record: GateDecisionRecord): Promise<void> {
    const result = await this.write(record)
    if (result === 'conflict') throw new Error('durable decision record conflicts with an existing record')
  }

  async readReasonCode(requestId: string): Promise<GateFailureCode | undefined> {
    // WP5-c: read-only, metadata-only reason-code query. It reads exactly one
    // non-sensitive row (request id → typed reason code) and never exposes the
    // record shape, packet, action, rationale or hashes. Any storage failure or
    // missing row degrades to `undefined` (the renderer already falls back to
    // the generic safe line); this read is never an authorizing channel.
    try {
      const domain = await this.ready
      if (domain === undefined) return undefined
      const row = parseReasonCodeIndex(domain.table('reasonCode').get(requestId))
      return row === undefined ? undefined : row.failureCode
    } catch {
      return undefined
    }
  }

  async drain(): Promise<void> {
    this.admissionOpen = false
    await Promise.all(this.tails.values())
    const domain = await this.ready
    if (domain !== undefined) await domain.close()
  }

  private async write(record: GateDecisionRecord): Promise<GateDecisionRecordResult> {
    if (!this.admissionOpen) return 'unavailable'
    try { record = parseGateDecisionRecord(record) } catch { return 'unavailable' }
    const key = recordKey(record)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const operation = previous.then(async (): Promise<GateDecisionRecordResult> => {
      try {
        if (!this.admissionOpen) return 'unavailable'
        const domain = await this.ready
        if (domain === undefined) return 'unavailable'
        const table = domain.table('records')
        const canonical = canonicalJson(record)
        const existing = table.get(key)
        if (existing !== undefined) {
          return matchesCanonicalRecord(existing, canonical) ? 'confirmed' : 'conflict'
        }
        await table.put(key, Object.freeze({ version: 1, canonical, record: Object.freeze({ ...record }) }))
        const result = matchesCanonicalRecord(table.get(key), canonical) ? 'confirmed' : 'unavailable'
        // WP5-c: keep the read-only metadata-only reason-code index in sync. A
        // best-effort index write is non-authorizing: if it fails the durable
        // record is still confirmed and the renderer sidecar degrades to a miss.
        if (result === 'confirmed' && record.route === 'post-facts-failure' && record.failureCode !== undefined) {
          try {
            await domain.table('reasonCode').put(record.requestId, Object.freeze({ version: 1, failureCode: record.failureCode }))
          } catch {
            /* reason-code index is presentational, never authorizing */
          }
        }
        return result
      } catch {
        return 'unavailable'
      }
    })
    const tail = operation.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    try {
      return await operation
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
