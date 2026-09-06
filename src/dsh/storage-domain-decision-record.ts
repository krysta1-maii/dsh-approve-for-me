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
  /**
   * WP9-b: verified alpha.1 capability used by the fact-retention prune.
   * Deleting an absent key is a no-op. The union return models both a
   * synchronous host implementation and a promise-based one; callers await.
   */
  delete(key: string): void | Promise<void>
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

/**
 * WP10-d: durable-audit write failures are deliberately non-authorizing and are
 * swallowed upstream (the gate must never convert an audit failure into an
 * authorization decision), which also makes them invisible. With the debug flag
 * on, each failure point logs ONE bounded metadata line — route, normalized
 * outcome, stage and the error name plus a truncated message (at most 200
 * chars). Live diagnosis needs the backend's own wording, so the message may
 * embed backend keys/paths; the line never contains a packet, action,
 * rationale or hash. Debug-gated (DSH_APPROVE_FOR_ME_DEBUG=1), stderr-only,
 * and never influences a branch.
 */
function debugRecordWriteFailure(stage: string, record: unknown, error?: unknown): void {
  if (process.env.DSH_APPROVE_FOR_ME_DEBUG !== '1') return
  const row = (record === null || typeof record !== 'object' ? {} : record) as Record<string, unknown>
  const field = (key: string): string | undefined => typeof row[key] === 'string' ? row[key] as string : undefined
  const raw = error instanceof Error ? error.message : error === undefined ? undefined : String(error)
  // 200-char bound: the message may carry backend keys/paths; keep the line
  // recognizable without ever unbounding it.
  const message = raw === undefined ? undefined : raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
  console.error('[approve-for-me decision-record]', JSON.stringify({
    stage,
    route: field('route'),
    normalizedDecision: field('normalizedDecision'),
    pluginDisposition: field('pluginDisposition'),
    failureStage: field('failureStage'),
    error: message,
  }))
}

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
      : facility.open(decisionRecordDomainSpec).catch((error: unknown) => {
          // WP10-d: an unopened domain turns every later write into a silent
          // 'unavailable'; surface it under the debug flag only.
          debugRecordWriteFailure('domain-open-failed', undefined, error)
          return undefined
        })
  }

  async createConfirmed(record: GateDecisionRecord): Promise<GateDecisionRecordResult> {
    return this.write(record)
  }

  async recordBestEffort(record: GateDecisionRecord): Promise<void> {
    const result = await this.write(record)
    // WP10-d: 'unavailable' resolves silently by design (audit must not
    // authorize); the debug line inside write() is the only observability.
    if (result === 'conflict') {
      debugRecordWriteFailure('best-effort-conflict', record)
      throw new Error('durable decision record conflicts with an existing record')
    }
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
    if (!this.admissionOpen) {
      debugRecordWriteFailure('admission-closed', record)
      return 'unavailable'
    }
    try { record = parseGateDecisionRecord(record) } catch (error) {
      debugRecordWriteFailure('record-invalid', record, error)
      return 'unavailable'
    }
    const key = recordKey(record)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const operation = previous.then(async (): Promise<GateDecisionRecordResult> => {
      try {
        if (!this.admissionOpen) {
          debugRecordWriteFailure('admission-closed-in-lane', record)
          return 'unavailable'
        }
        const domain = await this.ready
        if (domain === undefined) {
          debugRecordWriteFailure('domain-unavailable', record)
          return 'unavailable'
        }
        const table = domain.table('records')
        const canonical = canonicalJson(record)
        const existing = table.get(key)
        if (existing !== undefined) {
          if (matchesCanonicalRecord(existing, canonical)) return 'confirmed'
          debugRecordWriteFailure('conflict-with-existing', record)
          return 'conflict'
        }
        await table.put(key, Object.freeze({ version: 1, canonical, record: Object.freeze({ ...record }) }))
        let result: GateDecisionRecordResult = 'confirmed'
        if (!matchesCanonicalRecord(table.get(key), canonical)) {
          debugRecordWriteFailure('write-unverified', record)
          result = 'unavailable'
        }
        // WP5-c: keep the read-only metadata-only reason-code index in sync. A
        // best-effort index write is non-authorizing: if it fails the durable
        // record is still confirmed and the renderer sidecar degrades to a miss.
        if (result === 'confirmed' && record.route === 'post-facts-failure' && record.failureCode !== undefined) {
          try {
            await domain.table('reasonCode').put(record.requestId, Object.freeze({ version: 1, failureCode: record.failureCode }))
          } catch (error) {
            /* reason-code index is presentational, never authorizing */
            debugRecordWriteFailure('reason-code-index', record, error)
          }
        }
        return result
      } catch (error) {
        debugRecordWriteFailure('storage-error', record, error)
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
