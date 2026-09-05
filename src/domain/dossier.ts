import { createHash } from 'node:crypto'
import { canonicalJson, snapshotJson } from './json.js'
import type { JsonValue } from './json.js'
import { hashGuardianDossier } from './records.js'
import type { SessionLifecycleIdentityV1 } from './records.js'
import type { ActionSnapshot, RequestedPermission } from './protocol.js'
import { createActionSnapshot, hashAction } from './protocol.js'
import { canonicalSha256, isPayloadRefV1, payloadRefMatchesLive, toPayloadRef } from './payload-ref.js'
import type { PayloadRefV1 } from './payload-ref.js'
import { fingerprintApprovalToolCatalogV1 } from '../approval-gate/catalog.js'
import type { ApprovalToolCatalog } from '../approval-gate/catalog.js'

export interface EventRefV1 {
  readonly seq: number
  readonly type: string
  readonly turn?: number
  readonly step?: number
}

export interface DossierFreezeV1 {
  readonly parent: SessionLifecycleIdentityV1
  readonly throughSeq: number
  readonly currentTurn: number
  readonly currentStep: number
  readonly frozenAt: number
}

/**
 * D1 top-level dossier shape. Sections are still represented as canonical JSON
 * in this stage; the source-backed compiler will progressively subtype them.
 */
export interface DossierCompletenessV1 {
  readonly complete: true
  readonly sourceThroughSeq: number
  readonly omissions: readonly []
}

export interface GuardianDossierV1 {
  readonly version: 1
  readonly kind: 'guardian-dossier'
  readonly freeze: DossierFreezeV1
  readonly environment: JsonValue
  readonly instructions: JsonValue
  readonly interaction: JsonValue
  readonly currentTurnTools: JsonValue
  readonly pendingApproval: JsonValue
  readonly completeness: DossierCompletenessV1
}

const sourceVerifiedDossierV1Brand: unique symbol = Symbol('dsh-approve-for-me/source-verified-dossier-v1')

/** Module-private compiler brand; never serialized or recoverable from JSON. */
export interface SourceVerifiedDossierV1 {
  readonly dossier: GuardianDossierV1
  readonly dossierHash: string
  readonly [sourceVerifiedDossierV1Brand]: true
}

export interface ApprovalReviewPacketCodecV1 {
  create(input: {
    readonly request: unknown
    readonly verified: SourceVerifiedDossierV1
  }): unknown
  parse(input: unknown): {
    readonly packet: unknown
    readonly assurance: 'internal-consistency-only'
  }
}

export function assertDossierShape(input: unknown): GuardianDossierV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dossier must be an object')
  }
  const value = input as Record<string, unknown>
  if (value.version !== 1) throw new TypeError('dossier.version must be 1')
  if (value.kind !== 'guardian-dossier') throw new TypeError('dossier.kind must be guardian-dossier')
  if (value.freeze === null || typeof value.freeze !== 'object' || Array.isArray(value.freeze)) {
    throw new TypeError('dossier.freeze must be an object')
  }
  const freeze = value.freeze as Record<string, unknown>
  if (freeze.parent === null || typeof freeze.parent !== 'object' || Array.isArray(freeze.parent)) {
    throw new TypeError('dossier.freeze.parent must be an object')
  }
  const parent = freeze.parent as Record<string, unknown>
  if (typeof parent.sessionId !== 'string' || parent.sessionId.length === 0
    || !Number.isSafeInteger(parent.sessionFormatVersion) || (parent.sessionFormatVersion as number) < 0
    || !Number.isSafeInteger(parent.createdAt) || (parent.createdAt as number) < 0
    || (parent.cwd !== undefined && (typeof parent.cwd !== 'string' || parent.cwd.length === 0))) {
    throw new TypeError('dossier.freeze.parent must carry valid sessionId/sessionFormatVersion/createdAt/cwd')
  }
  for (const key of ['throughSeq', 'currentTurn', 'currentStep', 'frozenAt'] as const) {
    if (!Number.isSafeInteger(freeze[key]) || (freeze[key] as number) < 0) {
      throw new TypeError(`dossier.freeze.${key} must be a non-negative safe integer`)
    }
  }
  for (const key of ['environment', 'instructions', 'interaction', 'currentTurnTools', 'pendingApproval'] as const) {
    if (value[key] === undefined) throw new TypeError(`dossier.${key} is required`)
    canonicalJson(value[key]) // rejects non-canonical JSON
  }
  const completeness = value.completeness
  if (completeness === null || typeof completeness !== 'object' || Array.isArray(completeness)) {
    throw new TypeError('dossier.completeness must be an object')
  }
  const sourceThroughSeq = (completeness as Record<string, unknown>).sourceThroughSeq
  const omissions = (completeness as Record<string, unknown>).omissions
  if ((completeness as Record<string, unknown>).complete !== true
    || !Number.isSafeInteger(sourceThroughSeq) || (sourceThroughSeq as number) < 0
    || sourceThroughSeq !== freeze.throughSeq || !Array.isArray(omissions) || omissions.length !== 0) {
    throw new TypeError('dossier.completeness must be a complete empty-omission snapshot through freeze')
  }
  return Object.freeze({
    version: 1,
    kind: 'guardian-dossier',
    freeze: Object.freeze({
      parent: Object.freeze({
        sessionId: parent.sessionId as string,
        sessionFormatVersion: parent.sessionFormatVersion as number,
        createdAt: parent.createdAt as number,
        ...(parent.cwd === undefined ? {} : { cwd: parent.cwd as string }),
      }),
      throughSeq: freeze.throughSeq as number,
      currentTurn: freeze.currentTurn as number,
      currentStep: freeze.currentStep as number,
      frozenAt: freeze.frozenAt as number,
    }),
    environment: value.environment as JsonValue,
    instructions: value.instructions as JsonValue,
    interaction: value.interaction as JsonValue,
    currentTurnTools: value.currentTurnTools as JsonValue,
    pendingApproval: value.pendingApproval as JsonValue,
    completeness: Object.freeze({ complete: true as const, sourceThroughSeq: sourceThroughSeq as number, omissions: Object.freeze([]) as readonly [] }),
  })
}

export function recomputeDossierHash(dossier: GuardianDossierV1): string {
  return hashGuardianDossier(dossier)
}

/**
 * Create a SourceVerifiedDossierV1 in this package's compiler boundary. The
 * brand is still module-scoped at the type level; this function exists so the
 * application compiler can seal a fully validated dossier.
 */
export function sealSourceVerifiedDossier(dossier: GuardianDossierV1): SourceVerifiedDossierV1 {
  const validated = assertDossierShape(dossier)
  const dossierHash = hashGuardianDossier(validated)
  return Object.freeze({ dossier: validated, dossierHash, [sourceVerifiedDossierV1Brand]: true }) as SourceVerifiedDossierV1
}

export interface InstructionMessageV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly source: {
    readonly kind: string
    readonly form: 'instructions'
    readonly baseline?: boolean
    readonly baselineIdentity?: string
    readonly changes?: readonly JsonValue[]
  }
  readonly content: readonly JsonValue[]
}

export interface InstructionSectionV1 {
  readonly messages: readonly InstructionMessageV1[]
}

export interface NativeToolRequestRefV1 {
  readonly kind: 'model-tool-call'
  readonly issuedIn: EventRefV1
  readonly blockIndex: number
  readonly callId: string
  readonly toolName: string
  readonly rawArguments: string
  readonly callEvent?: EventRefV1
}

export interface CodeDispatchRequestRefV1 {
  readonly kind: 'code-dispatch'
  readonly dispatchStart: EventRefV1
  readonly rootCallId: string
  readonly parentCallId: string
  readonly callId: string
  readonly toolName: string
  readonly arguments: JsonValue
}

export type ToolRequestRefV1 = NativeToolRequestRefV1 | CodeDispatchRequestRefV1

export interface ToolRequestKeyV1 {
  readonly callId: string
  readonly requestEventSeq: number
}

export interface ProcessTailV1 {
  readonly exitCode: number | null
  readonly signal: string | null
}

export type ToolAttemptOutcomeV1 =
  | { readonly kind: 'not-started'; readonly reason: 'queued' | 'aborted-before-dispatch' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'background-launched' }
  | {
      readonly kind: 'approval-not-granted'
      readonly outcome: 'rejected' | 'cancelled' | 'unavailable'
      readonly effectivePolicy: 'ask' | 'never'
    }
  | { readonly kind: 'tool-error'; readonly code?: string }
  | { readonly kind: 'sandbox-unavailable'; readonly mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; readonly code: string }
  | {
      readonly kind: 'runner-failed'
      readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly enforcement?: 'full' | 'partial'
      readonly process?: ProcessTailV1
    }
  | {
      readonly kind: 'sandbox-denied'
      readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly enforcement?: 'full' | 'partial'
      readonly process?: ProcessTailV1
    }
  | { readonly kind: 'timed-out'; readonly process: ProcessTailV1 }
  | { readonly kind: 'aborted'; readonly code?: string }
  | { readonly kind: 'process-signalled'; readonly signal: string; readonly exitCode: number | null }
  | { readonly kind: 'process-exited'; readonly exitCode: number }

export interface ToolAttemptV1 {
  readonly request: ToolRequestRefV1
  readonly outcome: ToolAttemptOutcomeV1
}

export interface ToolTrajectorySectionV1 {
  readonly turn: number
  readonly excludedPendingRequest: ToolRequestKeyV1
  readonly attempts: readonly ToolAttemptV1[]
}

export type ConfinementProjectionV1 =
  | { readonly kind: 'unconfined-composition' }
  | {
      readonly kind: 'sandbox-policy'
      readonly workspaceRoot: string
      readonly standingMode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly lastObservedEnforcement?: 'full' | 'partial'
    }

export interface EarlierSandboxDenialV1 {
  readonly source: {
    readonly event: EventRefV1
    readonly requestEventSeq: number
    readonly callId: string
  }
}

export interface PendingApprovalSectionV1 {
  readonly request: ToolRequestRefV1
  readonly approvalAsked: EventRefV1
  readonly approvalRequestId: string
  readonly callId: string
  readonly toolName: string
  readonly action: ActionSnapshot
  readonly actionHash: string
  readonly projectorId: string
  readonly confinement: ConfinementProjectionV1
  readonly requestedSandboxMode?: 'workspace-write' | 'danger-full-access'
  readonly description?: string
  readonly justification?: string
  readonly approvalReason?: string
  readonly earlierSandboxDenials: readonly EarlierSandboxDenialV1[]
}

export type DelegationToolDescriptorV1 =
  | {
      readonly classification: 'ordinary'
      readonly toolName: string
      readonly toolSchemaFingerprint: string
      readonly classificationId: string
    }
  | {
      readonly classification: 'delegation'
      readonly projectorId: string
      readonly toolName: string
      readonly toolSchemaFingerprint: string
      readonly operation: 'start' | 'followup' | 'orchestrate' | 'interrupt' | 'extension'
      readonly receiptPolicy:
        | { readonly kind: 'none' }
        | { readonly kind: 'required-on-completed'; readonly receiptKinds: readonly string[] }
      readonly configuration?: JsonValue
    }

export interface DelegationToolClassificationCatalogV1 {
  readonly version: 1
  readonly eventProjectionPolicyId: 'dsh-session-facts-v1'
  readonly argumentSemanticsId: string
  readonly fingerprint: string
  readonly descriptors: readonly DelegationToolDescriptorV1[]
}

export type DelegationCatalogValidationV1 =
  | { readonly kind: 'ok' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** A model-visible native tool schema frozen from a canonical request header. */
export interface EffectiveToolBindingV1 {
  readonly toolName: string
  readonly toolSchemaFingerprint: string
}

const EFFECTIVE_TOOL_SCHEMA_HASH_DOMAIN = 'dsh-approve-for-me/effective-tool-schema/v1\0'

/**
 * Produces the stable schema commitment used to bind a catalog descriptor to
 * the exact tool schema that was visible to the model. The parser is purposely
 * DSH-neutral so unknown host values never cross the domain boundary.
 */
export function effectiveToolBindingFromSchemaV1(input: unknown): EffectiveToolBindingV1 | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const schema = input as Record<string, unknown>
  if (typeof schema.name !== 'string' || schema.name.length === 0 || typeof schema.description !== 'string'
    || schema.parameters === null || typeof schema.parameters !== 'object' || Array.isArray(schema.parameters)
    || Object.keys(schema).some(key => key !== 'name' && key !== 'description' && key !== 'parameters')) return undefined
  try {
    const canonical = canonicalJson({ name: schema.name, description: schema.description, parameters: snapshotJson(schema.parameters) })
    return Object.freeze({
      toolName: schema.name,
      toolSchemaFingerprint: `sha256:${createHash('sha256').update(EFFECTIVE_TOOL_SCHEMA_HASH_DOMAIN).update(canonical).digest('hex')}`,
    })
  } catch {
    return undefined
  }
}

/** Parses the complete closed set of native schemas from a frozen header. */
export function effectiveToolBindingsFromRequestHeaderV1(input: unknown): readonly EffectiveToolBindingV1[] | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const tools = (input as Record<string, unknown>).tools
  if (tools === undefined) return Object.freeze([])
  if (!Array.isArray(tools)) return undefined
  const seen = new Set<string>()
  const bindings: EffectiveToolBindingV1[] = []
  for (const tool of tools) {
    const binding = effectiveToolBindingFromSchemaV1(tool)
    if (binding === undefined || seen.has(binding.toolName)) return undefined
    seen.add(binding.toolName)
    bindings.push(binding)
  }
  return Object.freeze(bindings)
}

const DELEGATION_CATALOG_HASH_DOMAIN = 'dsh-approve-for-me/delegation-tool-catalog/v1\0'

/** Recomputes the content commitment for a closed-world classification catalog. */
export function fingerprintDelegationToolCatalogV1(catalog: DelegationToolClassificationCatalogV1): string | undefined {
  if (catalog.version !== 1 || catalog.eventProjectionPolicyId !== 'dsh-session-facts-v1'
    || typeof catalog.argumentSemanticsId !== 'string' || catalog.argumentSemanticsId.length === 0
    || !Array.isArray(catalog.descriptors)) return undefined
  try {
    const descriptors = catalog.descriptors.map(descriptor => {
      if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
        || typeof descriptor.toolName !== 'string' || descriptor.toolName.length === 0
        || typeof descriptor.toolSchemaFingerprint !== 'string' || descriptor.toolSchemaFingerprint.length === 0) {
        throw new TypeError('invalid catalog descriptor')
      }
      if (descriptor.classification === 'ordinary') {
        if (typeof descriptor.classificationId !== 'string' || descriptor.classificationId.length === 0) {
          throw new TypeError('invalid ordinary descriptor')
        }
        return { classification: 'ordinary', toolName: descriptor.toolName, toolSchemaFingerprint: descriptor.toolSchemaFingerprint, classificationId: descriptor.classificationId }
      }
      if (descriptor.classification !== 'delegation' || typeof descriptor.projectorId !== 'string' || descriptor.projectorId.length === 0
        || !['start', 'followup', 'orchestrate', 'interrupt', 'extension'].includes(descriptor.operation)) {
        throw new TypeError('invalid delegation descriptor')
      }
      const policy = descriptor.receiptPolicy
      if (policy.kind !== 'none' && (policy.kind !== 'required-on-completed' || !Array.isArray(policy.receiptKinds)
        || policy.receiptKinds.some((kind: unknown) => typeof kind !== 'string' || kind.length === 0))) {
        throw new TypeError('invalid delegation receipt policy')
      }
      return {
        classification: 'delegation', projectorId: descriptor.projectorId, toolName: descriptor.toolName,
        toolSchemaFingerprint: descriptor.toolSchemaFingerprint, operation: descriptor.operation,
        receiptPolicy: policy.kind === 'none' ? { kind: 'none' } : { kind: 'required-on-completed', receiptKinds: [...policy.receiptKinds] },
        ...(descriptor.configuration === undefined ? {} : { configuration: snapshotJson(descriptor.configuration) }),
      }
    }).sort((left, right) => left.toolName.localeCompare(right.toolName))
    const core = { version: 1, eventProjectionPolicyId: catalog.eventProjectionPolicyId, argumentSemanticsId: catalog.argumentSemanticsId, descriptors }
    return `sha256:${createHash('sha256').update(DELEGATION_CATALOG_HASH_DOMAIN).update(canonicalJson(core)).digest('hex')}`
  } catch {
    return undefined
  }
}

export function validateDelegationToolCatalog(
  catalog: DelegationToolClassificationCatalogV1,
  effectiveTools: readonly { readonly toolName: string; readonly toolSchemaFingerprint: string }[],
): DelegationCatalogValidationV1 {
  const expectedFingerprint = fingerprintDelegationToolCatalogV1(catalog)
  if (expectedFingerprint === undefined || catalog.fingerprint !== expectedFingerprint) {
    return { kind: 'invalid', reason: 'catalog fingerprint is invalid or mismatched' }
  }
  const known = new Map<string, string>()
  for (const descriptor of catalog.descriptors) {
    if (known.has(descriptor.toolName)) return { kind: 'invalid', reason: `duplicate descriptor for ${descriptor.toolName}` }
    known.set(descriptor.toolName, descriptor.toolSchemaFingerprint)
  }
  // The durable catalog is a closed host-side superset. A request header may
  // expose only a scoped/restricted subset, and PTC mode deliberately exposes
  // only `run_code` while its nested dispatches still use the hidden stock
  // descriptors. Every effective model-facing schema must therefore be covered
  // exactly, but an unused catalog descriptor is not an omission or ambiguity.
  for (const tool of effectiveTools) {
    const fingerprint = known.get(tool.toolName)
    if (fingerprint === undefined) return { kind: 'invalid', reason: `missing descriptor for ${tool.toolName}` }
    if (fingerprint !== tool.toolSchemaFingerprint) {
      return { kind: 'invalid', reason: `schema fingerprint mismatch for ${tool.toolName}` }
    }
  }
  return { kind: 'ok' }
}

/** Maximum canonical UTF-8 size of one durable wire/callable catalog commitment. */
export const MAX_DURABLE_TOOL_CATALOG_COMMITMENT_BYTES = 1_000_000

/**
 * Complete per-execution catalog evidence. `wireSchemas` is the exact ordered
 * request/header presentation; `callableSchemas` is the exact scoped registry
 * used for native execution and hidden PTC sub-dispatches.
 */
export interface DurableToolCatalogCommitmentV1 {
  readonly version: 1
  readonly fingerprint: string
  readonly presentation: 'native' | 'ptc'
  readonly requestHeaderEventSeq: number
  readonly wireSchemas: readonly JsonValue[]
  readonly callableSchemas: readonly JsonValue[]
  readonly approvalCatalog: ApprovalToolCatalog
  readonly classificationCatalog: DelegationToolClassificationCatalogV1
}

const DURABLE_TOOL_CATALOG_HASH_DOMAIN = 'dsh-approve-for-me/durable-tool-catalog/v1\0'

/** Recompute the whole wire/callable/catalog commitment. */
export function fingerprintDurableToolCatalogCommitmentV1(
  commitment: DurableToolCatalogCommitmentV1,
): string | undefined {
  try {
    const core = {
      version: commitment.version,
      presentation: commitment.presentation,
      requestHeaderEventSeq: commitment.requestHeaderEventSeq,
      wireSchemas: snapshotJson(commitment.wireSchemas),
      callableSchemas: snapshotJson(commitment.callableSchemas),
      approvalCatalog: snapshotJson(commitment.approvalCatalog),
      classificationCatalog: snapshotJson(commitment.classificationCatalog),
    }
    return `sha256:${createHash('sha256').update(DURABLE_TOOL_CATALOG_HASH_DOMAIN).update(canonicalJson(core)).digest('hex')}`
  } catch {
    return undefined
  }
}

/** Validate the complete bounded commitment without consulting live host state. */
export function validateDurableToolCatalogCommitmentV1(
  commitment: DurableToolCatalogCommitmentV1,
): DelegationCatalogValidationV1 {
  if (commitment.version !== 1 || typeof commitment.fingerprint !== 'string'
    || commitment.fingerprint !== fingerprintDurableToolCatalogCommitmentV1(commitment)
    || (commitment.presentation !== 'native' && commitment.presentation !== 'ptc')
    || !Number.isSafeInteger(commitment.requestHeaderEventSeq) || commitment.requestHeaderEventSeq < 0
    || !Array.isArray(commitment.wireSchemas) || !Array.isArray(commitment.callableSchemas)
    || commitment.approvalCatalog === null || typeof commitment.approvalCatalog !== 'object'
    || !Array.isArray(commitment.approvalCatalog.descriptors)
    || commitment.classificationCatalog === null || typeof commitment.classificationCatalog !== 'object'
    || !Array.isArray(commitment.classificationCatalog.descriptors)) {
    return { kind: 'invalid', reason: 'catalog commitment envelope is invalid' }
  }
  let wire: readonly EffectiveToolBindingV1[]
  let callable: readonly EffectiveToolBindingV1[]
  try {
    const wireHeader = { tools: commitment.wireSchemas }
    const callableHeader = { tools: commitment.callableSchemas }
    const parsedWire = effectiveToolBindingsFromRequestHeaderV1(wireHeader)
    const parsedCallable = effectiveToolBindingsFromRequestHeaderV1(callableHeader)
    if (parsedWire === undefined || parsedCallable === undefined) {
      return { kind: 'invalid', reason: 'catalog commitment schemas are invalid' }
    }
    wire = parsedWire
    callable = parsedCallable
    if (new TextEncoder().encode(canonicalJson(commitment as unknown as JsonValue)).byteLength
      > MAX_DURABLE_TOOL_CATALOG_COMMITMENT_BYTES) {
      return { kind: 'invalid', reason: 'catalog commitment exceeds its durable budget' }
    }
  } catch {
    return { kind: 'invalid', reason: 'catalog commitment is not strict JSON' }
  }
  if (callable.length !== commitment.approvalCatalog.descriptors.length
    || callable.length !== commitment.classificationCatalog.descriptors.length
    || commitment.approvalCatalog.fingerprint !== fingerprintApprovalToolCatalogV1(commitment.approvalCatalog)
    || commitment.approvalCatalog.argumentSemanticsId !== commitment.classificationCatalog.argumentSemanticsId
    || validateDelegationToolCatalog(commitment.classificationCatalog, callable).kind !== 'ok') {
    return { kind: 'invalid', reason: 'callable schemas do not exactly bind both durable catalogs' }
  }
  const approvalByName = new Map(commitment.approvalCatalog.descriptors.map(item => [item.toolName, item.toolSchemaFingerprint]))
  if (callable.some(item => approvalByName.get(item.toolName) !== item.toolSchemaFingerprint)) {
    return { kind: 'invalid', reason: 'callable schemas do not bind the approval catalog' }
  }
  const callableByName = new Map(callable.map(item => [item.toolName, item.toolSchemaFingerprint]))
  if (commitment.presentation === 'native') {
    if (wire.length !== callable.length || wire.some(item => callableByName.get(item.toolName) !== item.toolSchemaFingerprint)) {
      return { kind: 'invalid', reason: 'native wire schemas are not the exact callable schema set' }
    }
  } else {
    if (wire.length !== 1 || wire[0]?.toolName !== 'run_code'
      || callableByName.get('run_code') !== wire[0].toolSchemaFingerprint) {
      return { kind: 'invalid', reason: 'PTC wire schemas are not the exact run_code presentation' }
    }
  }
  return { kind: 'ok' }
}

export function validateToolTrajectorySection(section: ToolTrajectorySectionV1): DelegationCatalogValidationV1 {
  if (!Number.isSafeInteger(section.turn) || section.turn < 0) return { kind: 'invalid', reason: 'section.turn must be a non-negative safe integer' }
  if (section.excludedPendingRequest.callId.length === 0 || section.excludedPendingRequest.requestEventSeq < 0) {
    return { kind: 'invalid', reason: 'excludedPendingRequest must be a non-empty callId with non-negative seq' }
  }
  const seen = new Set<string>()
  for (const attempt of section.attempts) {
    const callId = attempt.request.callId
    if (callId.length === 0) return { kind: 'invalid', reason: 'attempt callId must be non-empty' }
    const requestEventSeq = attempt.request.kind === 'model-tool-call'
      ? (attempt.request.callEvent?.seq ?? attempt.request.issuedIn.seq)
      : attempt.request.dispatchStart.seq
    const identity = `${requestEventSeq}\0${callId}`
    if (seen.has(identity)) return { kind: 'invalid', reason: `duplicate attempt identity ${callId}@${requestEventSeq}` }
    seen.add(identity)
  }
  return { kind: 'ok' }
}

export interface PrincipalSessionIdentityV1 extends SessionLifecycleIdentityV1 {
  readonly parentSessionId?: string
  readonly headerDelegationDepth?: number
  readonly runtimeSubagentDepth?: number
  readonly effectiveDelegationDepth: number
}

export interface SessionFactEventEnvelopeV1 {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: JsonValue
  readonly surfaceState?: 'visible' | 'superseded'
}

export type SessionFactEventV1 =
  | (SessionFactEventEnvelopeV1 & {
      readonly retention: 'included'
      readonly data: JsonValue
    })
  | (SessionFactEventEnvelopeV1 & {
      readonly retention: 'excluded-content'
      readonly exclusion:
        | 'child-origin-message'
        | 'tool-result-content'
        | 'delegation-result-content'
        | 'job-output-content'
      readonly source?: {
        readonly kind: string
        readonly form?: string
        readonly senderSessionId?: string
      }
      readonly originalBytes?: number
    })

export type PrincipalDelegationReceiptV1 =
  | { readonly kind: 'continuable-child-started'; readonly childSessionId: string; readonly directParentSessionId: string }
  | { readonly kind: 'foreground-run-settled'; readonly runId: string }
  | { readonly kind: 'background-job-started'; readonly jobId: string }
  | { readonly kind: 'followup-delivered'; readonly messageId: string }
  | { readonly kind: 'interrupt-accepted' }

export type PrincipalDelegationOperationV1 = 'start' | 'followup' | 'orchestrate' | 'interrupt' | 'extension'

export interface PrincipalDelegationEntryV1 {
  readonly projectorId: string
  readonly order: readonly [number, number, number]
  readonly attempt: ToolAttemptV1
  readonly operation: PrincipalDelegationOperationV1
  readonly receipt?: PrincipalDelegationReceiptV1
}

export interface DelegationReceiptFactRecordV1 {
  readonly session: SessionLifecycleIdentityV1
  readonly requestEventSeq: number
  readonly resultEvent: EventRefV1
  readonly callId: string
  readonly classificationCatalogFingerprint: string
  readonly projectorId: string
  readonly receipt: PrincipalDelegationReceiptV1
}

/**
 * WP9-a: slim durable catalog evidence. The v1 commitment embedded the full
 * wire/callable wire schemas in every execution record (~90KB per record,
 * repeated for thousands of records in one catalog epoch). V2 keeps the
 * commitment fingerprint (computed over the full v1 commitment at write time),
 * digests of the schema bodies, and the two small scalar authorization
 * catalogs, so every offline cross-check that only needed catalog descriptors
 * still works unchanged.
 *
 * What is deliberately NOT re-validatable from rest (write-time guarantees,
 * guarded by the row digest and the live header re-bind):
 * the internal shape of the schema bodies and their exact binding to both
 * catalogs. `schemasDigest` binds wire+callable jointly; `wireSchemasDigest`
 * preserves the exact former byte-compare against the live request/header.
 */
export interface DurableCatalogEvidenceV2 {
  readonly version: 2
  /** The v1 DurableToolCatalogCommitmentV1 fingerprint (hash over the full commitment). */
  readonly commitment: string
  readonly presentation: 'native' | 'ptc'
  readonly requestHeaderEventSeq: number
  /** sha256 over canonicalJson({wireSchemas, callableSchemas}). */
  readonly schemasDigest: string
  /** sha256 over canonicalJson(wireSchemas); compared against live header.tools. */
  readonly wireSchemasDigest: string
  /** callableSchemas.length at write time. */
  readonly schemaCount: number
  readonly approvalCatalog: ApprovalToolCatalog
  readonly classificationCatalog: DelegationToolClassificationCatalogV1
}

/** WP9-a: action snapshot with the unbounded arguments payload referenced. */
export interface ActionSnapshotV2 {
  readonly version: 2
  readonly kind: 'tool-call'
  readonly toolName: string
  readonly arguments: PayloadRefV1
  readonly requestedPermissions: readonly RequestedPermission[]
  readonly projectorId: string
  readonly semantics: { readonly family: string; readonly value: JsonValue }
}

/**
 * WP9-a: slim execution fact record. Arguments travel as PayloadRefV1 and the
 * catalog commitment is reduced to DurableCatalogEvidenceV2; actionHash,
 * toolName, callId, eventSeq, fingerprints and all correlation scalars stay
 * inline. The full action snapshot is re-derived from live event arguments at
 * consumption time via resolveStoredActionV2 and verified against actionHash,
 * which is byte-for-byte equivalent to the v1 stored-action comparison.
 */
export interface ToolExecutionFactRecordV2 {
  readonly version: 2
  readonly session: SessionLifecycleIdentityV1
  readonly request:
    | {
        readonly kind: 'model-tool-call'
        readonly eventSeq: number
        readonly eventType: 'tool/call'
        readonly callId: string
        readonly toolName: string
      }
    | {
        readonly kind: 'code-dispatch'
        readonly eventSeq: number
        readonly eventType: 'tool/code-dispatch-start'
        readonly rootCallId: string
        readonly rootRequestEventSeq: number
        readonly parentCallId: string
        readonly parentRequestEventSeq: number
        readonly callId: string
        readonly toolName: string
        readonly arguments: PayloadRefV1
      }
  /** Slim per-execution catalog evidence (replaces the inline v1 commitment). */
  readonly catalogEvidence: DurableCatalogEvidenceV2
  readonly toolClassification: {
    readonly classificationCatalogFingerprint: string
    readonly descriptor: DelegationToolDescriptorV1
  }
  readonly projection: {
    readonly projectorId: string
    readonly action: ActionSnapshotV2
    readonly actionHash: string
    readonly observedAt: number
  }
  /**
   * Content-free pre-commit evidence persisted by the post-execute wrapper
   * before DSH can append the terminal Session event. It never proves
   * settlement by itself; cold repair admits it only when the canonical result
   * event independently confirms the same error category.
   */
  readonly terminalEvidence?: {
    /** Canonical ToolExecutionResult discriminator used to authenticate cold repair. */
    readonly isError: boolean
    readonly outcome: Extract<ToolAttemptOutcomeV1,
      { readonly kind: 'completed' } | { readonly kind: 'tool-error' } | { readonly kind: 'sandbox-denied' }>
    readonly receipt?: PrincipalDelegationReceiptV1
  }
  readonly result?: {
    readonly eventSeq: number
    readonly eventType: 'tool/result' | 'tool/code-dispatch'
    /** Only a safe terminal category; never tool output or failure text. */
    readonly outcome: Extract<ToolAttemptOutcomeV1,
      { readonly kind: 'completed' } | { readonly kind: 'tool-error' } | { readonly kind: 'sandbox-denied' }>
  }
  readonly delegationReceipt?: DelegationReceiptFactRecordV1
}

/** The semantic projection value stays inline and bounded; a larger value fails closed at write time. */
export const MAX_STORED_ACTION_SEMANTICS_BYTES = 262_144

/** Convert a validated live catalog commitment into its slim durable evidence form. */
export function createDurableCatalogEvidenceV2(commitment: DurableToolCatalogCommitmentV1): DurableCatalogEvidenceV2 {
  if (validateDurableToolCatalogCommitmentV1(commitment).kind !== 'ok') {
    throw new TypeError('durable catalog commitment is invalid')
  }
  return Object.freeze({
    version: 2,
    commitment: commitment.fingerprint,
    presentation: commitment.presentation,
    requestHeaderEventSeq: commitment.requestHeaderEventSeq,
    schemasDigest: canonicalSha256({ wireSchemas: commitment.wireSchemas, callableSchemas: commitment.callableSchemas }),
    wireSchemasDigest: canonicalSha256(commitment.wireSchemas),
    schemaCount: commitment.callableSchemas.length,
    approvalCatalog: commitment.approvalCatalog,
    classificationCatalog: commitment.classificationCatalog,
  })
}

/** Validate the slim catalog evidence without consulting live host state. */
export function validateDurableCatalogEvidenceV2(evidence: DurableCatalogEvidenceV2): DelegationCatalogValidationV1 {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.version !== 2
    || typeof evidence.commitment !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.commitment)
    || (evidence.presentation !== 'native' && evidence.presentation !== 'ptc')
    || !Number.isSafeInteger(evidence.requestHeaderEventSeq) || evidence.requestHeaderEventSeq < 0
    || typeof evidence.schemasDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.schemasDigest)
    || typeof evidence.wireSchemasDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.wireSchemasDigest)
    || !Number.isSafeInteger(evidence.schemaCount) || evidence.schemaCount < 0
    || evidence.approvalCatalog === null || typeof evidence.approvalCatalog !== 'object'
    || !Array.isArray(evidence.approvalCatalog.descriptors)
    || evidence.classificationCatalog === null || typeof evidence.classificationCatalog !== 'object'
    || !Array.isArray(evidence.classificationCatalog.descriptors)) {
    return { kind: 'invalid', reason: 'catalog evidence envelope is invalid' }
  }
  try {
    if (new TextEncoder().encode(canonicalJson(evidence as unknown as JsonValue)).byteLength
      > MAX_DURABLE_TOOL_CATALOG_COMMITMENT_BYTES) {
      return { kind: 'invalid', reason: 'catalog evidence exceeds its durable budget' }
    }
  } catch {
    return { kind: 'invalid', reason: 'catalog evidence is not strict JSON' }
  }
  if (evidence.approvalCatalog.fingerprint !== fingerprintApprovalToolCatalogV1(evidence.approvalCatalog)
    || evidence.classificationCatalog.fingerprint !== fingerprintDelegationToolCatalogV1(evidence.classificationCatalog)
    || evidence.approvalCatalog.argumentSemanticsId !== evidence.classificationCatalog.argumentSemanticsId) {
    return { kind: 'invalid', reason: 'catalog evidence fingerprints are invalid or unbound' }
  }
  return { kind: 'ok' }
}

/** Convert a live v1 action snapshot into its slim stored form (arguments referenced). */
export function createStoredActionSnapshotV2(action: ActionSnapshot): ActionSnapshotV2 {
  let semanticsValue: JsonValue
  try {
    semanticsValue = snapshotJson(action.semantics.value)
    if (Buffer.byteLength(canonicalJson(semanticsValue), 'utf8') > MAX_STORED_ACTION_SEMANTICS_BYTES) {
      throw new TypeError('stored action semantics exceed the inline budget')
    }
  } catch (cause: unknown) {
    if (cause instanceof TypeError && (cause as Error).message === 'stored action semantics exceed the inline budget') throw cause
    throw new TypeError('stored action semantics are not strict JSON')
  }
  const semantics = Object.freeze({ family: action.semantics.family, value: semanticsValue })
  return Object.freeze({
    version: 2,
    kind: 'tool-call',
    toolName: action.toolName,
    arguments: toPayloadRef(action.arguments),
    requestedPermissions: action.requestedPermissions,
    projectorId: action.projectorId,
    semantics,
  })
}

/** Strict closed-set parse of a stored v2 action snapshot; throws on any violation. */
export function parseStoredActionSnapshotV2(input: unknown): ActionSnapshotV2 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('action must be an object')
  const value = input as Record<string, unknown>
  if (value.version !== 2) throw new TypeError('action.version must be 2')
  if (value.kind !== 'tool-call') throw new TypeError('action.kind must be "tool-call"')
  if (typeof value.toolName !== 'string' || value.toolName.length === 0) throw new TypeError('action.toolName must be a non-empty string')
  if (typeof value.projectorId !== 'string' || value.projectorId.length === 0) throw new TypeError('action.projectorId must be a non-empty string')
  if (!isPayloadRefV1(value.arguments)) throw new TypeError('action.arguments must be a payload reference')
  if (value.semantics === null || typeof value.semantics !== 'object' || Array.isArray(value.semantics)) {
    throw new TypeError('action.semantics must be an object')
  }
  const semantics = value.semantics as Record<string, unknown>
  if (typeof semantics.family !== 'string' || semantics.family.length === 0) throw new TypeError('action.semantics.family must be a non-empty string')
  let semanticsValue: { readonly family: string; readonly value: JsonValue }
  try {
    semanticsValue = Object.freeze({ family: semantics.family, value: snapshotJson(semantics.value) })
  } catch {
    throw new TypeError('action.semantics.value must be strict JSON')
  }
  // Deep-validate requestedPermissions exactly as the v1 action parser did, by
  // running them through the shared action construction rules.
  if (!Array.isArray(value.requestedPermissions)) throw new TypeError('action.requestedPermissions must be an array')
  createActionSnapshot({
    toolName: value.toolName,
    arguments: {},
    projectorId: value.projectorId,
    semantics: { family: semantics.family, value: semantics.value },
    requestedPermissions: value.requestedPermissions as RequestedPermission[],
  })
  return Object.freeze({
    version: 2,
    kind: 'tool-call',
    toolName: value.toolName,
    arguments: value.arguments,
    requestedPermissions: value.requestedPermissions as readonly RequestedPermission[],
    projectorId: value.projectorId,
    semantics: semanticsValue,
  })
}

export function isActionSnapshotV2(value: unknown): value is ActionSnapshotV2 {
  try {
    parseStoredActionSnapshotV2(value)
    return true
  } catch {
    return false
  }
}

/**
 * Single write-side constructor for v2 execution fact records. Takes the same
 * live values as the v1 writer (full arguments, full catalog commitment, full
 * action snapshot) and produces the slim durable form. Throws on invalid
 * input; writers treat a throw as a projection failure (non-authorizing).
 */
export function createToolExecutionFactRecordV2(input: {
  readonly session: SessionLifecycleIdentityV1
  readonly request:
    | {
        readonly kind: 'model-tool-call'
        readonly eventSeq: number
        readonly eventType: 'tool/call'
        readonly callId: string
        readonly toolName: string
      }
    | {
        readonly kind: 'code-dispatch'
        readonly eventSeq: number
        readonly eventType: 'tool/code-dispatch-start'
        readonly rootCallId: string
        readonly rootRequestEventSeq: number
        readonly parentCallId: string
        readonly parentRequestEventSeq: number
        readonly callId: string
        readonly toolName: string
        readonly arguments: JsonValue
      }
  readonly catalogCommitment: DurableToolCatalogCommitmentV1
  readonly toolClassification: {
    readonly classificationCatalogFingerprint: string
    readonly descriptor: DelegationToolDescriptorV1
  }
  readonly projection: {
    readonly projectorId: string
    readonly action: ActionSnapshot
    readonly observedAt: number
  }
  readonly terminalEvidence?: ToolExecutionFactRecordV2['terminalEvidence']
  readonly result?: ToolExecutionFactRecordV2['result']
  readonly delegationReceipt?: DelegationReceiptFactRecordV1
}): ToolExecutionFactRecordV2 {
  const action = createStoredActionSnapshotV2(input.projection.action)
  if (input.projection.projectorId !== action.projectorId) {
    throw new TypeError('projection.projectorId does not match the action projector')
  }
  const actionHash = hashAction(input.projection.action)
  const record: ToolExecutionFactRecordV2 = {
    version: 2,
    session: input.session,
    request: input.request.kind === 'model-tool-call'
      ? input.request
      : Object.freeze({ ...input.request, arguments: toPayloadRef(input.request.arguments) }),
    catalogEvidence: createDurableCatalogEvidenceV2(input.catalogCommitment),
    toolClassification: input.toolClassification,
    projection: Object.freeze({
      projectorId: input.projection.projectorId,
      action,
      actionHash,
      observedAt: input.projection.observedAt,
    }),
    ...input.terminalEvidence === undefined ? {} : { terminalEvidence: input.terminalEvidence },
    ...input.result === undefined ? {} : { result: input.result },
    ...input.delegationReceipt === undefined ? {} : { delegationReceipt: input.delegationReceipt },
  }
  return Object.freeze(record)
}

/**
 * Re-derive the full v1 action snapshot from a stored v2 action and LIVE event
 * arguments, requiring the stored payload reference to match the live value
 * (sha256-compare equivalence with the v1 byte-for-byte stored/live compare).
 * Returns undefined on any mismatch or malformed live value (fail closed).
 */
export function resolveStoredActionV2(stored: ActionSnapshotV2, liveArguments: unknown): ActionSnapshot | undefined {
  if (!payloadRefMatchesLive(stored.arguments, liveArguments)) return undefined
  try {
    return createActionSnapshot({
      toolName: stored.toolName,
      arguments: liveArguments,
      projectorId: stored.projectorId,
      semantics: stored.semantics,
      requestedPermissions: stored.requestedPermissions as RequestedPermission[],
    })
  } catch {
    return undefined
  }
}

/** Legacy v1 execution fact shape (WP9-a: no longer written; v1 storage rows read as absent). */
export interface ToolExecutionFactRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly request:
    | {
        readonly kind: 'model-tool-call'
        readonly eventSeq: number
        readonly eventType: 'tool/call'
        readonly callId: string
        readonly toolName: string
      }
    | {
        readonly kind: 'code-dispatch'
        readonly eventSeq: number
        readonly eventType: 'tool/code-dispatch-start'
        readonly rootCallId: string
        readonly rootRequestEventSeq: number
        readonly parentCallId: string
        readonly parentRequestEventSeq: number
        readonly callId: string
        readonly toolName: string
        readonly arguments: JsonValue
      }
  /** Complete bounded catalog evidence captured before this exact execution. */
  readonly catalogCommitment: DurableToolCatalogCommitmentV1
  readonly toolClassification: {
    readonly classificationCatalogFingerprint: string
    readonly descriptor: DelegationToolDescriptorV1
  }
  readonly projection: {
    readonly projectorId: string
    readonly action: ActionSnapshot
    readonly actionHash: string
    readonly observedAt: number
  }
  /**
   * Content-free pre-commit evidence persisted by the post-execute wrapper
   * before DSH can append the terminal Session event. It never proves
   * settlement by itself; cold repair admits it only when the canonical result
   * event independently confirms the same error category.
   */
  readonly terminalEvidence?: {
    /** Canonical ToolExecutionResult discriminator used to authenticate cold repair. */
    readonly isError: boolean
    readonly outcome: Extract<ToolAttemptOutcomeV1,
      { readonly kind: 'completed' } | { readonly kind: 'tool-error' } | { readonly kind: 'sandbox-denied' }>
    readonly receipt?: PrincipalDelegationReceiptV1
  }
  readonly result?: {
    readonly eventSeq: number
    readonly eventType: 'tool/result' | 'tool/code-dispatch'
    /** Only a safe terminal category; never tool output or failure text. */
    readonly outcome: Extract<ToolAttemptOutcomeV1,
      { readonly kind: 'completed' } | { readonly kind: 'tool-error' } | { readonly kind: 'sandbox-denied' }>
  }
  readonly delegationReceipt?: DelegationReceiptFactRecordV1
}

/**
 * The only durable ask-environment evidence admitted in D1.1. Its label
 * records that this snapshot carries no inferred host, sandbox, or Code Mode
 * facts; later versions may add separately validated evidence variants.
 */
export type ApprovalEnvironmentEvidenceV1 = Readonly<{
  readonly version: 1
  readonly kind: 'native-header-only'
}>

/** Rejects unrecognized or expanded evidence before it reaches a dossier. */
export function isApprovalEnvironmentEvidenceV1(value: unknown): value is ApprovalEnvironmentEvidenceV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const evidence = value as Record<string, unknown>
  return Object.keys(evidence).length === 2
    && evidence.version === 1
    && evidence.kind === 'native-header-only'
}

export interface ApprovalSnapshotRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly approvalRequestId: string
  readonly approvalAskedSeq: number
  /** Immutable binding to the exact pre-execute fact that caused this ask. */
  readonly execution: {
    readonly requestEventSeq: number
    readonly callId: string
    readonly toolName: string
    readonly actionHash: string
    readonly classificationCatalogFingerprint: string
    readonly projectorId: string
  }
  readonly environment: ApprovalEnvironmentEvidenceV1
}

export interface ParentSessionFactSnapshotV1 {
  readonly version: 1
  readonly session: PrincipalSessionIdentityV1
  readonly eventProjection: {
    readonly policyId: 'dsh-session-facts-v1'
    readonly classificationCatalog: DelegationToolClassificationCatalogV1
  }
  readonly approvalBinding: {
    readonly event: EventRefV1
    readonly approvalRequestId: string
    readonly callId: string
    readonly toolName: string
    readonly reason?: string
  }
  readonly throughSeq: number
  readonly events: readonly SessionFactEventV1[]
  readonly delegationReceipts: readonly DelegationReceiptFactRecordV1[]
  readonly executionFacts: readonly ToolExecutionFactRecordV2[]
  readonly approvalSnapshots: readonly ApprovalSnapshotRecordV1[]
}

export interface PrincipalDelegationProjector {
  project(input: {
    readonly principalSessionId: string
    readonly attempt: ToolAttemptV1
    readonly descriptor: Extract<DelegationToolDescriptorV1, { readonly classification: 'delegation' }>
    readonly receipt?: DelegationReceiptFactRecordV1
  }): { kind: 'delegation'; readonly entry: PrincipalDelegationEntryV1 }
    | { kind: 'invalid'; readonly reason: string }
}

export interface DossierSectionMetricsV1 {
  readonly name: 'environment' | 'instructions' | 'interaction' | 'currentTurnTools' | 'pendingApproval'
  readonly bytes: number
  readonly characters: number
}

/** Non-sensitive accounting derived from the canonical dossier, never a payload copy. */
export interface DossierMetricsV1 {
  readonly dossierVersion: 1
  readonly delegationClassificationCatalogFingerprint: string
  readonly bytes: number
  readonly characters: number
  readonly sections: readonly DossierSectionMetricsV1[]
  readonly eventCount: number
  readonly includedEventCount: number
  readonly excludedEventCount: number
  readonly delegationEntryCount: number
  readonly attemptCount: number
  /** Retained source-side accounting for excluded content only. */
  readonly totalBytes: number
}

export type DossierCompilationResultV1 =
  | { readonly kind: 'ready'; readonly verified: SourceVerifiedDossierV1; readonly metrics: DossierMetricsV1 }
  /** Bounded-capacity overflows retain only non-sensitive candidate accounting; no dossier is branded. */
  | { readonly kind: 'incomplete'; readonly reason: 'budget-overflow' | 'ledger-budget-overflow'; readonly metrics: DossierMetricsV1 }
  | { readonly kind: 'incomplete'; readonly reason: Exclude<string, 'budget-overflow' | 'ledger-budget-overflow'> }

export interface SemanticActionBindingV1 {
  readonly toolName: string
  readonly family: string
  readonly projectorId: string
}

export interface GuardianDossierCompilerDependencies {
  readonly delegationProjector: PrincipalDelegationProjector
  /** Optional closed semantic bindings for the automatic-approval profile. */
  readonly semanticActionBindings?: readonly SemanticActionBindingV1[]
  /** Complete v1 dossiers exceeding this UTF-8 byte limit fail closed. */
  readonly maxDossierBytes: number
}

export interface GuardianDossierCompiler {
  compile(input: {
    readonly facts: ParentSessionFactSnapshotV1
    readonly signal?: AbortSignal
  }): DossierCompilationResultV1
}

export interface DirectUserMessageV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly content: readonly JsonValue[]
  readonly surfaceState: 'visible' | 'superseded'
}

export interface AgentDeliveryV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly textBlocks: readonly string[]
  /** Original principal message visibility at freeze; never infer currentness. */
  readonly surfaceState: 'visible' | 'superseded'
}

export type TurnEndSummaryV1 =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'error'; readonly code?: string }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'extension'; readonly reason: JsonValue }

export interface InteractionTurnV1 {
  readonly turn: number
  readonly directUserMessages: readonly DirectUserMessageV1[]
  readonly delivery?: AgentDeliveryV1
  readonly end?: TurnEndSummaryV1
}

/**
 * One legitimate catalog epoch witnessed by the verified trajectory. Each
 * mid-session tool-catalog evolution (for example a dynamic plugin mount)
 * contributes exactly one epoch keyed by the request/header event in force;
 * historical attempts keep the classification of their own epoch and are
 * never reinterpreted under a later catalog.
 */
export interface CatalogEpochSummaryV1 {
  readonly requestHeaderEventSeq: number
  readonly commitmentFingerprint: string
  readonly classificationCatalogFingerprint: string
}

export interface PrincipalDelegationLedgerV1 {
  readonly model: 'principal-extension-v1'
  readonly principalSessionId: string
  readonly descendantsGrantAuthority: false
  readonly childOutputPolicy: 'exclude-direct-origin-v1'
  readonly classificationCatalog: DelegationToolClassificationCatalogV1
  readonly entries: readonly PrincipalDelegationEntryV1[]
  /** Every catalog epoch in the trajectory, ascending by header event seq. */
  readonly catalogEpochs?: readonly CatalogEpochSummaryV1[]
}

export interface HistoricalToolTrajectoryV1 {
  readonly turn: number
  readonly attempts: readonly ToolAttemptV1[]
}

export interface InteractionSectionV1 {
  readonly turns: readonly InteractionTurnV1[]
  /** Content-free terminal metadata for ordinary calls in completed prior turns. */
  readonly historicalTools: readonly HistoricalToolTrajectoryV1[]
  readonly delegations: PrincipalDelegationLedgerV1
}
