import { canonicalJson } from './json.js'
import type { JsonValue } from './json.js'
import { hashGuardianDossier } from './records.js'
import type { SessionLifecycleIdentityV1 } from './records.js'
import type { ActionSnapshot } from './protocol.js'

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
export interface GuardianDossierV1 {
  readonly version: 1
  readonly kind: 'guardian-dossier'
  readonly freeze: DossierFreezeV1
  readonly environment: JsonValue
  readonly instructions: JsonValue
  readonly interaction: JsonValue
  readonly currentTurnTools: JsonValue
  readonly pendingApproval: JsonValue
  readonly completeness: JsonValue
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
  if (typeof parent.sessionId !== 'string' || typeof parent.sessionFormatVersion !== 'number' || typeof parent.createdAt !== 'number') {
    throw new TypeError('dossier.freeze.parent must carry sessionId/sessionFormatVersion/createdAt')
  }
  for (const key of ['throughSeq', 'currentTurn', 'currentStep', 'frozenAt'] as const) {
    if (!Number.isSafeInteger(freeze[key]) || (freeze[key] as number) < 0) {
      throw new TypeError(`dossier.freeze.${key} must be a non-negative safe integer`)
    }
  }
  for (const key of ['environment', 'instructions', 'interaction', 'currentTurnTools', 'pendingApproval', 'completeness'] as const) {
    if (value[key] === undefined) throw new TypeError(`dossier.${key} is required`)
    canonicalJson(value[key]) // rejects non-canonical JSON
  }
  return Object.freeze({
    version: 1,
    kind: 'guardian-dossier',
    freeze: Object.freeze({
      parent: Object.freeze({
        sessionId: parent.sessionId as string,
        sessionFormatVersion: parent.sessionFormatVersion as number,
        createdAt: parent.createdAt as number,
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
    completeness: value.completeness as JsonValue,
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
  const dossierHash = hashGuardianDossier(dossier)
  return Object.freeze({ dossier, dossierHash, [sourceVerifiedDossierV1Brand]: true }) as SourceVerifiedDossierV1
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
  readonly earlierSandboxDenials: readonly {
    readonly callId: string
    readonly requestEvent: EventRefV1
  }[]
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

export function validateDelegationToolCatalog(
  catalog: DelegationToolClassificationCatalogV1,
  effectiveTools: readonly { readonly toolName: string; readonly toolSchemaFingerprint: string }[],
): DelegationCatalogValidationV1 {
  if (catalog.version !== 1) return { kind: 'invalid', reason: 'catalog.version must be 1' }
  if (catalog.eventProjectionPolicyId !== 'dsh-session-facts-v1') {
    return { kind: 'invalid', reason: 'catalog.eventProjectionPolicyId must be dsh-session-facts-v1' }
  }
  const known = new Map<string, string>()
  for (const descriptor of catalog.descriptors) {
    if (known.has(descriptor.toolName)) return { kind: 'invalid', reason: `duplicate descriptor for ${descriptor.toolName}` }
    known.set(descriptor.toolName, descriptor.toolSchemaFingerprint)
  }
  const covered = new Set<string>()
  for (const tool of effectiveTools) {
    const fingerprint = known.get(tool.toolName)
    if (fingerprint === undefined) return { kind: 'invalid', reason: `missing descriptor for ${tool.toolName}` }
    if (fingerprint !== tool.toolSchemaFingerprint) {
      return { kind: 'invalid', reason: `schema fingerprint mismatch for ${tool.toolName}` }
    }
    covered.add(tool.toolName)
  }
  for (const descriptor of catalog.descriptors) {
    if (!covered.has(descriptor.toolName)) {
      return { kind: 'invalid', reason: `extra descriptor for ${descriptor.toolName}` }
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
    if (seen.has(callId)) return { kind: 'invalid', reason: `duplicate attempt callId ${callId}` }
    seen.add(callId)
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

export interface ToolExecutionFactRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly request: {
    readonly kind: 'model-tool-call' | 'code-dispatch'
    readonly eventSeq: number
    readonly eventType: 'tool/call' | 'tool/code-dispatch-start'
    readonly callId: string
    readonly toolName: string
    readonly parentCallId?: string
  }
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
  readonly result?: {
    readonly eventSeq: number
    readonly eventType: 'tool/result' | 'tool/code-dispatch'
  }
  readonly delegationReceipt?: DelegationReceiptFactRecordV1
}

export interface ApprovalSnapshotRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly approvalRequestId: string
  readonly approvalAskedSeq: number
  readonly environment: JsonValue
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
  readonly executionFacts: readonly ToolExecutionFactRecordV1[]
  readonly approvalSnapshots: readonly ApprovalSnapshotRecordV1[]
}

export interface PrincipalDelegationProjector {
  readonly catalog: DelegationToolClassificationCatalogV1
  project(input: {
    readonly principalSessionId: string
    readonly attempt: ToolAttemptV1
    readonly descriptor: Extract<DelegationToolDescriptorV1, { readonly classification: 'delegation' }>
    readonly receipt?: DelegationReceiptFactRecordV1
  }): { kind: 'delegation'; readonly entry: PrincipalDelegationEntryV1 }
    | { kind: 'invalid'; readonly reason: string }
}

export interface DossierMetricsV1 {
  readonly eventCount: number
  readonly includedEventCount: number
  readonly excludedEventCount: number
  readonly delegationEntryCount: number
  readonly attemptCount: number
  readonly totalBytes: number
}

export type DossierCompilationResultV1 =
  | { readonly kind: 'ready'; readonly verified: SourceVerifiedDossierV1; readonly metrics: DossierMetricsV1 }
  | { readonly kind: 'incomplete'; readonly reason: string }

export interface GuardianDossierCompilerDependencies {
  readonly delegationProjector: PrincipalDelegationProjector
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

export interface PrincipalDelegationLedgerV1 {
  readonly model: 'principal-extension-v1'
  readonly principalSessionId: string
  readonly descendantsGrantAuthority: false
  readonly childOutputPolicy: 'exclude-direct-origin-v1'
  readonly classificationCatalog: DelegationToolClassificationCatalogV1
  readonly entries: readonly PrincipalDelegationEntryV1[]
}

export interface InteractionSectionV1 {
  readonly turns: readonly InteractionTurnV1[]
  readonly delegations: PrincipalDelegationLedgerV1
}
