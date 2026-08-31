import { parseGateDecisionRecord } from './gate-pipeline.js'
import type {
  GateDecisionRecord,
  GateDecisionRecordResult,
  GateDecisionRecordStore,
} from './gate-pipeline.js'

/**
 * In-memory minimal decision-record store used for tests and pre-durable
 * development. It enforces the important conflict semantics (same ask cannot
 * confirm two different dispositions) but is NOT a production durability
 * boundary; H4 will replace this with the Storage Domain-backed store.
 */
export class InMemoryGateDecisionRecordStore implements GateDecisionRecordStore {
  private readonly confirmed = new Map<string, GateDecisionRecord>()
  private readonly bestEffort = new Map<string, GateDecisionRecord>()

  async createConfirmed(record: GateDecisionRecord): Promise<GateDecisionRecordResult> {
    record = parseGateDecisionRecord(record)
    const key = this.keyFor(record)
    const existing = this.confirmed.get(key)
    if (existing !== undefined) {
      return this.sameDecision(existing, record) ? 'confirmed' : 'conflict'
    }
    const priorBestEffort = this.bestEffort.get(key)
    if (priorBestEffort !== undefined && !this.sameDecision(priorBestEffort, record)) {
      return 'conflict'
    }
    this.confirmed.set(key, { ...record })
    return 'confirmed'
  }

  async recordBestEffort(record: GateDecisionRecord): Promise<void> {
    record = parseGateDecisionRecord(record)
    const key = this.keyFor(record)
    if (this.confirmed.has(key)) return
    const existing = this.bestEffort.get(key)
    if (existing === undefined) {
      this.bestEffort.set(key, { ...record })
      return
    }
    if (!this.sameDecision(existing, record)) {
      throw new Error('best-effort decision record conflicts with an existing record')
    }
  }

  private keyFor(record: GateDecisionRecord): string {
    return [
      record.parentSessionId,
      record.parentLifecycleFingerprint,
      record.callId,
      record.actionHash,
      record.requestId,
    ].join('\0')
  }

  private sameDecision(a: GateDecisionRecord, b: GateDecisionRecord): boolean {
    return a.version === b.version
      && a.route === b.route
      && a.normalizedDecision === b.normalizedDecision
      && a.pluginDisposition === b.pluginDisposition
      && a.reviewRunId === b.reviewRunId
      && a.parentSessionId === b.parentSessionId
      && a.parentLifecycleFingerprint === b.parentLifecycleFingerprint
      && a.callId === b.callId
      && a.actionHash === b.actionHash
      && a.requestId === b.requestId
      && a.generation === b.generation
      && a.policyVersion === b.policyVersion
      && a.configurationFingerprint === b.configurationFingerprint
      && a.disposition === b.disposition
      && a.reviewAttempts === b.reviewAttempts
      && a.contaminatedRotationAttempts === b.contaminatedRotationAttempts
      && a.contaminatedRotations === b.contaminatedRotations
  }
}
