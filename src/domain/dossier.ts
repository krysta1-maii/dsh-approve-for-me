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

declare const sourceVerifiedDossierV1Brand: unique symbol

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
