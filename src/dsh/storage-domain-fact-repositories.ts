import { createHash } from 'node:crypto'
import { canonicalJson, snapshotJson } from '../domain/json.js'
import { hashAction, parseActionSnapshot } from '../domain/protocol.js'
import type { ActionSnapshot } from '../domain/protocol.js'
import {
  isApprovalEnvironmentEvidenceV1,
  parseStoredActionSnapshotV2,
  resolveStoredActionV2,
  validateDurableCatalogEvidenceV2,
  validateDurableToolCatalogCommitmentV1,
} from '../domain/dossier.js'
import type { ApprovalSnapshotRecordV1, ToolExecutionFactRecordV1, ToolExecutionFactRecordV2 } from '../domain/dossier.js'
import { canonicalSha256, isPayloadRefV1 } from '../domain/payload-ref.js'
import type { SessionLifecycleIdentityV1 } from '../domain/records.js'
import type { ApprovalSnapshotRepository, ExecutionFactRepository } from '../application/fact-repositories.js'
import { GateFailure } from '../application/gate-failure.js'
import type { StorageDomainFacility, StorageDomainHandle, StorageDomainTable } from './storage-domain-decision-record.js'

/**
 * WP9-a fact row v2: the record is bound to its row by
 * digest = 'sha256:'+sha256hex(canonicalJson(record)) instead of a second
 * full canonical string copy. Read = recompute and compare; any mismatch or
 * foreign shape reads as absent (fail closed). Legacy v1 rows
 * ({version:1, canonical, record}) are deliberately NEVER accepted: they are
 * a foreign version and would silently re-authorize pre-slim payloads.
 */
type StoredRow = { readonly version: 2; readonly digest: string; readonly record: unknown }
type StoredIndex = { readonly version: 1; readonly canonical: string; readonly session: SessionLifecycleIdentityV1; readonly keys: readonly string[] }

const factDomainSpec = Object.freeze({
  // The single host-private domain is the contract boundary. Per-lifecycle
  // index rows share their fact table because the host only offers get/put.
  name: 'approve_for_me', version: 1, layout: 'per-record',
  tables: Object.freeze({
    executions: Object.freeze({ valueSchema: Object.freeze({ parse: (value: unknown) => parseFactValue(value) }) }),
    approval_snapshots: Object.freeze({ valueSchema: Object.freeze({ parse: (value: unknown) => parseFactValue(value) }) }),
  }),
})

function storageKey(prefix: string, value: unknown): string {
  // The file backend bounds entry names at 255 bytes while canonical tuples
  // embed unbounded provider callIds and absolute cwd paths (ENAMETOOLONG).
  // Prefix-bound sha256 digests keep keys at 68 chars with collision-free
  // domain separation.
  return `${prefix}${createHash('sha256').update(prefix).update('\0').update(canonicalJson(value)).digest('hex')}`
}

function lifecycleIdentity(session: SessionLifecycleIdentityV1): readonly [string, number, number, string | null] {
  return [session.sessionId, session.sessionFormatVersion, session.createdAt, session.cwd ?? null]
}

function sameLifecycle(left: SessionLifecycleIdentityV1, right: SessionLifecycleIdentityV1): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function validSession(value: unknown): value is SessionLifecycleIdentityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Record<string, unknown>
  return typeof session.sessionId === 'string' && session.sessionId.length > 0
    && Number.isSafeInteger(session.sessionFormatVersion) && (session.sessionFormatVersion as number) >= 0
    && Number.isSafeInteger(session.createdAt) && (session.createdAt as number) >= 0
    && (session.cwd === undefined || (typeof session.cwd === 'string' && session.cwd.length > 0))
}

function validReceipt(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  switch (receipt.kind) {
    case 'continuable-child-started':
      return Object.keys(receipt).length === 3
        && typeof receipt.childSessionId === 'string' && receipt.childSessionId.length > 0
        && typeof receipt.directParentSessionId === 'string' && receipt.directParentSessionId.length > 0
    case 'foreground-run-settled':
      return Object.keys(receipt).length === 2 && typeof receipt.runId === 'string' && receipt.runId.length > 0
    case 'background-job-started':
      return Object.keys(receipt).length === 2 && typeof receipt.jobId === 'string' && receipt.jobId.length > 0
    case 'followup-delivered':
      return Object.keys(receipt).length === 2 && typeof receipt.messageId === 'string' && receipt.messageId.length > 0
    case 'interrupt-accepted':
      return Object.keys(receipt).length === 1
    default:
      return false
  }
}

function validToolOutcome(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const outcome = value as Record<string, unknown>
  if (outcome.kind === 'completed' || outcome.kind === 'tool-error') return Object.keys(outcome).length === 1
  if (outcome.kind !== 'sandbox-denied'
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(outcome.mode as string)
    || (outcome.enforcement !== undefined && outcome.enforcement !== 'full' && outcome.enforcement !== 'partial')) return false
  const keys = Object.keys(outcome)
  return keys.length === (outcome.enforcement === undefined ? 2 : 3)
    && keys.every(key => key === 'kind' || key === 'mode' || key === 'enforcement')
}

const ROW_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

function parseRow(value: unknown): StoredRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid dossier fact row')
  const row = value as Partial<StoredRow>
  // v1 rows (and every other foreign version) read as absent by design.
  if (row.version !== 2 || typeof row.digest !== 'string' || !ROW_DIGEST_PATTERN.test(row.digest)
    || row.record === undefined || row.digest !== canonicalSha256(row.record)) {
    throw new TypeError('invalid dossier fact row')
  }
  return Object.freeze({ version: 2, digest: row.digest, record: row.record })
}

function parseFactValue(value: unknown): StoredRow | StoredIndex {
  try { return parseRow(value) } catch { return parseIndex(value) }
}

function parseIndex(value: unknown): StoredIndex {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid dossier fact index')
  const index = value as Partial<StoredIndex>
  if (index.version !== 1 || typeof index.canonical !== 'string' || !validSession(index.session)
    || !Array.isArray(index.keys) || index.keys.some(key => typeof key !== 'string' || key.length === 0)
    || new Set(index.keys).size !== index.keys.length) throw new TypeError('invalid dossier fact index')
  const canonical = canonicalJson({ session: index.session, keys: index.keys })
  if (index.canonical !== canonical) throw new TypeError('invalid dossier fact index')
  return Object.freeze({ version: 1, canonical, session: Object.freeze({ ...index.session }), keys: Object.freeze([...index.keys]) })
}


/**
 * WP8-c: exported strict shape-V1 guards shared by the storage repositories
 * and the seal backfill (seal-backfill.ts re-parses every listed row before
 * promoting it, so a poisoned sidecar can never reach the ledger). Same
 * predicates the create/list paths already enforced; zero behavior change.
 */
  export function isToolExecutionFactRecordV1(value: unknown): value is ToolExecutionFactRecordV1 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Partial<ToolExecutionFactRecordV1>
    if (record.version !== 1 || !validSession(record.session)
      || record.request === null || typeof record.request !== 'object' || Array.isArray(record.request)
      || record.catalogCommitment === null || typeof record.catalogCommitment !== 'object' || Array.isArray(record.catalogCommitment)
      || record.toolClassification === null || typeof record.toolClassification !== 'object' || Array.isArray(record.toolClassification)
      || record.toolClassification.descriptor === null || typeof record.toolClassification.descriptor !== 'object' || Array.isArray(record.toolClassification.descriptor)
      || record.projection === null || typeof record.projection !== 'object' || Array.isArray(record.projection)
      || record.projection.action === null || typeof record.projection.action !== 'object' || Array.isArray(record.projection.action)
      || !['model-tool-call', 'code-dispatch'].includes(record.request.kind)
      || !['tool/call', 'tool/code-dispatch-start'].includes(record.request.eventType)
      || (record.request.kind === 'model-tool-call' && record.request.eventType !== 'tool/call')
      || (record.request.kind === 'code-dispatch' && (
        record.request.eventType !== 'tool/code-dispatch-start'
        || typeof record.request.rootCallId !== 'string' || record.request.rootCallId.length === 0
        || typeof record.request.parentCallId !== 'string' || record.request.parentCallId.length === 0
        || !Number.isSafeInteger(record.request.rootRequestEventSeq) || (record.request.rootRequestEventSeq as number) < 0
        || !Number.isSafeInteger(record.request.parentRequestEventSeq) || (record.request.parentRequestEventSeq as number) < 0
        || record.request.arguments === undefined))
      || typeof record.request.callId !== 'string' || record.request.callId.length === 0
      || typeof record.request.toolName !== 'string' || record.request.toolName.length === 0
      || !Number.isSafeInteger(record.request.eventSeq) || (record.request.eventSeq as number) < 0
      || typeof record.toolClassification.classificationCatalogFingerprint !== 'string' || record.toolClassification.classificationCatalogFingerprint.length === 0
      || typeof record.projection.projectorId !== 'string' || record.projection.projectorId.length === 0
      || typeof record.projection.actionHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.projection.actionHash)
      || !Number.isSafeInteger(record.projection.observedAt) || (record.projection.observedAt as number) < 0
      || (record.terminalEvidence !== undefined && (record.terminalEvidence === null
        || typeof record.terminalEvidence !== 'object' || Array.isArray(record.terminalEvidence)
        || Object.keys(record.terminalEvidence).some(key => key !== 'isError' && key !== 'outcome' && key !== 'receipt')
        || typeof record.terminalEvidence.isError !== 'boolean'
        || !validToolOutcome(record.terminalEvidence.outcome)
        || (record.terminalEvidence.outcome.kind === 'completed' && record.terminalEvidence.isError)
        || (record.terminalEvidence.outcome.kind === 'tool-error' && !record.terminalEvidence.isError)
        || (record.terminalEvidence.receipt !== undefined
          && (record.toolClassification.descriptor.classification !== 'delegation'
            || record.terminalEvidence.outcome.kind !== 'completed'
            || !validReceipt(record.terminalEvidence.receipt)))))
      || (record.result !== undefined && (record.result === null || typeof record.result !== 'object' || Array.isArray(record.result)
        || Object.keys(record.result).some(key => key !== 'eventSeq' && key !== 'eventType' && key !== 'outcome')
        || !Number.isSafeInteger(record.result.eventSeq) || (record.result.eventSeq as number) <= record.request.eventSeq
        || (record.request.kind === 'model-tool-call' ? record.result.eventType !== 'tool/result' : record.result.eventType !== 'tool/code-dispatch')
        || !validToolOutcome(record.result.outcome)))
      || (record.delegationReceipt !== undefined && (record.result === undefined
        || record.delegationReceipt === null || typeof record.delegationReceipt !== 'object' || Array.isArray(record.delegationReceipt)
        || !sameLifecycle(record.delegationReceipt.session, record.session)
        || record.delegationReceipt.requestEventSeq !== record.request.eventSeq
        || record.delegationReceipt.callId !== record.request.callId
        || record.delegationReceipt.resultEvent?.seq !== record.result.eventSeq
        || record.delegationReceipt.resultEvent?.type !== record.result.eventType
        || record.delegationReceipt.classificationCatalogFingerprint !== record.toolClassification.classificationCatalogFingerprint
        || record.toolClassification.descriptor.classification !== 'delegation'
        || record.delegationReceipt.projectorId !== record.toolClassification.descriptor.projectorId
        || !validReceipt(record.delegationReceipt.receipt)))) return false
    let action: ActionSnapshot
    try {
      action = parseActionSnapshot(record.projection.action)
    } catch {
      return false
    }
    if (hashAction(action) !== record.projection.actionHash
      || action.toolName !== record.request.toolName
      || action.projectorId !== record.projection.projectorId) return false
    const commitment = record.catalogCommitment
    if (validateDurableToolCatalogCommitmentV1(commitment).kind !== 'ok') return false
    const dossierDescriptor = commitment.classificationCatalog.descriptors.find(item => item.toolName === record.request!.toolName)
    const approvalDescriptor = commitment.approvalCatalog.descriptors.find(item => item.toolName === record.request!.toolName)
    const rootEventSeq = record.request.kind === 'model-tool-call' ? record.request.eventSeq : record.request.rootRequestEventSeq
    if (commitment.requestHeaderEventSeq >= rootEventSeq || rootEventSeq > record.request.eventSeq
      || (record.request.kind === 'code-dispatch'
        && (!Number.isSafeInteger(record.request.parentRequestEventSeq)
          || record.request.parentRequestEventSeq < rootEventSeq
          || record.request.parentRequestEventSeq >= record.request.eventSeq))
      || commitment.classificationCatalog.fingerprint !== record.toolClassification.classificationCatalogFingerprint
      || dossierDescriptor === undefined || approvalDescriptor === undefined
      || canonicalJson(dossierDescriptor) !== canonicalJson(record.toolClassification.descriptor)
      || dossierDescriptor.toolSchemaFingerprint !== approvalDescriptor.toolSchemaFingerprint
      || record.projection.projectorId !== approvalDescriptor.actionProjectorId) return false
    try {
      snapshotJson(record.projection.action)
      if (record.request.kind === 'code-dispatch') snapshotJson(record.request.arguments)
      if (record.terminalEvidence !== undefined) snapshotJson(record.terminalEvidence)
      if (record.delegationReceipt !== undefined) snapshotJson(record.delegationReceipt)
      return true
    } catch {
      return false
    }
  }

  /**
   * WP9-a strict shape-V2 guard. Same fail-closed discipline as the V1 guard:
   * every cross-field binding that does not need unbounded payload bodies is
   * re-derived here (catalog fingerprints, descriptor byte-match, projector
   * binding, receipt correlation, terminal-evidence consistency). The two
   * payload-deferring bindings v1 enforced at rest — hashAction(action) ===
   * actionHash and the schema-body shape/binding checks — are covered jointly
   * by (a) the row digest (any stored-record tamper reads as absent), (b) the
   * stored actionHash being a sha256 commitment re-verified against live event
   * arguments at every consumption point (resolveStoredActionV2), and (c) the
   * live request/header re-bind through wireSchemasDigest.
   */
  export function isToolExecutionFactRecordV2(value: unknown): value is ToolExecutionFactRecordV2 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Partial<ToolExecutionFactRecordV2>
    if (record.version !== 2 || !validSession(record.session)
      || record.request === null || typeof record.request !== 'object' || Array.isArray(record.request)
      || record.catalogEvidence === null || typeof record.catalogEvidence !== 'object' || Array.isArray(record.catalogEvidence)
      || record.toolClassification === null || typeof record.toolClassification !== 'object' || Array.isArray(record.toolClassification)
      || record.toolClassification.descriptor === null || typeof record.toolClassification.descriptor !== 'object' || Array.isArray(record.toolClassification.descriptor)
      || record.projection === null || typeof record.projection !== 'object' || Array.isArray(record.projection)
      || record.projection.action === null || typeof record.projection.action !== 'object' || Array.isArray(record.projection.action)
      || !['model-tool-call', 'code-dispatch'].includes(record.request.kind)
      || !['tool/call', 'tool/code-dispatch-start'].includes(record.request.eventType)
      || (record.request.kind === 'model-tool-call' && record.request.eventType !== 'tool/call')
      || (record.request.kind === 'code-dispatch' && (
        record.request.eventType !== 'tool/code-dispatch-start'
        || typeof record.request.rootCallId !== 'string' || record.request.rootCallId.length === 0
        || typeof record.request.parentCallId !== 'string' || record.request.parentCallId.length === 0
        || !Number.isSafeInteger(record.request.rootRequestEventSeq) || (record.request.rootRequestEventSeq as number) < 0
        || !Number.isSafeInteger(record.request.parentRequestEventSeq) || (record.request.parentRequestEventSeq as number) < 0
        || !isPayloadRefV1(record.request.arguments)))
      || typeof record.request.callId !== 'string' || record.request.callId.length === 0
      || typeof record.request.toolName !== 'string' || record.request.toolName.length === 0
      || !Number.isSafeInteger(record.request.eventSeq) || (record.request.eventSeq as number) < 0
      || typeof record.toolClassification.classificationCatalogFingerprint !== 'string' || record.toolClassification.classificationCatalogFingerprint.length === 0
      || typeof record.projection.projectorId !== 'string' || record.projection.projectorId.length === 0
      || typeof record.projection.actionHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.projection.actionHash)
      || !Number.isSafeInteger(record.projection.observedAt) || (record.projection.observedAt as number) < 0
      || (record.terminalEvidence !== undefined && (record.terminalEvidence === null
        || typeof record.terminalEvidence !== 'object' || Array.isArray(record.terminalEvidence)
        || Object.keys(record.terminalEvidence).some(key => key !== 'isError' && key !== 'outcome' && key !== 'receipt')
        || typeof record.terminalEvidence.isError !== 'boolean'
        || !validToolOutcome(record.terminalEvidence.outcome)
        || (record.terminalEvidence.outcome.kind === 'completed' && record.terminalEvidence.isError)
        || (record.terminalEvidence.outcome.kind === 'tool-error' && !record.terminalEvidence.isError)
        || (record.terminalEvidence.receipt !== undefined
          && (record.toolClassification.descriptor.classification !== 'delegation'
            || record.terminalEvidence.outcome.kind !== 'completed'
            || !validReceipt(record.terminalEvidence.receipt)))))
      || (record.result !== undefined && (record.result === null || typeof record.result !== 'object' || Array.isArray(record.result)
        || Object.keys(record.result).some(key => key !== 'eventSeq' && key !== 'eventType' && key !== 'outcome')
        || !Number.isSafeInteger(record.result.eventSeq) || (record.result.eventSeq as number) <= record.request.eventSeq
        || (record.request.kind === 'model-tool-call' ? record.result.eventType !== 'tool/result' : record.result.eventType !== 'tool/code-dispatch')
        || !validToolOutcome(record.result.outcome)))
      || (record.delegationReceipt !== undefined && (record.result === undefined
        || record.delegationReceipt === null || typeof record.delegationReceipt !== 'object' || Array.isArray(record.delegationReceipt)
        || !sameLifecycle(record.delegationReceipt.session, record.session)
        || record.delegationReceipt.requestEventSeq !== record.request.eventSeq
        || record.delegationReceipt.callId !== record.request.callId
        || record.delegationReceipt.resultEvent?.seq !== record.result.eventSeq
        || record.delegationReceipt.resultEvent?.type !== record.result.eventType
        || record.delegationReceipt.classificationCatalogFingerprint !== record.toolClassification.classificationCatalogFingerprint
        || record.toolClassification.descriptor.classification !== 'delegation'
        || record.delegationReceipt.projectorId !== record.toolClassification.descriptor.projectorId
        || !validReceipt(record.delegationReceipt.receipt)))) return false
    let action: ReturnType<typeof parseStoredActionSnapshotV2>
    try {
      action = parseStoredActionSnapshotV2(record.projection.action)
    } catch {
      return false
    }
    if (action.toolName !== record.request.toolName || action.projectorId !== record.projection.projectorId) return false
    // When the arguments payload is inline the full action is recoverable at
    // rest, so the v1 actionHash recompute is preserved verbatim. For digest
    // refs the hash is an opaque commitment verified at consumption time
    // against live event arguments (every reader does resolveStoredActionV2
    // before authorizing anything).
    if (action.arguments.kind === 'inline') {
      const resolved = resolveStoredActionV2(action, action.arguments.value)
      if (resolved === undefined || hashAction(resolved) !== record.projection.actionHash) return false
    }
    const evidence = record.catalogEvidence
    if (validateDurableCatalogEvidenceV2(evidence).kind !== 'ok') return false
    const dossierDescriptor = evidence.classificationCatalog.descriptors.find(item => item.toolName === record.request!.toolName)
    const approvalDescriptor = evidence.approvalCatalog.descriptors.find(item => item.toolName === record.request!.toolName)
    const rootEventSeq = record.request.kind === 'model-tool-call' ? record.request.eventSeq : record.request.rootRequestEventSeq
    if (evidence.requestHeaderEventSeq >= rootEventSeq || rootEventSeq > record.request.eventSeq
      || (record.request.kind === 'code-dispatch'
        && (!Number.isSafeInteger(record.request.parentRequestEventSeq)
          || record.request.parentRequestEventSeq < rootEventSeq
          || record.request.parentRequestEventSeq >= record.request.eventSeq))
      || evidence.classificationCatalog.fingerprint !== record.toolClassification.classificationCatalogFingerprint
      || dossierDescriptor === undefined || approvalDescriptor === undefined
      || canonicalJson(dossierDescriptor) !== canonicalJson(record.toolClassification.descriptor)
      || dossierDescriptor.toolSchemaFingerprint !== approvalDescriptor.toolSchemaFingerprint
      || record.projection.projectorId !== approvalDescriptor.actionProjectorId) return false
    try {
      if (record.terminalEvidence !== undefined) snapshotJson(record.terminalEvidence)
      if (record.delegationReceipt !== undefined) snapshotJson(record.delegationReceipt)
      return true
    } catch {
      return false
    }
  }
  export function isApprovalSnapshotRecordV1(value: unknown): value is ApprovalSnapshotRecordV1 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Partial<ApprovalSnapshotRecordV1>
    if (record.version !== 1 || !validSession(record.session) || typeof record.approvalRequestId !== 'string' || record.approvalRequestId.length === 0
      || !Number.isSafeInteger(record.approvalAskedSeq) || (record.approvalAskedSeq as number) < 0
      || record.execution === null || typeof record.execution !== 'object' || Array.isArray(record.execution)
      || typeof record.execution.callId !== 'string' || record.execution.callId.length === 0
      || typeof record.execution.toolName !== 'string' || record.execution.toolName.length === 0
      || !Number.isSafeInteger(record.execution.requestEventSeq) || (record.execution.requestEventSeq as number) < 0
      || (record.approvalAskedSeq as number) <= record.execution.requestEventSeq
      || typeof record.execution.actionHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.execution.actionHash)
      || typeof record.execution.classificationCatalogFingerprint !== 'string' || record.execution.classificationCatalogFingerprint.length === 0
      || typeof record.execution.projectorId !== 'string' || record.execution.projectorId.length === 0
      || !isApprovalEnvironmentEvidenceV1(record.environment)) return false
    return true
  }
/**
 * Host-private, create-once Storage Domain sidecars. Every read validates the
 * canonical envelope and exact lifecycle; unavailable or poisoned storage is
 * represented as an empty lookup, which remains non-authorizing upstream.
 */
export class DshStorageDomainFactRepositories {
  private readonly tails = new Map<string, Promise<void>>()
  private admissionOpen = true
  private opening: Promise<StorageDomainHandle> | undefined

  constructor(private readonly facility: StorageDomainFacility | undefined) {}

  async drain(): Promise<void> {
    this.admissionOpen = false
    await Promise.all(this.tails.values())
    const opening = this.opening
    if (opening === undefined) return
    const domain = await opening.catch(() => undefined)
    if (domain !== undefined) await domain.close()
  }

  async create(record: ToolExecutionFactRecordV2): Promise<'created' | 'identical' | 'conflict'> {
    if (!this.validExecution(record)) return 'conflict'
    return this.createOnce('executions', 'executions', record.session, this.executionKey(record.session, record.request.callId, record.request.eventSeq), record)
  }

  async list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ToolExecutionFactRecordV2[]> {
    const rows = await this.listRows(
      'executions',
      'executions',
      session,
      row => this.validExecution(row) && sameLifecycle(row.session, session),
      signal,
    )
    return Object.freeze(rows === undefined ? [] : rows as ToolExecutionFactRecordV2[])
  }

  async get(input: { session: SessionLifecycleIdentityV1; callId: string; requestEventSeq: number }): Promise<ToolExecutionFactRecordV2 | undefined> {
    const row = await this.readRow('executions', this.executionKey(input.session, input.callId, input.requestEventSeq))
    if (!this.validExecution(row) || !sameLifecycle(row.session, input.session)
      || row.request.callId !== input.callId || row.request.eventSeq !== input.requestEventSeq) return undefined
    return row
  }

  async stageTerminal(input: { readonly session: SessionLifecycleIdentityV1; readonly callId: string; readonly requestEventSeq: number; readonly terminalEvidence: NonNullable<ToolExecutionFactRecordV2['terminalEvidence']> }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.executionKey(input.session, input.callId, input.requestEventSeq)
    return this.serial(input.session, async () => {
      const existing = await this.readRow('executions', key)
      if (!this.validExecution(existing) || !sameLifecycle(existing.session, input.session)
        || existing.request.callId !== input.callId || existing.request.eventSeq !== input.requestEventSeq) return 'missing'
      const updated: ToolExecutionFactRecordV2 = Object.freeze({
        ...existing,
        terminalEvidence: Object.freeze({
          isError: input.terminalEvidence.isError,
          outcome: Object.freeze({ ...input.terminalEvidence.outcome }),
          ...input.terminalEvidence.receipt === undefined
            ? {}
            : { receipt: Object.freeze({ ...input.terminalEvidence.receipt }) },
        }),
      })
      if (!this.validExecution(updated)) return 'conflict'
      if (existing.terminalEvidence !== undefined) {
        return canonicalJson(existing) === canonicalJson(updated) ? 'identical' : 'conflict'
      }
      return await this.replaceExact('executions', key, updated) ? 'updated' : 'conflict'
    })
  }

  async attachResult(input: { readonly session: SessionLifecycleIdentityV1; readonly callId: string; readonly requestEventSeq: number; readonly result: NonNullable<ToolExecutionFactRecordV2['result']>; readonly delegationReceipt?: NonNullable<ToolExecutionFactRecordV2['delegationReceipt']> }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.executionKey(input.session, input.callId, input.requestEventSeq)
    return this.serial(input.session, async () => {
      const existing = await this.readRow('executions', key)
      if (!this.validExecution(existing) || !sameLifecycle(existing.session, input.session)
        || existing.request.callId !== input.callId || existing.request.eventSeq !== input.requestEventSeq) return 'missing'
      const updated: ToolExecutionFactRecordV2 = Object.freeze({
        ...existing,
        result: Object.freeze({ ...input.result }),
        ...input.delegationReceipt === undefined ? {} : { delegationReceipt: Object.freeze({ ...input.delegationReceipt }) },
      })
      if (!this.validExecution(updated)) return 'conflict'
      if (existing.result !== undefined || existing.delegationReceipt !== undefined) {
        return canonicalJson(existing) === canonicalJson(updated) ? 'identical' : 'conflict'
      }
      return await this.replaceExact('executions', key, updated) ? 'updated' : 'conflict'
    })
  }

  async createApproval(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'> {
    if (!this.validApproval(record)) return 'conflict'
    return this.createOnce('approval_snapshots', 'approval_snapshots', record.session, this.approvalKey(record.session, record.approvalRequestId, record.approvalAskedSeq), record)
  }

  async listApprovals(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ApprovalSnapshotRecordV1[]> {
    const rows = await this.listRows(
      'approval_snapshots',
      'approval_snapshots',
      session,
      row => this.validApproval(row) && sameLifecycle(row.session, session),
      signal,
    )
    return Object.freeze(rows === undefined ? [] : rows as ApprovalSnapshotRecordV1[])
  }

  async getApproval(input: { session: SessionLifecycleIdentityV1; approvalRequestId: string; approvalAskedSeq: number }): Promise<ApprovalSnapshotRecordV1 | undefined> {
    const row = await this.readRow('approval_snapshots', this.approvalKey(input.session, input.approvalRequestId, input.approvalAskedSeq))
    if (!this.validApproval(row) || !sameLifecycle(row.session, input.session)
      || row.approvalRequestId !== input.approvalRequestId || row.approvalAskedSeq !== input.approvalAskedSeq) return undefined
    return row
  }

  // Interface method names overlap only at create/list/get, so route based on
  // the discriminating record/input fields without exposing a second facade.
  async createSnapshot(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'> { return this.createApproval(record) }
  async listSnapshot(session: SessionLifecycleIdentityV1): Promise<readonly ApprovalSnapshotRecordV1[]> { return this.listApprovals(session) }
  async getSnapshot(input: { session: SessionLifecycleIdentityV1; approvalRequestId: string; approvalAskedSeq: number }): Promise<ApprovalSnapshotRecordV1 | undefined> { return this.getApproval(input) }

  private async createOnce(tableName: string, indexName: string, session: SessionLifecycleIdentityV1, key: string, record: unknown): Promise<'created' | 'identical' | 'conflict'> {
    return this.serial(session, async () => {
      if (!this.admissionOpen) return 'conflict'
      const domain = await this.domain()
      if (domain === undefined) return 'conflict'
      try {
        const table = domain.table(tableName)
        const canonical = canonicalJson(record)
        const existing = table.get(key)
        if (existing !== undefined) {
          const row = parseRow(existing)
          if (canonicalJson(row.record) !== canonical) return 'conflict'
          return await this.index(indexName, session, key) ? 'identical' : 'conflict'
        }
        await table.put(key, Object.freeze({ version: 2, digest: canonicalSha256(record), record: Object.freeze({ ...(record as object) }) }))
        const confirmed = await this.readRow(tableName, key)
        if (confirmed === undefined || canonicalJson(confirmed) !== canonical) return 'conflict'
        if (!await this.index(indexName, session, key)) return 'conflict'
        return 'created'
      } catch (cause: unknown) {
        if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') console.error('[approve-for-me fact-repo] create-once failed', String(cause), (cause as { stack?: string })?.stack ?? '')
        return 'conflict'
      }
    })
  }

  private async replaceExact(tableName: string, key: string, record: unknown): Promise<boolean> {
    if (!this.admissionOpen) return false
    const domain = await this.domain()
    if (domain === undefined) return false
    try {
      const canonical = canonicalJson(record)
      await domain.table(tableName).put(key, Object.freeze({ version: 2, digest: canonicalSha256(record), record: Object.freeze({ ...(record as object) }) }))
      const confirmed = await this.readRow(tableName, key)
      return confirmed !== undefined && canonicalJson(confirmed) === canonical
    } catch { return false }
  }

  private async index(indexName: string, session: SessionLifecycleIdentityV1, key: string): Promise<boolean> {
    const domain = await this.domain()
    if (domain === undefined) return false
    const indexKey = this.lifecycleKey(session)
    const table = domain.table(indexName)
    const existing = table.get(indexKey)
    let keys: readonly string[]
    if (existing === undefined) keys = [key]
    else {
      const parsed = parseIndex(existing)
      if (!sameLifecycle(parsed.session, session)) return false
      if (parsed.keys.includes(key)) return true
      keys = [...parsed.keys, key]
    }
    const canonical = canonicalJson({ session, keys })
    await table.put(indexKey, Object.freeze({ version: 1, canonical, session: Object.freeze({ ...session }), keys: Object.freeze([...keys]) }))
    const confirmed = parseIndex(table.get(indexKey))
    return confirmed.canonical === canonical
  }

  private async listRows(
    tableName: string,
    indexName: string,
    session: SessionLifecycleIdentityV1,
    validate: (row: unknown) => boolean,
    signal?: AbortSignal,
  ): Promise<readonly unknown[] | undefined> {
    if (!this.admissionOpen) throw new GateFailure('lifecycle', 'approval fact storage is draining')
    try {
      signal?.throwIfAborted()
      const domain = await this.domain()
      if (domain === undefined) throw new GateFailure('retryable-capability', 'approval fact storage is unavailable')
      const index = domain.table(indexName).get(this.lifecycleKey(session))
      if (index === undefined) return Object.freeze([])
      const parsed = parseIndex(index)
      if (!sameLifecycle(parsed.session, session)) return undefined
      const rows: unknown[] = []
      for (const key of parsed.keys) {
        signal?.throwIfAborted()
        const row = await this.readRow(tableName, key)
        if (row === undefined || !validate(row)) return undefined
        rows.push(row)
        // Reads and full schema/canonical validation both yield as one batch.
        if (rows.length % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      return Object.freeze(rows)
    } catch (cause: unknown) {
      throw this.readFailure(cause)
    }
  }

  private async readRow(tableName: string, key: string): Promise<unknown | undefined> {
    try {
      const domain = await this.domain()
      if (domain === undefined) throw new GateFailure('retryable-capability', 'approval fact storage is unavailable')
      const stored = domain.table(tableName).get(key)
      return stored === undefined ? undefined : parseRow(stored).record
    } catch (cause: unknown) {
      throw this.readFailure(cause)
    }
  }

  private readFailure(cause: unknown): GateFailure {
    if (cause instanceof GateFailure) return cause
    if (cause instanceof TypeError) return new GateFailure('integrity', 'approval fact storage contains an invalid durable record', { cause })
    return new GateFailure('retryable-capability', 'approval fact storage read failed', { cause })
  }

  private async domain(): Promise<StorageDomainHandle | undefined> {
    if (this.facility === undefined) return undefined
    const opening = this.opening ?? this.facility.open(factDomainSpec)
    this.opening = opening
    try {
      return await opening
    } catch (cause: unknown) {
      if (this.opening === opening) this.opening = undefined
      throw new GateFailure('retryable-capability', 'approval fact storage is temporarily unavailable', { cause })
    }
  }

  private serial<T>(session: SessionLifecycleIdentityV1, operation: () => Promise<T>): Promise<T> {
    const key = this.lifecycleKey(session)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    return result.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
  }

  private lifecycleKey(session: SessionLifecycleIdentityV1): string { return storageKey('i1_', lifecycleIdentity(session)) }
  private executionKey(session: SessionLifecycleIdentityV1, callId: string, seq: number): string { return storageKey('e1_', [...lifecycleIdentity(session), callId, seq]) }
  private approvalKey(session: SessionLifecycleIdentityV1, requestId: string, seq: number): string { return storageKey('a1_', [...lifecycleIdentity(session), requestId, seq]) }

  private validExecution(value: unknown): value is ToolExecutionFactRecordV2 { return isToolExecutionFactRecordV2(value) }

  private validApproval(value: unknown): value is ApprovalSnapshotRecordV1 { return isApprovalSnapshotRecordV1(value) }
}

/** Facades retain the existing distinct application repository ports. */
export class DshStorageDomainExecutionFactRepository implements ExecutionFactRepository {
  constructor(private readonly shared: DshStorageDomainFactRepositories) {}
  list(session: SessionLifecycleIdentityV1, signal?: AbortSignal) { return this.shared.list(session, signal) }
  create(record: ToolExecutionFactRecordV2) { return this.shared.create(record) }
  stageTerminal(input: Parameters<ExecutionFactRepository['stageTerminal']>[0]) { return this.shared.stageTerminal(input) }
  attachResult(input: Parameters<ExecutionFactRepository['attachResult']>[0]) { return this.shared.attachResult(input) }
  get(input: Parameters<ExecutionFactRepository['get']>[0]) { return this.shared.get(input) }
}

export class DshStorageDomainApprovalSnapshotRepository implements ApprovalSnapshotRepository {
  constructor(private readonly shared: DshStorageDomainFactRepositories) {}
  list(session: SessionLifecycleIdentityV1, signal?: AbortSignal) { return this.shared.listApprovals(session, signal) }
  create(record: ApprovalSnapshotRecordV1) { return this.shared.createApproval(record) }
  get(input: Parameters<ApprovalSnapshotRepository['get']>[0]) { return this.shared.getApproval(input) }
}
