import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GateMachineRequestV1 } from '../approval-gate/machine-policy.js'
import type { ParentAuthority } from '../ports/managed-reviewer.js'
import type { ParentSessionFactSource } from '../ports/parent-session-facts.js'
import type { GuardianDossierCompiler, InteractionSectionV1, ParentSessionFactSnapshotV1, PendingApprovalSectionV1, ToolTrajectorySectionV1 } from '../domain/dossier.js'
import { validateDurableToolCatalogCommitmentV1 } from '../domain/dossier.js'
import type { GateActionFactResolver, GateActionFacts } from './gate-pipeline.js'
import { GateFailure } from './gate-failure.js'
import { canonicalJson } from '../domain/json.js'
import type { ToolApprovalClass } from '../approval-gate/catalog.js'
import { hashAction } from '../domain/protocol.js'
import { assessVerifiedActionV1 } from '../domain/risk-assessment.js'
import type { TrustEnvelopeInputV1 } from '../approval-gate/trust-envelope.js'

/**
 * A pending approval handle is correlation metadata only. It intentionally
 * contains no precomputed classification, scope, cache key, or action facts:
 * those values must be reconstructed from the frozen Session snapshot.
 */
export interface PendingSourceBackedAsk {
  readonly agent: Agent
  readonly requestId: string
  readonly callId: string
  readonly toolName: string
  readonly actionHash: string
  readonly authority: ParentAuthority<Agent, string>
}

export interface SourceBackedFactProjector {
  project(input: {
    readonly request: GateMachineRequestV1
    readonly pending: PendingSourceBackedAsk
    readonly facts: ParentSessionFactSnapshotV1
    readonly verifiedDossier: NonNullable<ReturnType<GuardianDossierCompiler['compile']> & { readonly kind: 'ready' }>['verified']
  }): GateActionFacts | undefined
}

export interface SourceBackedGateFactResolverDependencies {
  readonly factSource: ParentSessionFactSource
  readonly compiler: GuardianDossierCompiler
  readonly projector: SourceBackedFactProjector
  /** Obtains the exact projections for this same immutable approval ask. */
  snapshotInput(pending: PendingSourceBackedAsk, signal?: AbortSignal): Promise<Parameters<ParentSessionFactSource['snapshot']>[0] | undefined>
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

/**
 * Rebuilds every gate key from the branded packet instead of registration-time
 * capture metadata. A packet lacking a direct user frontier cannot be cached or
 * automatically authorized.
 */
export class DossierGateFactProjector implements SourceBackedFactProjector {
  constructor(
    private readonly generation: string,
    private readonly reviewerConfigurationFingerprint: string,
    private readonly policyVersion: string = 'policy-v1',
  ) {}

  project(input: Parameters<SourceBackedFactProjector['project']>[0]): GateActionFacts | undefined {
    const dossier = input.verifiedDossier.dossier as unknown as {
      readonly freeze: { readonly currentTurn: number }
      readonly environment: { readonly requestHeader?: unknown }
      readonly interaction: InteractionSectionV1
      readonly currentTurnTools: ToolTrajectorySectionV1
      readonly pendingApproval: PendingApprovalSectionV1
    }
    const pending = dossier.pendingApproval
    if (input.request.actionHash !== input.pending.actionHash
      || pending.callId !== input.pending.callId
      || pending.toolName !== input.pending.toolName
      || pending.actionHash !== input.pending.actionHash
      || hashAction(pending.action) !== input.pending.actionHash) return undefined
    const approvalSnapshot = input.facts.approvalSnapshots.find(item =>
      item.approvalRequestId === input.pending.requestId
      && item.approvalAskedSeq === input.facts.approvalBinding.event.seq)
    if (approvalSnapshot === undefined) return undefined
    const execution = input.facts.executionFacts.find(item =>
      item.request.eventSeq === approvalSnapshot.execution.requestEventSeq
      && item.request.callId === pending.callId
      && item.request.toolName === pending.toolName)
    if (execution === undefined || validateDurableToolCatalogCommitmentV1(execution.catalogCommitment).kind !== 'ok') return undefined
    const dossierCatalog = input.facts.eventProjection.classificationCatalog
    if (canonicalJson(dossierCatalog) !== canonicalJson(execution.catalogCommitment.classificationCatalog)) return undefined
    const dossierDescriptor = dossierCatalog.descriptors.find(item => item.toolName === pending.toolName)
    const approvalDescriptor = execution.catalogCommitment.approvalCatalog.descriptors.find(item => item.toolName === pending.toolName)
    if (dossierDescriptor === undefined || approvalDescriptor === undefined
      || approvalDescriptor.toolSchemaFingerprint !== dossierDescriptor.toolSchemaFingerprint) return undefined
    const approvalClass: ToolApprovalClass | undefined = approvalDescriptor.classification
    if (approvalClass === undefined) return undefined
    const classification = Object.freeze({ kind: 'classified' as const, classification: approvalClass })
    const descriptor = { toolSchemaFingerprint: dossierDescriptor.toolSchemaFingerprint }
    const currentInteraction = dossier.interaction.turns.find(turn => turn.turn === dossier.freeze.currentTurn)
    const currentMessages = currentInteraction?.directUserMessages.map(message => Object.freeze({
      seq: message.event.seq,
      content: message.content,
      surfaceState: message.surfaceState,
    })) ?? []
    const latest = currentMessages.reduce<(typeof currentMessages)[number] | undefined>(
      (candidate, message) => candidate === undefined || message.seq > candidate.seq ? message : candidate,
      undefined,
    )
    const requestSeq = (attempt: ToolTrajectorySectionV1['attempts'][number]): number | undefined =>
      attempt.request.kind === 'code-dispatch' ? attempt.request.dispatchStart.seq : attempt.request.callEvent?.seq
    // A next-action grant is consumed by any intervening attempted tool call,
    // including delegation/orchestration calls kept in their separate ledger.
    // Outcome and child creation are irrelevant: the attempt itself consumes it.
    const priorAttempts = [
      ...dossier.currentTurnTools.attempts,
      ...dossier.interaction.delegations.entries.map(entry => entry.attempt),
    ]
    if (latest === undefined || priorAttempts.some(attempt => {
      const seq = requestSeq(attempt)
      const isPendingAction = attempt.request.callId === pending.callId
        && seq === execution.request.eventSeq
      return !isPendingAction && seq !== undefined && seq > latest.seq
    })) return undefined
    const frontiers = Object.freeze([latest])
    const directUserFrontierSeq = latest.seq
    const assessment = assessVerifiedActionV1(pending.action, frontiers, pending.earlierSandboxDenials)
    const parentLifecycleFingerprint = canonicalJson(input.facts.session)
    const key = Object.freeze({ parentLifecycleFingerprint, turn: dossier.freeze.currentTurn, directUserFrontierSeq, actionHash: input.pending.actionHash })
    const configurationFingerprint = fingerprintGateConfigurationV1(
      this.reviewerConfigurationFingerprint,
      execution.catalogCommitment.fingerprint,
    )
    if (configurationFingerprint === undefined) return undefined
    const trustEnvelope = projectDossierTrustEnvelopeV1(pending)
    return Object.freeze({
      action: pending.action,
      toolSchemaFingerprint: descriptor.toolSchemaFingerprint,
      classification,
      ...trustEnvelope === undefined ? {} : { trustEnvelope },
      breakerKey: key,
      allowCacheKey: Object.freeze({ ...key, generation: this.generation, configurationFingerprint }),
      rootRequester: input.facts.session.effectiveDelegationDepth === 0 && input.facts.session.parentSessionId === undefined,
      directChildOrigin: false,
      generation: this.generation,
      configurationFingerprint,
      policyVersion: this.policyVersion,
      verifiedDossier: input.verifiedDossier,
      assessment,
    })
  }
}

/**
 * Production gate resolver boundary. Registration only makes a one-ask lookup
 * possible; authorization facts are accepted solely after their source packet
 * compiles to a branded dossier. This class deliberately has no fallback to
 * capture memory or config-only facts.
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
    // Do not permit a producer to substitute a related Agent/request here.
    if (input.agent !== pending.agent || input.approvalRequestId !== pending.requestId
      || input.callId !== pending.callId || input.toolName !== pending.toolName) return debug('snapshot-input-mismatch')
    const facts = this.deps.factSource.snapshot(input)
    if (facts === undefined || request.signal?.aborted) return debug('missing-facts')
    const compiled = this.deps.compiler.compile(request.signal === undefined
      ? { facts }
      : { facts, signal: request.signal })
    if (compiled.kind === 'incomplete' && compiled.reason === 'budget-overflow') {
      // A bounded capability gap is the one typed case that may reach the
      // official human waterfall in auto-then-user mode; every other
      // incomplete dossier shape is an integrity condition and stays closed.
      throw new GateFailure('retryable-capability', 'approval dossier exceeds the configured size budget')
    }
    if (compiled.kind !== 'ready' || request.signal?.aborted) return debug('dossier-not-ready', compiled)
    return this.deps.projector.project({ request, pending, facts, verifiedDossier: compiled.verified })
      ?? debug('projection-failed')
  }

  private key(parentSessionId: string, requestId: string, callId: string, actionHash: string): string {
    return `${parentSessionId}\0${requestId}\0${callId}\0${actionHash}`
  }
}
