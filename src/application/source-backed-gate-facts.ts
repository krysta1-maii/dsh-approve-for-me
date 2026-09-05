import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GateMachineRequestV1 } from '../approval-gate/machine-policy.js'
import type { ParentAuthority } from '../ports/managed-reviewer.js'
import type {
  EarlierSandboxDenialV1,
  EventRefV1,
  PendingApprovalSectionV1,
  SourceVerifiedDossierV1,
  ToolExecutionFactRecordV1,
  ApprovalSnapshotRecordV1,
  DossierFreezeV1,
  ConfinementProjectionV1,
} from '../domain/dossier.js'
import type { ActionSnapshot } from '../domain/protocol.js'
import { validateDurableToolCatalogCommitmentV1 } from '../domain/dossier.js'
import type { GateActionFactResolver, GateActionFacts } from './gate-pipeline.js'
import { GateFailure } from './gate-failure.js'
import type { GateFailureCode, GateFailureCorrelationV1 } from './gate-failure.js'
import { canonicalJson } from '../domain/json.js'
import type { ToolApprovalClass, ToolApprovalClassificationResult } from '../approval-gate/catalog.js'
import { hashAction } from '../domain/protocol.js'
import { assessVerifiedActionV1 } from '../domain/risk-assessment.js'
import type { DangerEscalationRiskV1 } from '../domain/risk-assessment.js'
import type { TrustEnvelopeInputV1 } from '../approval-gate/trust-envelope.js'
import type { CompileSealed, SealedDossierCurrentFactsV1 } from './sealed-dossier-compiler.js'
import type { SealedParentSessionFactsV1, SealedFactsReadResult, SealedFactsUnavailableSubcodeV1 } from '../dsh/parent-session-fact-source.js'

/**
 * A pending approval handle is correlation metadata only. It intentionally
 * contains no precomputed classification, scope, cache key, or action facts:
 * those values must be reconstructed from the frozen sealed facts.
 */
export interface PendingSourceBackedAsk {
  readonly agent: Agent
  readonly requestId: string
  readonly callId: string
  readonly toolName: string
  readonly actionHash: string
  readonly authority: ParentAuthority<Agent, string>
}

/**
 * The exact principal identity facts the sealed projector needs to authorise (or
 * fail closed) the requester. Derived once at the DSH boundary from the live
 * Agent/Session; it never infers depth from a bare id.
 */
export interface SealedPrincipalRequesterV1 {
  readonly effectiveDelegationDepth: number
  readonly parentSessionId?: string
}

/**
 * Capture/sidecar-bound facts for the one current ask. `snapshotInput` returns
 * these after asked-positioning and live catalog re-validation; the resolver
 * assembles the sealed current facts and carrier block from them.
 */
export interface SealedAskFactsInputV1 {
  readonly agent: Agent
  readonly approvalRequestId: string
  readonly callId: string
  readonly toolName: string
  /** Capture-frozen execution fact for the exact current ask. */
  readonly executionFact: ToolExecutionFactRecordV1
  /** Approval snapshot sidecar binding the ask to that execution fact. */
  readonly approvalSnapshot: ApprovalSnapshotRecordV1
  /** Ask-time approval/asked event ref (seq/type/turn/step). */
  readonly approvalAsked: EventRefV1
  /** Ask-time freeze boundary over the sealed tail. */
  readonly freeze: DossierFreezeV1
  readonly requester: SealedPrincipalRequesterV1
  readonly signal?: AbortSignal
  /** Bounded recent human user-message excerpts assembled around the ask (intent aid). */
  readonly excerpts?: readonly { readonly seq: number; readonly text: string }[]
  /** Count of candidate excerpts the assembler dropped for its byte budget. */
  readonly excerptTruncated?: number
}

/**
 * The bounded carrier the sealed projector needs beyond what the reduced sealed
 * dossier carries. These are resolved server-side (WP4-b4-1 裁定 1/2); each is
 * the same-strength binding the old full-history path derived from the catalog
 * descriptor and the live principal identity.
 */
export interface SealedCurrentCarrierV1 {
  readonly toolSchemaFingerprint: string
  readonly requester: SealedPrincipalRequesterV1
  /** Provenance-only direct-user frontier (numeric seq -> authorization unknown). */
  readonly frontierSeq: number
  /** Composite effective-catalog commitment fingerprint (never the classification-catalog one). */
  readonly catalogCommitmentFingerprint: string
}

export interface SourceBackedFactProjector {
  project(input: {
    readonly request: GateMachineRequestV1
    readonly pending: PendingSourceBackedAsk
    readonly facts: SealedParentSessionFactsV1
    readonly sealedCurrent: SealedCurrentCarrierV1
    readonly verifiedDossier: SourceVerifiedDossierV1
  }): GateActionFacts | undefined
}

/** Bounded reader boundary for one immutable sealed-facts read. */
export interface SealedFactsReader {
  read(input: {
    readonly agent: Agent
    readonly approvalRequestId: string
    readonly callId: string
    readonly toolName: string
    readonly maxSealedTailEvents: number
    readonly signal?: AbortSignal
  }): Promise<SealedFactsReadResult>
}

export interface SourceBackedGateFactResolverDependencies {
  readonly sealedFacts: SealedFactsReader
  readonly compileSealed: CompileSealed
  readonly projector: SourceBackedFactProjector
  readonly maxSealedTailEvents: number
  /**
   * Identity/generation metadata surfaced only when a sealed-facts failure must
   * be recorded as a metadata-only audit row (WP5-a). Optional so a default or
   * test resolver without a real source packet can still route a typed code.
   */
  readonly generation?: string
  readonly policyVersion?: string
  readonly reviewerConfigurationFingerprint?: string
  /** Obtains the exact capture/sidecar facts + live re-validation for this same immutable approval ask. */
  snapshotInput(pending: PendingSourceBackedAsk, signal?: AbortSignal): Promise<SealedAskFactsInputV1 | undefined>
}

const GATE_CONFIGURATION_HASH_DOMAIN = 'dsh-approve-for-me/gate-configuration/v1\0'

/** Commit both the immutable Reviewer composition and this call's effective catalog. */
export function fingerprintGateConfigurationV1(
  reviewerConfigurationFingerprint: string,
  effectiveCatalogFingerprint: string,
): string | undefined {
  const hash = /^sha256:[0-9a-f]{64}$/
  if (!hash.test(reviewerConfigurationFingerprint) || !hash.test(effectiveCatalogFingerprint)) return undefined
  return `sha256:${createHash('sha256').update(GATE_CONFIGURATION_HASH_DOMAIN, 'utf8').update(canonicalJson({
    version: 1,
    reviewerConfigurationFingerprint,
    effectiveCatalogFingerprint,
  }), 'utf8').digest('hex')}`
}

function objectValue(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : undefined
}

/**
 * Derive the deterministic envelope input only from the verified semantic
 * action and the exact sandbox projection frozen into the dossier. Unknown
 * families or malformed targets deliberately have no fast-path representation.
 */
export function projectDossierTrustEnvelopeV1(pending: PendingApprovalSectionV1): TrustEnvelopeInputV1 | undefined {
  if (pending.confinement.kind !== 'sandbox-policy' || pending.action.semantics.family !== 'filesystem-v1') return undefined
  const semantics = objectValue(pending.action.semantics.value)
  const targets = semantics?.targets
  if (!Array.isArray(targets) || targets.length === 0) return undefined
  const paths: string[] = []
  for (const target of targets) {
    const value = objectValue(target)
    if (typeof value?.path !== 'string' || value.path.length === 0) return undefined
    paths.push(value.path)
  }
  const operation = semantics?.operation
  if (operation !== 'read' && operation !== 'glob' && operation !== 'search'
    && operation !== 'write' && operation !== 'edit' && operation !== 'delete' && operation !== 'move') return undefined
  return Object.freeze({
    toolFamily: 'filesystem' as const,
    ...pending.requestedSandboxMode === undefined ? {} : { requestedMode: pending.requestedSandboxMode },
    effectiveMode: pending.confinement.standingMode,
    workspaceRoot: pending.confinement.workspaceRoot,
    targets: Object.freeze(paths),
    ...pending.justification === undefined ? {} : { justification: pending.justification },
  })
}

const TOOL_APPROVAL_CLASSES: readonly ToolApprovalClass[] = ['ordinary', 'gate-ask', 'body-escalation']

/**
 * Rebuilds every gate key from the branded sealed packet. The current action has
 * no seal (S1: asked precedes any result seal), so its classification/binding
 * trust chain is the capture-frozen execution fact + the live catalog
 * re-validation done by the DSH adapter in `snapshotInput`; the sealed ledger
 * supplies bounded historical context but never re-derives the current action.
 */
export class DossierGateFactProjector implements SourceBackedFactProjector {
  constructor(
    private readonly generation: string,
    private readonly reviewerConfigurationFingerprint: string,
    private readonly policyVersion: string = 'policy-v1',
    /** Baseline rubric bound to the resolved Reviewer policy. */
    private readonly dangerFullAccessRisk: DangerEscalationRiskV1 = 'critical',
  ) {}

  project(input: Parameters<SourceBackedFactProjector['project']>[0]): GateActionFacts | undefined {
    const dossier = input.verifiedDossier.dossier as unknown as {
      readonly freeze: { readonly currentTurn: number }
      readonly pendingApproval: {
        readonly callId: string
        readonly toolName: string
        readonly action: ActionSnapshot
        readonly actionHash: string
        readonly projectorId: string
        readonly classification: string
        readonly classificationCatalogFingerprint: string
        readonly approvalAsked: EventRefV1
        readonly confinement: ConfinementProjectionV1
        readonly requestedSandboxMode?: 'workspace-write' | 'danger-full-access'
        readonly earlierSandboxDenials?: readonly EarlierSandboxDenialV1[]
      }
    }
    const pending = dossier.pendingApproval
    // The sealed pendingApproval leaves request (issuedIn/blockIndex) absent by
    // design; only the action/binding identity is needed here.
    if (input.request.actionHash !== input.pending.actionHash
      || pending.callId !== input.pending.callId
      || pending.toolName !== input.pending.toolName
      || pending.actionHash !== input.pending.actionHash
      || hashAction(pending.action) !== input.pending.actionHash) return undefined

    const classification = classifySealed(pending.classification)
    if (classification === undefined) return undefined

    // Provenance-only frontier: a numeric seq yields authorization.level
    // 'unknown' (no fast path, always Review). WP4-b4-1 裁定 1 accepts this.
    const frontiers: Parameters<typeof assessVerifiedActionV1>[1] = [input.sealedCurrent.frontierSeq]
    const assessment = assessVerifiedActionV1(pending.action, frontiers, pending.earlierSandboxDenials ?? [], {
      dangerFullAccessRisk: this.dangerFullAccessRisk,
    })
    const parentLifecycleFingerprint = input.facts.lifecycleFingerprint
    // WP4-b4-1a 裁定 B2: the exact-denial breaker keys only on lifecycle + turn +
    // actionHash; the allow cache keeps the direct-user frontier (cache semantics
    // unchanged), so a same-turn same-actionHash retry is fast-rejected and a new
    // turn starts a fresh breaker key.
    const breakerKey = Object.freeze({ parentLifecycleFingerprint, turn: dossier.freeze.currentTurn, actionHash: input.pending.actionHash })
    const configurationFingerprint = fingerprintGateConfigurationV1(
      this.reviewerConfigurationFingerprint,
      input.sealedCurrent.catalogCommitmentFingerprint,
    )
    if (configurationFingerprint === undefined) return undefined
    const trustEnvelope = projectDossierTrustEnvelopeV1(pending as unknown as PendingApprovalSectionV1)
    return Object.freeze({
      action: pending.action,
      toolSchemaFingerprint: input.sealedCurrent.toolSchemaFingerprint,
      classification,
      ...trustEnvelope === undefined ? {} : { trustEnvelope },
      breakerKey,
      allowCacheKey: Object.freeze({ parentLifecycleFingerprint, turn: dossier.freeze.currentTurn, directUserFrontierSeq: input.sealedCurrent.frontierSeq, actionHash: input.pending.actionHash, generation: this.generation, configurationFingerprint }),
      rootRequester: input.sealedCurrent.requester.effectiveDelegationDepth === 0
        && input.sealedCurrent.requester.parentSessionId === undefined,
      directChildOrigin: false,
      generation: this.generation,
      configurationFingerprint,
      policyVersion: this.policyVersion,
      verifiedDossier: input.verifiedDossier,
      assessment,
    })
  }
}

function classifySealed(value: unknown): ToolApprovalClassificationResult | undefined {
  if (typeof value !== 'string' || !(TOOL_APPROVAL_CLASSES as readonly string[]).includes(value)) return undefined
  return Object.freeze({ kind: 'classified' as const, classification: value as ToolApprovalClass })
}

/**
 * WP4-b4-1a 审查 B1/S-1: bounded current-action catalog in-force check. The
 * current (as-yet-unsealed) action is not in the sealed ledger, so the reader's
 * cursor does not run the old catalogAnchored in-force rule for it. This pure,
 * eventAt-driven check re-establishes that rule: the bound header must be in
 * force at the request, and no later request/header event may appear in
 * (recordedHeaderEventSeq, requestEventSeq]. It is deliberately a small bounded
 * function so it can be unit-tested rather than buried in the plugin adapter.
 */
export interface CurrentCatalogInForceInput {
  readonly recordedHeaderEventSeq: number
  readonly requestEventSeq: number
  readonly wireSchemas: readonly unknown[]
  readonly eventAt: (seq: number) => { readonly type: string; readonly data: unknown } | undefined
}

export type CurrentCatalogInForceResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'invalid-range' }
  | { readonly kind: 'header-missing' }
  | { readonly kind: 'wire-schemas-mismatch' }
  | { readonly kind: 'intervening-header'; readonly seq: number }

export function sealedCurrentCatalogInForce(input: CurrentCatalogInForceInput): CurrentCatalogInForceResult {
  const { recordedHeaderEventSeq, requestEventSeq, wireSchemas, eventAt } = input
  if (!Number.isSafeInteger(recordedHeaderEventSeq) || !Number.isSafeInteger(requestEventSeq)
    || recordedHeaderEventSeq < 0 || requestEventSeq < 0 || recordedHeaderEventSeq >= requestEventSeq) return { kind: 'invalid-range' }
  const header = eventAt(recordedHeaderEventSeq)
  if (header === undefined || header.type !== 'request/header') return { kind: 'header-missing' }
  const data = header.data as { header?: { tools?: unknown } } | undefined
  if (data === undefined || data.header === undefined) return { kind: 'header-missing' }
  try {
    if (canonicalJson(data.header.tools) !== canonicalJson(wireSchemas)) return { kind: 'wire-schemas-mismatch' }
  } catch {
    return { kind: 'wire-schemas-mismatch' }
  }
  for (let seq = recordedHeaderEventSeq + 1; seq <= requestEventSeq; seq += 1) {
    if (eventAt(seq)?.type === 'request/header') return { kind: 'intervening-header', seq }
  }
  return { kind: 'ok' }
}

/**
 * WP4-b4-1a 审查 B1 (rule 6 for the current row): one header event carries
 * exactly one catalog-commitment fingerprint. The current action's frozen
 * commitment must agree with the sealed packet's catalogEpochs entry that
 * references the same header; a disagreement means a rewrote/washed record.
 */
export interface CurrentCatalogEpochMatchInput {
  readonly recordedHeaderEventSeq: number
  readonly catalogCommitmentFingerprint: string
  readonly packetEpochs: readonly { readonly epoch: number; readonly headerEventSeq: number; readonly commitment: string }[]
}

export type CurrentCatalogEpochMatchResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'epoch-mismatch'; readonly headerEventSeq: number; readonly recorded: string; readonly current: string }

export function sealedCurrentCatalogEpochMatch(input: CurrentCatalogEpochMatchInput): CurrentCatalogEpochMatchResult {
  const epoch = input.packetEpochs.find(item => item.headerEventSeq === input.recordedHeaderEventSeq)
  if (epoch !== undefined && epoch.commitment !== input.catalogCommitmentFingerprint) {
    return { kind: 'epoch-mismatch', headerEventSeq: input.recordedHeaderEventSeq, recorded: epoch.commitment, current: input.catalogCommitmentFingerprint }
  }
  return { kind: 'ok' }
}

/**
 * WP5-a §4.4 mapping: a reader unavailable subcode becomes a typed gate reason
 * code. The §4.4 tamper/storage/projection classes map to their own typed code
 * (the gate routes them hard unavailable); the read-local `unclassified`
 * subcode (abort / identity / configuration) has no typed gate code and the
 * resolver keeps returning undefined so the gate stays unavailable without a
 * false typed reason.
 */
export function gateFailureCodeForUnavailableSubcode(subcode: SealedFactsUnavailableSubcodeV1): GateFailureCode | undefined {
  switch (subcode) {
    case 'sealed-current-conflict': return 'sealed-current-conflict'
    case 'seal-chain-invalid': return 'seal-chain-invalid'
    case 'seal-live-rebind-failed': return 'seal-live-rebind-failed'
    case 'ledger-storage-unavailable': return 'ledger-storage-unavailable'
    case 'ledger-conflict': return 'ledger-conflict'
    case 'activity-projection-invalid': return 'activity-projection-invalid'
    case 'unclassified': return undefined
  }
}

/**
 * Production gate resolver boundary. Registration only makes a one-ask lookup
 * possible; authorization facts are accepted solely after their source packet
 * compiles to a branded sealed dossier. This class deliberately has no fallback
 * to capture memory, config-only facts, or the full-history compile path.
 */
export class SourceBackedGateFactResolver implements GateActionFactResolver {
  private readonly pending = new Map<string, PendingSourceBackedAsk>()
  private readonly authorityBySession = new Map<string, ParentAuthority<Agent, string>>()

  constructor(private readonly deps: SourceBackedGateFactResolverDependencies) {}

  register(input: PendingSourceBackedAsk): void {
    if (input.requestId.length === 0 || input.callId.length === 0 || input.actionHash.length === 0) {
      throw new TypeError('source-backed ask requires non-empty requestId, callId, and actionHash')
    }
    if (input.authority.sessionId !== input.agent.session.id) {
      throw new TypeError('source-backed ask authority must be bound to the exact live agent session')
    }
    const key = this.key(input.authority.sessionId, input.requestId, input.callId, input.actionHash)
    const existing = this.pending.get(key)
    if (existing !== undefined && existing !== input) {
      throw new TypeError('source-backed ask correlation is already registered')
    }
    this.pending.set(key, input)
    this.authorityBySession.set(input.authority.sessionId, input.authority)
  }

  authorityFor(parentSessionId: string): ParentAuthority<Agent, string> | undefined {
    return this.authorityBySession.get(parentSessionId)
  }

  async resolve(request: GateMachineRequestV1): Promise<GateActionFacts | undefined> {
    const debug = (stage: string, detail?: unknown): undefined => {
      if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') console.error('[approve-for-me facts]', stage, detail ?? '')
      return undefined
    }
    if (request.signal?.aborted || request.requestId === undefined || request.callId === undefined) return debug('invalid-request')
    const key = this.key(request.parentSessionId, request.requestId, request.callId, request.actionHash)
    const pending = this.pending.get(key)
    if (pending === undefined || pending.authority.sessionId !== request.parentSessionId) return debug('missing-pending')

    const input = await this.deps.snapshotInput(pending, request.signal)
    if (input === undefined || request.signal?.aborted) return debug('missing-snapshot-input')
    if (input.agent !== pending.agent || input.approvalRequestId !== pending.requestId
      || input.callId !== pending.callId || input.toolName !== pending.toolName) return debug('snapshot-input-mismatch')
    // WP5-a: non-sensitive correlation for a metadata-only audit row when this
    // resolve throws (a sealed-facts read or compile failure surfaces before
    // GateActionFacts can be assembled).
    const correlation = this.correlation(input)
    const gateFailure = (name: GateFailureCode, message: string): GateFailure =>
      new GateFailure(name, message, correlation === undefined ? undefined : { correlation })

    const read = await this.deps.sealedFacts.read({
      agent: pending.agent,
      approvalRequestId: pending.requestId,
      callId: pending.callId,
      toolName: pending.toolName,
      maxSealedTailEvents: this.deps.maxSealedTailEvents,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (request.signal?.aborted) return debug('aborted')
    // WP4-b4 §4.4 minimal routing: integrity/pollution stays unavailable (never
    // delegates); a bounded capacity gap or an explainable unsealed current
    // action delegates in auto-then-user mode with an explicit machine code.
    switch (read.kind) {
      case 'unavailable': {
        // §4.4 routing: only a typed tamper/storage/projection subcode becomes a
        // GateFailure; the read-local unclassified subcode (abort/identity/config)
        // stays a bare unavailable with no invented reason code.
        const code = gateFailureCodeForUnavailableSubcode(read.subcode)
        if (code === undefined) return debug('sealed-unavailable', read.reason)
        throw gateFailure(code, `sealed facts unavailable (${read.reason ?? read.subcode})`)
      }
      case 'tail-budget-overflow':
        throw gateFailure('tail-budget-overflow', `approval sealed tail exceeds maxSealedTailEvents (${read.sealedCount}/${read.maxSealedTailEvents})`)
      case 'empty-ledger':
        throw gateFailure('sealed-current-missing', 'no sealed facts exist for this lifecycle; the current action is unsealed pending')
      case 'ok':
        break
    }

    // WP4-b4-1a 审查 B1 (rule 6): the current action's frozen commitment must agree
    // with the sealed packet's catalogEpochs entry for the same header.
    const epochMatch = sealedCurrentCatalogEpochMatch({
      recordedHeaderEventSeq: input.executionFact.catalogCommitment.requestHeaderEventSeq,
      catalogCommitmentFingerprint: input.executionFact.catalogCommitment.fingerprint,
      packetEpochs: read.facts.catalogEpochs,
    })
    if (epochMatch.kind !== 'ok') return debug('epoch-split-current', epochMatch)

    const current = this.currentFacts(input)
    if (current === undefined) return debug('invalid-current-facts')
    const carrier = this.carrier(input)
    if (carrier === undefined) return debug('invalid-carrier')

    const compiled = this.deps.compileSealed({
      packet: read.facts,
      current,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (compiled.kind === 'incomplete') {
      // A bounded byte-capacity gap is the one typed case that may reach the
      // official human waterfall; every other incomplete dossier shape is an
      // integrity condition and stays closed.
      if (compiled.reason === 'ledger-budget-overflow' && 'metrics' in compiled) {
        // Ledger row-count overflow is an explainable scale gap (the sealed
        // activity ledger exceeds maxLedgerEntries), routed under its own typed
        // reason code -- never as retryable-capability -- so the gate sends it to
        // the human waterfall in auto-then-user mode.
        throw gateFailure('ledger-budget-overflow', `approval sealed ledger exceeds maxLedgerEntries (${compiled.metrics.attemptCount})`)
      }
      if (compiled.reason === 'budget-overflow') {
        throw gateFailure('retryable-capability', 'approval hot packet exceeds the configured size budget')
      }
      return debug('dossier-not-ready', compiled)
    }
    if (request.signal?.aborted) return debug('aborted')
    return this.deps.projector.project({ request, pending, facts: read.facts, sealedCurrent: carrier, verifiedDossier: compiled.verified })
      ?? debug('projection-failed')
  }

  /**
   * Non-sensitive correlation for a metadata-only audit row raised by this
   * resolver. Only identity, hashes, generation and policy-version strings are
   * carried; never packet, rationale, tool arguments or content. Returns
   * undefined when a resolver is not wired with the projector metadata, in which
   * case the gate records the failure only in scalar metrics.
   */
  private correlation(input: SealedAskFactsInputV1): GateFailureCorrelationV1 | undefined {
    // Every field is read defensively: a resolver wired without the full source
    // packet correlation must still route a typed code (no metadata row) rather
    // than throw a secondary TypeError.
    const lifecycle = input.freeze?.parent
    const executionFact = input.executionFact
    const catalogCommitment = executionFact?.catalogCommitment
    const action = executionFact?.projection
    if (lifecycle === undefined || executionFact === undefined || catalogCommitment === undefined || action === undefined) return undefined
    const parentLifecycleFingerprint = canonicalJson({
      sessionId: lifecycle.sessionId,
      sessionFormatVersion: lifecycle.sessionFormatVersion,
      createdAt: lifecycle.createdAt,
      ...(lifecycle.cwd === undefined ? {} : { cwd: lifecycle.cwd }),
    })
    const configurationFingerprint = fingerprintGateConfigurationV1(
      this.deps.reviewerConfigurationFingerprint ?? '',
      catalogCommitment.fingerprint,
    )
    if (this.deps.generation === undefined || this.deps.policyVersion === undefined || configurationFingerprint === undefined) return undefined
    return Object.freeze({
      parentSessionId: lifecycle.sessionId,
      parentLifecycleFingerprint,
      requestId: input.approvalRequestId,
      callId: input.callId,
      actionHash: action.actionHash,
      generation: this.deps.generation,
      policyVersion: this.deps.policyVersion,
      configurationFingerprint,
    })
  }

  /** Assemble the sealed current facts from the capture-frozen execution fact + approval sidecar. */
  private currentFacts(input: SealedAskFactsInputV1): SealedDossierCurrentFactsV1 | undefined {
    const executionFact = input.executionFact
    const approvalSnapshot = input.approvalSnapshot
    if (approvalSnapshot.execution.requestEventSeq !== executionFact.request.eventSeq
      || approvalSnapshot.execution.callId !== executionFact.request.callId
      || approvalSnapshot.execution.toolName !== executionFact.request.toolName
      || approvalSnapshot.execution.actionHash !== executionFact.projection.actionHash
      || approvalSnapshot.execution.projectorId !== executionFact.projection.projectorId
      || approvalSnapshot.approvalAskedSeq !== input.approvalAsked.seq) return undefined
    if (validateDurableToolCatalogCommitmentV1(executionFact.catalogCommitment).kind !== 'ok') return undefined
    const descriptor = executionFact.catalogCommitment.approvalCatalog.descriptors.find(item => item.toolName === input.toolName)
    if (descriptor === undefined) return undefined
    const classification = descriptor.classification
    const sandbox = executionFact.projection.action.requestedPermissions.find(permission => permission.kind === 'sandbox')
    const requestedSandboxMode = sandbox?.scope === 'workspace-write' || sandbox?.scope === 'danger-full-access'
      ? sandbox.scope
      : undefined
    return Object.freeze({
      action: executionFact.projection.action,
      classification,
      classificationCatalogFingerprint: executionFact.toolClassification.classificationCatalogFingerprint,
      approvalRequestId: input.approvalRequestId,
      callId: input.callId,
      toolName: input.toolName,
      requestEventSeq: approvalSnapshot.execution.requestEventSeq,
      approvalAsked: input.approvalAsked,
      freeze: input.freeze,
      ...requestedSandboxMode === undefined ? {} : { requestedSandboxMode },
      // earlierSandboxDenials: Phase-1 default empty (WP4-b4-1 裁定 3). Each
      // approval is judged independently; a fresh Guardian still correlates.
      // Bounded recent excerpt channel flows through as an intent aid; compileSealed
      // is the safety boundary that validates each entry against the closed set.
      ...(input.excerpts === undefined ? {} : { excerpts: input.excerpts }),
      ...(input.excerptTruncated === undefined ? {} : { excerptTruncated: input.excerptTruncated }),
    })
  }

  /** Resolve the same-strength carrier bindings for the sealed projector. */
  private carrier(input: SealedAskFactsInputV1): SealedCurrentCarrierV1 | undefined {
    const toolSchemaFingerprint = input.executionFact.toolClassification.descriptor.toolSchemaFingerprint
    if (typeof toolSchemaFingerprint !== 'string' || toolSchemaFingerprint.length === 0) return undefined
    const catalogCommitmentFingerprint = input.executionFact.catalogCommitment.fingerprint
    if (typeof catalogCommitmentFingerprint !== 'string' || catalogCommitmentFingerprint.length === 0) return undefined
    if (!Number.isSafeInteger(input.freeze.throughSeq) || input.freeze.throughSeq < 0) return undefined
    return Object.freeze({
      toolSchemaFingerprint,
      requester: input.requester,
      frontierSeq: input.freeze.throughSeq,
      catalogCommitmentFingerprint,
    })
  }

  private key(parentSessionId: string, requestId: string, callId: string, actionHash: string): string {
    return `${parentSessionId}\0${requestId}\0${callId}\0${actionHash}`
  }
}
