import { createHash } from 'node:crypto'
import { canonicalJson } from '../domain/json.js'
import { parseGateDecisionRecord } from '../application/gate-pipeline.js'
import type {
  GateDecisionRecord,
  GateDecisionRecordResult,
  GateDecisionRecordStore,
} from '../application/gate-pipeline.js'

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
          return value as StoredGateDecisionRecordV1
        },
      }),
    }),
  }),
})

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
          const row = existing as Partial<StoredGateDecisionRecordV1>
          return row.version === 1 && row.canonical === canonical ? 'confirmed' : 'conflict'
        }
        await table.put(key, Object.freeze({ version: 1, canonical, record: Object.freeze({ ...record }) }))
        return 'confirmed'
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
