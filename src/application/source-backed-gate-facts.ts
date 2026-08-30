import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GateMachineRequestV1 } from '../approval-gate/machine-policy.js'
import type { ParentAuthority } from '../ports/managed-reviewer.js'
import type { ParentSessionFactSource } from '../ports/parent-session-facts.js'
import type { GuardianDossierCompiler, InteractionSectionV1, ParentSessionFactSnapshotV1, PendingApprovalSectionV1 } from '../domain/dossier.js'
import type { GateActionFactResolver, GateActionFacts } from './gate-pipeline.js'
import type { ToolApprovalClassifier } from '../approval-gate/catalog.js'
import { canonicalJson } from '../domain/json.js'
import { hashAction } from '../domain/protocol.js'
import { assessVerifiedActionV1 } from '../domain/risk-assessment.js'

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

/**
 * Rebuilds every gate key from the branded packet instead of registration-time
 * capture metadata. A packet lacking a direct user frontier cannot be cached or
 * automatically authorized.
 */
export class DossierGateFactProjector implements SourceBackedFactProjector {
  constructor(
    private readonly classifier: ToolApprovalClassifier,
    private readonly generation: string,
    private readonly configurationFingerprint: string,
    private readonly policyVersion: string = 'policy-v1',
  ) {}

  project(input: Parameters<SourceBackedFactProjector['project']>[0]): GateActionFacts | undefined {
    const dossier = input.verifiedDossier.dossier as unknown as {
      readonly freeze: { readonly currentTurn: number }
      readonly interaction: InteractionSectionV1
      readonly pendingApproval: PendingApprovalSectionV1
    }
    const pending = dossier.pendingApproval
    if (input.request.actionHash !== input.pending.actionHash
      || pending.callId !== input.pending.callId
      || pending.toolName !== input.pending.toolName
      || pending.actionHash !== input.pending.actionHash
      || hashAction(pending.action) !== input.pending.actionHash) return undefined
    const descriptor = input.facts.eventProjection.classificationCatalog.descriptors.find(item =>
      item.toolName === pending.toolName)
    if (descriptor === undefined) return undefined
    const classification = this.classifier.classify({
      toolName: pending.toolName,
      toolSchemaFingerprint: descriptor.toolSchemaFingerprint,
    })
    const frontiers = dossier.interaction.turns.flatMap(turn =>
      turn.directUserMessages.map(message => message.event.seq))
    const directUserFrontierSeq = frontiers.length === 0 ? undefined : Math.max(...frontiers)
    if (directUserFrontierSeq === undefined) return undefined
    const assessment = assessVerifiedActionV1(pending.action, frontiers)
    const parentLifecycleFingerprint = canonicalJson(input.facts.session)
    const key = Object.freeze({ parentLifecycleFingerprint, turn: dossier.freeze.currentTurn, directUserFrontierSeq, actionHash: input.pending.actionHash })
    return Object.freeze({
      action: pending.action,
      toolSchemaFingerprint: descriptor.toolSchemaFingerprint,
      classification,
      breakerKey: key,
      allowCacheKey: Object.freeze({ ...key, generation: this.generation, configurationFingerprint: this.configurationFingerprint }),
      rootRequester: input.facts.session.effectiveDelegationDepth === 0 && input.facts.session.parentSessionId === undefined,
      directChildOrigin: false,
      generation: this.generation,
      configurationFingerprint: this.configurationFingerprint,
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
    if (request.signal?.aborted || request.requestId === undefined || request.callId === undefined) return undefined
    const key = this.key(request.parentSessionId, request.requestId, request.callId, request.actionHash)
    const pending = this.pending.get(key)
    if (pending === undefined || pending.authority.sessionId !== request.parentSessionId) return undefined

    const input = await this.deps.snapshotInput(pending, request.signal)
    if (input === undefined || request.signal?.aborted) return undefined
    // Do not permit a producer to substitute a related Agent/request here.
    if (input.agent !== pending.agent || input.approvalRequestId !== pending.requestId
      || input.callId !== pending.callId || input.toolName !== pending.toolName) return undefined
    const facts = this.deps.factSource.snapshot(input)
    if (facts === undefined || request.signal?.aborted) return undefined
    const compiled = this.deps.compiler.compile(request.signal === undefined
      ? { facts }
      : { facts, signal: request.signal })
    if (compiled.kind !== 'ready' || request.signal?.aborted) return undefined
    return this.deps.projector.project({ request, pending, facts, verifiedDossier: compiled.verified })
  }

  private key(parentSessionId: string, requestId: string, callId: string, actionHash: string): string {
    return `${parentSessionId}\0${requestId}\0${callId}\0${actionHash}`
  }
}
