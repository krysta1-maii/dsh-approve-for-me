import type { ActionSnapshot } from '../domain/protocol.js'
import type {
  AllowCacheKeyV1,
  AllowCacheV1,
  ExactDenialBreakerKeyV1,
  ExactDenialBreakerV1,
} from '../approval-gate/breaker.js'
import type { ToolApprovalClassificationResult } from '../approval-gate/catalog.js'
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
import { GateFailure, gateFailureOutcome, GATE_FAILURE_CODES } from './gate-failure.js'
import type { GateFailureCode } from './gate-failure.js'
import type { GateFailureCorrelationV1 } from './gate-failure.js'
import type { GateFailureMetricsSink } from '../ports/gate-failure-metrics.js'
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
  readonly deadlineAt: number
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
export type GateDecisionRouteV1 = 'trust-envelope' | 'allow-cache' | 'sealed-replay' | 'guardian' | 'exact-denial-breaker' | 'post-facts-failure'
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
  readonly version: 2
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
  /** Exact Reviewer policy contract used for this decision. */
  readonly policyVersion: string
  /** Composite Reviewer-configuration + effective-tool-catalog commitment. */
  readonly configurationFingerprint: string
  /** Record-local no-decision is never a sealed disposition. */
  readonly disposition: GateRecordDispositionV1
  /** Present only for a post-facts no-decision outcome. */
  readonly failureStage?: GateFailureStageV1
  /** WP5-a §4.4 typed failure reason code; present only for a post-facts no-decision row. */
  readonly failureCode?: GateFailureCode
  /** Number of protocol attempts in the real Guardian run; zero for fast paths. */
  readonly reviewAttempts: number
  /** Infrastructure recovery counts, separate from protocol attempts. */
  readonly contaminatedRotationAttempts: number
  readonly contaminatedRotations: number
}

export type GateDecisionRecordResult = 'confirmed' | 'conflict' | 'unavailable'

const GATE_DECISION_ROUTES = ['trust-envelope', 'allow-cache', 'sealed-replay', 'guardian', 'exact-denial-breaker', 'post-facts-failure'] as const
const GATE_PLUGIN_DISPOSITIONS = ['allow', 'deny', 'delegate-human', 'unavailable', 'cancelled', 'delegate'] as const
const GATE_NORMALIZED_DECISIONS = ['allow', 'deny', 'human_review', 'no-decision'] as const
const GATE_RECORD_DISPOSITIONS = ['allow', 'deny', 'human', 'no-decision'] as const
const GATE_FAILURE_STAGES = ['verified-dossier', 'requester', 'classification', 'assessment', 'breaker', 'sealed-replay', 'pre-review', 'deadline', 'unexpected'] as const
const GATE_HASH = /^sha256:[0-9a-f]{64}$/

/** Validates the closed, metadata-only production audit row before persistence. */
export function parseGateDecisionRecord(input: unknown): GateDecisionRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('gate decision record must be an object')
  const value = input as Record<string, unknown>
  const legacy = value.version === 1
  const required = ['version', 'route', 'normalizedDecision', 'pluginDisposition', 'requestId', 'parentSessionId', 'parentLifecycleFingerprint', 'callId', 'actionHash', 'generation', 'configurationFingerprint', 'disposition', 'reviewAttempts', 'contaminatedRotationAttempts', 'contaminatedRotations']
  if (!legacy) required.push('policyVersion')
  const allowed = new Set([...required, 'reviewRunId', 'failureStage', 'policyVersion', 'failureCode'])
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`gate decision record.${key} is required`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`gate decision record.${key} is not supported`)
  if (!legacy && value.version !== 2) throw new TypeError('gate decision record.version must be 1 or 2')
  if (!GATE_DECISION_ROUTES.includes(value.route as GateDecisionRouteV1)) throw new TypeError('gate decision record.route is invalid')
  if (!GATE_NORMALIZED_DECISIONS.includes(value.normalizedDecision as GateDecisionRecord['normalizedDecision'])) throw new TypeError('gate decision record.normalizedDecision is invalid')
  if (!GATE_PLUGIN_DISPOSITIONS.includes(value.pluginDisposition as GatePluginDispositionV1)) throw new TypeError('gate decision record.pluginDisposition is invalid')
  if (!GATE_RECORD_DISPOSITIONS.includes(value.disposition as GateRecordDispositionV1)) throw new TypeError('gate decision record.disposition is invalid')
  for (const key of ['requestId', 'parentSessionId', 'parentLifecycleFingerprint', 'callId', 'generation'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw new TypeError(`gate decision record.${key} is invalid`)
  }
  if (!legacy && (typeof value.policyVersion !== 'string' || value.policyVersion.length === 0)) {
    throw new TypeError('gate decision record.policyVersion is invalid')
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
  const failureCode = value.failureCode as GateFailureCode | undefined
  if (normalized === 'no-decision') {
    // WP5-a 闭集拒绝未知码: a failureCode outside the closed gate code set is a
    // hard rejection at the compact durable boundary, never a silent accept.
    if (failureCode !== undefined && !GATE_FAILURE_CODES.includes(failureCode)) {
      throw new TypeError('gate decision record.failureCode is invalid')
    }
    if (route !== 'post-facts-failure' || disposition !== 'no-decision'
      || (plugin !== 'unavailable' && plugin !== 'delegate')
      || !GATE_FAILURE_STAGES.includes(value.failureStage as GateFailureStageV1)
      || value.reviewRunId !== undefined
      || attempts !== 0 || rotations !== 0 || successfulRotations !== 0) {
      throw new TypeError('gate no-decision record is inconsistent')
    }
  } else {
    if (failureCode !== undefined) throw new TypeError('gate decision record failureCode is only valid for a no-decision post-facts-failure row')
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
  return Object.freeze({
    ...value,
    version: 2,
    policyVersion: legacy ? 'policy-v1-legacy-unbound' : value.policyVersion,
  }) as unknown as GateDecisionRecord
}

export interface GateDecisionRecordStore {
  createConfirmed(record: GateDecisionRecord): Promise<GateDecisionRecordResult>
  recordBestEffort(record: GateDecisionRecord): Promise<void>
  /**
   * WP5-c: read-only, metadata-only reason-code query. Resolves the typed Gate
   * failure code recorded on the most recent post-facts-failure decision row for
   * an approval request id, or `undefined` when there is no such record or the
   * read cannot be satisfied. It exposes ONLY the non-sensitive reason code.
   * The caller (renderer sidecar) already degrades a miss to the generic line.
   */
  readReasonCode(requestId: string): Promise<GateFailureCode | undefined>
}

export interface GatePreReview {
  preReview(input: GatePreReviewInput): Promise<SealedDispositionV1>
}

export interface GatePipelineDependencies {
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
  /** WP5-a §4.4 scalar-only gate failure counter; it never influences a gate branch. */
  readonly gateFailureMetrics?: GateFailureMetricsSink
}

export interface GatePipeline {
  decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1>
}

function failureRecordFor(
  request: GateMachineRequestV1,
  facts: GateActionFacts,
  outcome: 'unavailable' | 'delegate',
  failureStage: GateFailureStageV1,
  failureCode?: GateFailureCode,
): GateDecisionRecord {
  return {
    version: 2,
    route: 'post-facts-failure',
    normalizedDecision: 'no-decision',
    pluginDisposition: outcome,
    disposition: 'no-decision',
    failureStage,
    ...(failureCode === undefined ? {} : { failureCode }),
    requestId: request.requestId ?? '',
    parentSessionId: request.parentSessionId,
    parentLifecycleFingerprint: facts.breakerKey.parentLifecycleFingerprint,
    callId: request.callId ?? '',
    actionHash: request.actionHash,
    generation: facts.generation,
    policyVersion: facts.policyVersion ?? 'policy-v1',
    configurationFingerprint: facts.configurationFingerprint,
    reviewAttempts: 0,
    contaminatedRotationAttempts: 0,
    contaminatedRotations: 0,
  }
}

/**
 * Build a metadata-only post-facts row for a GateFailure that surfaced before
 * GateActionFacts could be assembled (WP5-a). The correlation carries only
 * identity, hashes, generation and policy-version strings.
 */
function failureRecordWithCorrelation(
  correlation: GateFailureCorrelationV1,
  outcome: 'unavailable' | 'delegate',
  failureStage: GateFailureStageV1,
  failureCode: GateFailureCode,
): GateDecisionRecord {
  return {
    version: 2,
    route: 'post-facts-failure',
    normalizedDecision: 'no-decision',
    pluginDisposition: outcome,
    disposition: 'no-decision',
    failureStage,
    failureCode,
    requestId: correlation.requestId,
    parentSessionId: correlation.parentSessionId,
    parentLifecycleFingerprint: correlation.parentLifecycleFingerprint,
    callId: correlation.callId,
    actionHash: correlation.actionHash,
    generation: correlation.generation,
    policyVersion: correlation.policyVersion,
    configurationFingerprint: correlation.configurationFingerprint,
    reviewAttempts: 0,
    contaminatedRotationAttempts: 0,
    contaminatedRotations: 0,
  }
}

/** Map a gate failure code to the closed post-facts failure stage it surfaces at. */
function failureStageForGateCode(code: GateFailureCode): GateFailureStageV1 {
  switch (code) {
    case 'deadline': return 'deadline'
    case 'abort': return 'pre-review'
    // WP5-a §4.4 source-backed facts failures all surface at the verified-dossier
    // boundary (the sealed-facts read/compile), so they are recorded there.
    default: return 'verified-dossier'
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
    version: 2,
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
    policyVersion: facts.policyVersion ?? 'policy-v1',
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
    if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= this.now()) return 'unavailable'
    if (request.requestId === undefined || request.callId === undefined) return 'unavailable'
    let outcome: GateMachineDecisionV1
    try {
      outcome = await this.decideVerified(request)
    } catch (error: unknown) {
      if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') console.error('[approve-for-me gate]', error)
      outcome = gateFailureOutcome(error, this.deps.mode)
      // WP5-a §4.4: a source-backed GateFailure surfaces before GateActionFacts
      // can be assembled, so it is observed in scalar metrics and (when it
      // carries the non-sensitive correlation) recorded as a metadata-only
      // post-facts row. A cancelled/abort outcome is not a failure row.
      if (error instanceof GateFailure && (outcome === 'unavailable' || outcome === 'delegate')) {
        this.observeGateFailureSafely(error.code, outcome)
        if (error.correlation !== undefined) {
          await this.recordBestEffortSafely(failureRecordWithCorrelation(error.correlation, outcome, failureStageForGateCode(error.code), error.code))
        }
      }
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
    const afterFacts = this.terminalBoundary(request)
    if (afterFacts !== undefined) return afterFacts
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
    // A configured trust envelope is itself a standing administrative grant
    // over a source-verified structural action. User-message authorization is
    // still required for cache/sealed replay; it must not disable that separate
    // deterministic envelope contract.
    const authorizationFastPathsAllowed = facts.assessment === undefined || permitsAutomaticFastPath(facts.assessment)

    if (this.deps.breaker.lookup(facts.breakerKey)) {
      await this.recordBestEffortSafely(recordFor(request, facts, 'deny', 'exact-denial-breaker', 'deny'))
      return 'rejected'
    }

    if (facts.trustEnvelope !== undefined && this.deps.trustEnvelope.evaluate(facts.trustEnvelope).kind === 'inside') {
      const beforeRecord = this.terminalBoundary(request)
      if (beforeRecord !== undefined) return beforeRecord
      const record = recordFor(request, facts, 'allow', 'trust-envelope', 'allow')
      const result = await this.deps.records.createConfirmed(record)
      if (result === 'confirmed') {
        const beforeGrant = this.terminalBoundary(request)
        if (beforeGrant !== undefined) return beforeGrant
        this.deps.allowCache.recordGuardianAllow(facts.allowCacheKey)
        return 'allowed-once'
      }
      if (result === 'conflict') return 'unavailable'
      return this.delegateOrUnavailable()
    }

    if (authorizationFastPathsAllowed && this.deps.allowCache.lookup(facts.allowCacheKey)) {
      // A cache entry is only an optimization over a prior Guardian decision;
      // each distinct approval ask still needs its own durable confirmation
      // before it can receive an automatic grant.
      const beforeRecord = this.terminalBoundary(request)
      if (beforeRecord !== undefined) return beforeRecord
      const result = await this.deps.records.createConfirmed(recordFor(request, facts, 'allow', 'allow-cache', 'allow'))
      if (result === 'confirmed') {
        return this.terminalBoundary(request) ?? 'allowed-once'
      }
      if (result === 'conflict') return 'unavailable'
      return this.delegateOrUnavailable()
    }

    if (authorizationFastPathsAllowed) {
      const replay = this.deps.seals.lookup(requestId, callId, request.actionHash)
      if (replay.kind === 'sealed') {
        const now = this.now()
        const beforeReplay = this.terminalBoundary(request)
        if (beforeReplay !== undefined) return beforeReplay
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
        const beforeRecord = this.terminalBoundary(request)
        if (beforeRecord !== undefined) return beforeRecord
        const result = await this.deps.records.createConfirmed(
          recordFor(request, facts, 'allow', 'sealed-replay', 'allow', replay.disposition.reviewRunId, replay.disposition),
        )
        if (result !== 'confirmed') return result === 'conflict'
          ? 'unavailable'
          : this.finishPostFactsFailure(request, facts, this.delegateOrUnavailable(), 'sealed-replay')
        const beforeGrant = this.terminalBoundary(request)
        if (beforeGrant !== undefined) return beforeGrant
        if (replay.disposition.deadlineAt <= this.now()) return 'unavailable'
        return 'allowed-once'
      }
      if (replay.kind === 'consumed' || replay.kind === 'mismatch') {
        return this.finishPostFactsFailure(request, facts, 'unavailable', 'sealed-replay')
      }
    }

    const beforeReview = this.terminalBoundary(request)
    if (beforeReview !== undefined) return beforeReview
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
        deadlineAt: request.deadlineAt,
        generation: facts.generation,
        configurationFingerprint: facts.configurationFingerprint,
        ...facts.policyVersion === undefined ? {} : { policyVersion: facts.policyVersion },
      })
    } catch (error: unknown) {
      const outcome = gateFailureOutcome(error, this.deps.mode)
      if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') {
        console.error('[approve-for-me gate] pre-review failure', JSON.stringify({
          outcome,
          code: error instanceof GateFailure ? error.code : 'non-gate',
          message: error instanceof Error ? error.message : String(error),
        }))
      }
      if (outcome === 'cancelled' || (outcome !== 'unavailable' && outcome !== 'delegate')) return outcome
      const stage: GateFailureStageV1 = error instanceof GateFailure && error.code === 'deadline'
        ? 'deadline'
        : error instanceof GateFailure ? 'pre-review' : 'unexpected'
      const failureCode = error instanceof GateFailure ? error.code : undefined
      if (failureCode !== undefined) this.observeGateFailureSafely(failureCode, outcome)
      return this.finishPostFactsFailure(request, facts, outcome, stage, failureCode)
    }
    if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') {
      console.error('[approve-for-me gate] sealed', JSON.stringify({
        disposition: sealed.disposition,
        deadlineAt: sealed.deadlineAt,
        now: this.deps.now?.() ?? Date.now(),
      }))
    }
    const afterReview = this.terminalBoundary(request)
    if (afterReview !== undefined) return afterReview
    if (sealed.deadlineAt <= this.now()) return 'unavailable'
    const mapped = this.mapDisposition(sealed.disposition)
    const pluginDisposition: GatePluginDispositionV1 = sealed.disposition === 'allow'
      ? 'allow'
      : sealed.disposition === 'deny' ? 'deny' : 'delegate-human'
    const record = recordFor(request, facts, sealed.disposition === 'human' ? 'human_review' : sealed.disposition, 'guardian', pluginDisposition, sealed.reviewRunId, sealed)

    if (mapped === 'allowed-once') {
      const beforeRecord = this.terminalBoundary(request)
      if (beforeRecord !== undefined) return beforeRecord
      const result = await this.deps.records.createConfirmed(record)
      if (result === 'conflict') return 'unavailable'
      if (result !== 'confirmed') return this.delegateOrUnavailable()
      // Durable confirmation is asynchronous; expiration while it was pending
      // must not turn a previously-valid disposition into a late grant.
      const beforeGrant = this.terminalBoundary(request)
      if (beforeGrant !== undefined) return beforeGrant
      if (sealed.deadlineAt <= this.now()) return 'unavailable'
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

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Re-check the complete authorization boundary after every asynchronous step. */
  private terminalBoundary(request: GateMachineRequestV1): 'cancelled' | 'unavailable' | undefined {
    if (request.signal?.aborted) return 'cancelled'
    if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= this.now()) return 'unavailable'
    return undefined
  }

  private async recordBestEffortSafely(record: GateDecisionRecord): Promise<void> {
    try { await this.deps.records.recordBestEffort(record) } catch { /* audit must not authorize */ }
  }

  private observeGateFailureSafely(code: GateFailureCode, outcome: 'unavailable' | 'delegate'): void {
    try { this.deps.gateFailureMetrics?.observe({ code, outcome }) } catch { /* telemetry is never authorizing */ }
  }

  private async finishPostFactsFailure(
    request: GateMachineRequestV1,
    facts: GateActionFacts,
    outcome: 'unavailable' | 'delegate',
    failureStage: GateFailureStageV1,
    failureCode?: GateFailureCode,
  ): Promise<GateMachineDecisionV1> {
    await this.recordBestEffortSafely(failureRecordFor(request, facts, outcome, failureStage, failureCode))
    return outcome
  }

  private delegateOrUnavailable(): 'delegate' | 'unavailable' {
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
