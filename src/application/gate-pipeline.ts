import type { ActionSnapshot } from '../domain/protocol.js'
import type {
  AllowCacheKeyV1,
  AllowCacheV1,
  ExactDenialBreakerKeyV1,
  ExactDenialBreakerV1,
} from '../approval-gate/breaker.js'
import type { ToolApprovalClassificationResult, ToolApprovalClassifier } from '../approval-gate/catalog.js'
import type {
  GateMachineDecisionV1,
  GateMachineRequestV1,
} from '../approval-gate/machine-policy.js'
import type {
  SealedDispositionKind,
  SealedDispositionRegistryV1,
  SealedDispositionV1,
} from '../approval-gate/sealed-decision.js'
import type {
  TrustEnvelopeEvaluatorV1,
  TrustEnvelopeInputV1,
} from '../approval-gate/trust-envelope.js'
import { GateFailure, gateFailureOutcome } from './gate-failure.js'
import type { SourceVerifiedDossierV1 } from '../domain/dossier.js'
import { permitsAutomaticFastPath } from '../domain/risk-assessment.js'
import type { RiskAssessmentV1 } from '../domain/risk-assessment.js'
import type { ReviewerTelemetrySink } from '../ports/reviewer-telemetry.js'

/**
 * Resolved facts that the DSH adapter/application layer must supply before the
 * gate can execute. This is the seam where D1's source-backed dossier will
 * eventually provide immutable, verified execution facts; until then callers
 * may resolve from the in-memory capture store.
 */
export interface GateActionFacts {
  readonly action: ActionSnapshot
  readonly toolSchemaFingerprint: string
  readonly classification: ToolApprovalClassificationResult
  readonly trustEnvelope?: TrustEnvelopeInputV1
  readonly breakerKey: ExactDenialBreakerKeyV1
  readonly allowCacheKey: AllowCacheKeyV1
  readonly rootRequester: boolean
  readonly directChildOrigin: boolean
  readonly generation: string
  readonly configurationFingerprint: string
  /** Immutable Reviewer policy selected for this composition generation. */
  readonly policyVersion?: string
  /** Source-verified evidence required for production authorization. */
  readonly verifiedDossier?: SourceVerifiedDossierV1
  /** R4 assessment derived only from the verified dossier. */
  readonly assessment?: RiskAssessmentV1
}

export interface GateActionFactResolver {
  resolve(request: GateMachineRequestV1): Promise<GateActionFacts | undefined>
}

export interface GatePreReviewInput {
  readonly requestId: string
  readonly parentSessionId: string
  readonly callId: string
  readonly action: ActionSnapshot
  readonly verifiedDossier?: SourceVerifiedDossierV1
  /** Source-derived R4 facts that must constrain the sealed disposition. */
  readonly assessment?: RiskAssessmentV1
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly generation: string
  readonly configurationFingerprint: string
  /** Whether this review must use the cited assessment schema. */
  readonly policyVersion?: string
}

/**
 * Minimal decision-record port used by the gate before H4 hardens it with a
 * durable Storage Domain implementation. The three-state result is the
 * security-critical distinction between "cannot confirm right now" and
 * "the record conflicts with an existing decision".
 */
export type GateDecisionRouteV1 = 'trust-envelope' | 'allow-cache' | 'sealed-replay' | 'guardian' | 'post-facts-failure'
export type GatePluginDispositionV1 = 'allow' | 'deny' | 'delegate-human' | 'unavailable' | 'cancelled' | 'delegate'
export type GateRecordDispositionV1 = SealedDispositionKind | 'no-decision'
export type GateFailureStageV1 =
  | 'verified-dossier'
  | 'requester'
  | 'classification'
  | 'assessment'
  | 'breaker'
  | 'sealed-replay'
  | 'pre-review'
  | 'deadline'
  | 'unexpected'

/**
 * Default-minimal durable audit record. It intentionally carries only identity,
 * route and normalized outcome metadata; no packet, rationale or tool arguments.
 */
export interface GateDecisionRecord {
  readonly version: 1
  /** Present only for a real Guardian/sealed review, never synthesized for fast paths. */
  readonly reviewRunId?: string
  readonly route: GateDecisionRouteV1
  readonly normalizedDecision: 'allow' | 'deny' | 'human_review' | 'no-decision'
  readonly pluginDisposition: GatePluginDispositionV1
  readonly requestId: string
  readonly parentSessionId: string
  /** Canonical full lifecycle identity; bare session IDs are reusable. */
  readonly parentLifecycleFingerprint: string
  readonly callId: string
  readonly actionHash: string
  readonly generation: string
  readonly configurationFingerprint: string
  /** Record-local no-decision is never a sealed disposition. */
  readonly disposition: GateRecordDispositionV1
  /** Present only for a post-facts no-decision outcome. */
  readonly failureStage?: GateFailureStageV1
  /** Number of protocol attempts in the real Guardian run; zero for fast paths. */
  readonly reviewAttempts: number
  /** Infrastructure recovery counts, separate from protocol attempts. */
  readonly contaminatedRotationAttempts: number
  readonly contaminatedRotations: number
}

export type GateDecisionRecordResult = 'confirmed' | 'conflict' | 'unavailable'

const GATE_DECISION_ROUTES = ['trust-envelope', 'allow-cache', 'sealed-replay', 'guardian', 'post-facts-failure'] as const
const GATE_PLUGIN_DISPOSITIONS = ['allow', 'deny', 'delegate-human', 'unavailable', 'cancelled', 'delegate'] as const
const GATE_NORMALIZED_DECISIONS = ['allow', 'deny', 'human_review', 'no-decision'] as const
const GATE_RECORD_DISPOSITIONS = ['allow', 'deny', 'human', 'no-decision'] as const
const GATE_FAILURE_STAGES = ['verified-dossier', 'requester', 'classification', 'assessment', 'breaker', 'sealed-replay', 'pre-review', 'deadline', 'unexpected'] as const
const GATE_HASH = /^sha256:[0-9a-f]{64}$/

/** Validates the closed, metadata-only production audit row before persistence. */
export function parseGateDecisionRecord(input: unknown): GateDecisionRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('gate decision record must be an object')
  const value = input as Record<string, unknown>
  const required = ['version', 'route', 'normalizedDecision', 'pluginDisposition', 'requestId', 'parentSessionId', 'parentLifecycleFingerprint', 'callId', 'actionHash', 'generation', 'configurationFingerprint', 'disposition', 'reviewAttempts', 'contaminatedRotationAttempts', 'contaminatedRotations']
  const allowed = new Set([...required, 'reviewRunId', 'failureStage'])
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`gate decision record.${key} is required`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`gate decision record.${key} is not supported`)
  if (value.version !== 1) throw new TypeError('gate decision record.version must be 1')
  if (!GATE_DECISION_ROUTES.includes(value.route as GateDecisionRouteV1)) throw new TypeError('gate decision record.route is invalid')
  if (!GATE_NORMALIZED_DECISIONS.includes(value.normalizedDecision as GateDecisionRecord['normalizedDecision'])) throw new TypeError('gate decision record.normalizedDecision is invalid')
  if (!GATE_PLUGIN_DISPOSITIONS.includes(value.pluginDisposition as GatePluginDispositionV1)) throw new TypeError('gate decision record.pluginDisposition is invalid')
  if (!GATE_RECORD_DISPOSITIONS.includes(value.disposition as GateRecordDispositionV1)) throw new TypeError('gate decision record.disposition is invalid')
  for (const key of ['requestId', 'parentSessionId', 'parentLifecycleFingerprint', 'callId', 'generation'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw new TypeError(`gate decision record.${key} is invalid`)
  }
  for (const key of ['actionHash', 'configurationFingerprint'] as const) {
    if (typeof value[key] !== 'string' || !GATE_HASH.test(value[key])) throw new TypeError(`gate decision record.${key} must be a sha256 digest`)
  }
  for (const key of ['reviewAttempts', 'contaminatedRotationAttempts', 'contaminatedRotations'] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new TypeError(`gate decision record.${key} is invalid`)
  }
  if (value.reviewRunId !== undefined && (typeof value.reviewRunId !== 'string' || value.reviewRunId.length === 0)) {
    throw new TypeError('gate decision record.reviewRunId is invalid')
  }
  const normalized = value.normalizedDecision as GateDecisionRecord['normalizedDecision']
  const disposition = value.disposition as GateRecordDispositionV1
  const plugin = value.pluginDisposition as GatePluginDispositionV1
  const route = value.route as GateDecisionRouteV1
  const attempts = value.reviewAttempts as number
  const rotations = value.contaminatedRotationAttempts as number
  const successfulRotations = value.contaminatedRotations as number
  if (normalized === 'no-decision') {
    if (route !== 'post-facts-failure' || disposition !== 'no-decision'
      || (plugin !== 'unavailable' && plugin !== 'delegate')
      || !GATE_FAILURE_STAGES.includes(value.failureStage as GateFailureStageV1)
      || value.reviewRunId !== undefined
      || attempts !== 0 || rotations !== 0 || successfulRotations !== 0) {
      throw new TypeError('gate no-decision record is inconsistent')
    }
  } else {
    if (value.failureStage !== undefined
      || (normalized === 'allow' && (disposition !== 'allow' || plugin !== 'allow'))
      || (normalized === 'deny' && (disposition !== 'deny' || plugin !== 'deny'))
      || (normalized === 'human_review' && (disposition !== 'human' || plugin !== 'delegate-human'))) {
      throw new TypeError('gate decision record decision fields are inconsistent')
    }
    const reviewRoute = route === 'guardian' || route === 'sealed-replay'
    if (reviewRoute !== (value.reviewRunId !== undefined)) {
      throw new TypeError('gate decision record reviewRunId does not match its route')
    }
    if ((!reviewRoute && (attempts !== 0 || rotations !== 0 || successfulRotations !== 0))
      || (reviewRoute && attempts < 1)
      || successfulRotations > rotations) {
      throw new TypeError('gate decision record execution summary is inconsistent with its route')
    }
  }
  return Object.freeze({ ...value }) as unknown as GateDecisionRecord
}

export interface GateDecisionRecordStore {
  createConfirmed(record: GateDecisionRecord): Promise<GateDecisionRecordResult>
  recordBestEffort(record: GateDecisionRecord): Promise<void>
}

export interface GatePreReview {
  preReview(input: GatePreReviewInput): Promise<SealedDispositionV1>
}

export interface GatePipelineDependencies {
  readonly classifier: ToolApprovalClassifier
  readonly trustEnvelope: TrustEnvelopeEvaluatorV1
  readonly breaker: ExactDenialBreakerV1
  readonly allowCache: AllowCacheV1
  readonly seals: SealedDispositionRegistryV1
  readonly facts: GateActionFactResolver
  readonly preReview: GatePreReview
  readonly records: GateDecisionRecordStore
  readonly mode: 'auto' | 'auto-then-user'
  /** Production adapter enables this until a source-verified dossier is present. */
  readonly requireVerifiedDossier?: boolean
  readonly now?: () => number
  /** Scalar-only best-effort observer; it never influences a gate branch. */
  readonly reviewerTelemetry?: ReviewerTelemetrySink
}

export interface GatePipeline {
  decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1>
}

function failureRecordFor(
  request: GateMachineRequestV1,
  facts: GateActionFacts,
  outcome: 'unavailable' | 'delegate',
  failureStage: GateFailureStageV1,
): GateDecisionRecord {
  return {
    version: 1,
    route: 'post-facts-failure',
    normalizedDecision: 'no-decision',
    pluginDisposition: outcome,
    disposition: 'no-decision',
    failureStage,
    requestId: request.requestId ?? '',
    parentSessionId: request.parentSessionId,
    parentLifecycleFingerprint: facts.breakerKey.parentLifecycleFingerprint,
    callId: request.callId ?? '',
    actionHash: request.actionHash,
    generation: facts.generation,
    configurationFingerprint: facts.configurationFingerprint,
    reviewAttempts: 0,
    contaminatedRotationAttempts: 0,
    contaminatedRotations: 0,
  }
}

function recordFor(
  request: GateMachineRequestV1,
  facts: GateActionFacts,
  normalizedDecision: GateDecisionRecord['normalizedDecision'],
  route: GateDecisionRouteV1,
  pluginDisposition: GatePluginDispositionV1,
  reviewRunId?: string,
  execution: Pick<SealedDispositionV1, 'reviewAttempts' | 'contaminatedRotationAttempts' | 'contaminatedRotations'> = {
    reviewAttempts: 0, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
  },
): GateDecisionRecord {
  return {
    version: 1,
    route,
    normalizedDecision,
    pluginDisposition,
    ...reviewRunId === undefined ? {} : { reviewRunId },
    requestId: request.requestId ?? '',
    parentSessionId: request.parentSessionId,
    parentLifecycleFingerprint: facts.breakerKey.parentLifecycleFingerprint,
    callId: request.callId ?? '',
    actionHash: request.actionHash,
    generation: facts.generation,
    configurationFingerprint: facts.configurationFingerprint,
    disposition: normalizedDecision === 'human_review' ? 'human' : normalizedDecision,
    reviewAttempts: execution.reviewAttempts,
    contaminatedRotationAttempts: execution.contaminatedRotationAttempts,
    contaminatedRotations: execution.contaminatedRotations,
  }
}

/**
 * Deterministic gate pipeline:
 *
 * 1. identity/classification/root-requester conflict checks
 * 2. exact denial breaker
 * 3. trust-envelope fast path
 * 4. allow cache
 * 5. sealed-disposition replay
 * 6. Guardian pre-review
 * 7. mode mapping with durable decision-record semantics
 *
 * Conflicts never delegate in either mode; only “unknown/no call/not
 * covered” style gaps may delegate in `auto-then-user`.
 */
export class DefaultGatePipeline implements GatePipeline {
  constructor(private readonly deps: GatePipelineDependencies) {}

  async decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1> {
    if (request.signal?.aborted) return 'cancelled'
    if (request.requestId === undefined || request.callId === undefined) return 'unavailable'
    let outcome: GateMachineDecisionV1
    try {
      outcome = await this.decideVerified(request)
    } catch (error: unknown) {
      outcome = gateFailureOutcome(error, this.deps.mode)
    }
    // Only a concrete user fallback is observed, after the authoritative gate
    // outcome is fixed. Telemetry has no async path or authority over it.
    if (outcome === 'delegate') {
      try { this.deps.reviewerTelemetry?.observe({ kind: 'fallback' }) } catch { /* non-authorizing */ }
    }
    return outcome
  }

  private async decideVerified(request: GateMachineRequestV1): Promise<GateMachineDecisionV1> {
    const requestId = request.requestId
    const callId = request.callId
    if (requestId === undefined || callId === undefined) return 'unavailable'
    const facts = await this.deps.facts.resolve(request)
    if (request.signal?.aborted) return 'cancelled'
    if (facts === undefined) return 'unavailable'
    // This precedes every trust/cache/replay route; a packet-less action can
    // never acquire an automatic authorization in the real plugin.
    if (this.deps.requireVerifiedDossier && facts.verifiedDossier === undefined) {
      return this.finishPostFactsFailure(request, facts, 'unavailable', 'verified-dossier')
    }
    if (facts.directChildOrigin || !facts.rootRequester) {
      return this.finishPostFactsFailure(request, facts, 'unavailable', 'requester')
    }

    const classification = facts.classification
    if (classification.kind === 'catalog-mismatch' || classification.kind === 'unclassified') {
      return this.finishPostFactsFailure(request, facts, 'unavailable', 'classification')
    }
    // R4 never upgrades unverified/unknown authorization into an automatic
    // grant. It deliberately still permits Guardian pre-review below.
    if (this.deps.requireVerifiedDossier && facts.assessment === undefined) {
      return this.finishPostFactsFailure(request, facts, 'unavailable', 'assessment')
    }
    const fastPathsAllowed = facts.assessment === undefined || permitsAutomaticFastPath(facts.assessment)

    if (this.deps.breaker.lookup(facts.breakerKey)) return 'rejected'

    if (fastPathsAllowed && facts.trustEnvelope !== undefined && this.deps.trustEnvelope.evaluate(facts.trustEnvelope).kind === 'inside') {
      if (request.signal?.aborted) return 'cancelled'
      const record = recordFor(request, facts, 'allow', 'trust-envelope', 'allow')
      const result = await this.deps.records.createConfirmed(record)
      if (result === 'confirmed') {
        if (request.signal?.aborted) return 'cancelled'
        this.deps.allowCache.recordGuardianAllow(facts.allowCacheKey)
        return 'allowed-once'
      }
      if (result === 'conflict') return 'unavailable'
      return this.delegateOrUnavailable()
    }

    if (fastPathsAllowed && this.deps.allowCache.lookup(facts.allowCacheKey)) {
      // A cache entry is only an optimization over a prior Guardian decision;
      // each distinct approval ask still needs its own durable confirmation
      // before it can receive an automatic grant.
      const result = await this.deps.records.createConfirmed(recordFor(request, facts, 'allow', 'allow-cache', 'allow'))
      if (result === 'confirmed') {
        if (request.signal?.aborted) return 'cancelled'
        return 'allowed-once'
      }
      if (result === 'conflict') return 'unavailable'
      return this.delegateOrUnavailable()
    }

    if (fastPathsAllowed) {
      const replay = this.deps.seals.lookup(requestId, callId, request.actionHash)
      if (replay.kind === 'sealed') {
        const now = this.deps.now?.() ?? Date.now()
        if (!replay.disposition.replayable || replay.disposition.deadlineAt <= now) {
          return this.finishPostFactsFailure(request, facts, 'unavailable', 'sealed-replay')
        }
        // A sealed outcome is a single-use replay for an ask identity. Consuming
        // here closes the infinite-replay hole; if another path raced us, the
        // registry reports consumed and the gate fails closed.
        if (!this.deps.seals.consume(requestId, callId)) {
          return this.finishPostFactsFailure(request, facts, 'unavailable', 'sealed-replay')
        }
        const mapped = this.mapDisposition(replay.disposition.disposition)
        if (mapped !== 'allowed-once') {
          await this.recordBestEffortSafely(recordFor(
            request,
            facts,
            replay.disposition.disposition === 'human' ? 'human_review' : replay.disposition.disposition,
            'sealed-replay',
            replay.disposition.disposition === 'deny' ? 'deny' : 'delegate-human',
            replay.disposition.reviewRunId,
            replay.disposition,
          ))
          return mapped
        }
        const result = await this.deps.records.createConfirmed(
          recordFor(request, facts, 'allow', 'sealed-replay', 'allow', replay.disposition.reviewRunId, replay.disposition),
        )
        if (result !== 'confirmed') return result === 'conflict' ? 'unavailable' : this.delegateOrUnavailable()
        if (request.signal?.aborted) return 'cancelled'
        if (replay.disposition.deadlineAt <= (this.deps.now?.() ?? Date.now())) return 'unavailable'
        return 'allowed-once'
      }
      if (replay.kind === 'consumed' || replay.kind === 'mismatch') {
        return this.finishPostFactsFailure(request, facts, 'unavailable', 'sealed-replay')
      }
    }

    let sealed: SealedDispositionV1
    try {
      sealed = await this.deps.preReview.preReview({
        requestId,
        parentSessionId: request.parentSessionId,
        callId,
        action: facts.action,
        ...facts.verifiedDossier === undefined ? {} : { verifiedDossier: facts.verifiedDossier },
        ...facts.assessment === undefined ? {} : { assessment: facts.assessment },
        ...request.reason === undefined ? {} : { reason: request.reason },
        ...request.signal === undefined ? {} : { signal: request.signal },
        generation: facts.generation,
        configurationFingerprint: facts.configurationFingerprint,
        ...facts.policyVersion === undefined ? {} : { policyVersion: facts.policyVersion },
      })
    } catch (error: unknown) {
      const outcome = gateFailureOutcome(error, this.deps.mode)
      if (outcome === 'cancelled' || (outcome !== 'unavailable' && outcome !== 'delegate')) return outcome
      const stage: GateFailureStageV1 = error instanceof GateFailure && error.code === 'deadline'
        ? 'deadline'
        : error instanceof GateFailure ? 'pre-review' : 'unexpected'
      return this.finishPostFactsFailure(request, facts, outcome, stage)
    }
    if (request.signal?.aborted) return 'cancelled'
    if (sealed.deadlineAt <= (this.deps.now?.() ?? Date.now())) return 'unavailable'
    const mapped = this.mapDisposition(sealed.disposition)
    const pluginDisposition: GatePluginDispositionV1 = sealed.disposition === 'allow'
      ? 'allow'
      : sealed.disposition === 'deny' ? 'deny' : 'delegate-human'
    const record = recordFor(request, facts, sealed.disposition === 'human' ? 'human_review' : sealed.disposition, 'guardian', pluginDisposition, sealed.reviewRunId, sealed)

    if (mapped === 'allowed-once') {
      const result = await this.deps.records.createConfirmed(record)
      if (result === 'conflict') return 'unavailable'
      if (result !== 'confirmed') return this.delegateOrUnavailable()
      // Durable confirmation is asynchronous; expiration while it was pending
      // must not turn a previously-valid disposition into a late grant.
      if (request.signal?.aborted) return 'cancelled'
      if (sealed.deadlineAt <= (this.deps.now?.() ?? Date.now())) return 'unavailable'
      this.deps.allowCache.recordGuardianAllow(facts.allowCacheKey)
    } else {
      // Audit failure cannot convert a deny/human result into authorization or
      // erase its safety outcome. Allows use createConfirmed above instead.
      await this.recordBestEffortSafely(record)
      // Only an explicit Guardian deny can establish an exact rejection
      // circuit. Human fallback maps to rejected in `auto` mode but is not a
      // denial fact and must never suppress a future independent review.
      if (mapped === 'rejected' && sealed.disposition === 'deny') {
        this.deps.breaker.recordGuardianDeny(facts.breakerKey)
      }
    }
    return mapped
  }

  private async recordBestEffortSafely(record: GateDecisionRecord): Promise<void> {
    try { await this.deps.records.recordBestEffort(record) } catch { /* audit must not authorize */ }
  }

  private async finishPostFactsFailure(
    request: GateMachineRequestV1,
    facts: GateActionFacts,
    outcome: 'unavailable' | 'delegate',
    failureStage: GateFailureStageV1,
  ): Promise<GateMachineDecisionV1> {
    await this.recordBestEffortSafely(failureRecordFor(request, facts, outcome, failureStage))
    return outcome
  }

  private delegateOrUnavailable(): GateMachineDecisionV1 {
    return this.deps.mode === 'auto-then-user' ? 'delegate' : 'unavailable'
  }

  private mapDisposition(disposition: SealedDispositionKind): GateMachineDecisionV1 {
    switch (disposition) {
      case 'allow': return 'allowed-once'
      case 'deny': return 'rejected'
      case 'human': return this.deps.mode === 'auto-then-user' ? 'delegate' : 'rejected'
    }
  }
}
