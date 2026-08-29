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
import { gateFailureOutcome } from './gate-failure.js'

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
}

export interface GateActionFactResolver {
  resolve(request: GateMachineRequestV1): Promise<GateActionFacts | undefined>
}

export interface GatePreReviewInput {
  readonly requestId: string
  readonly parentSessionId: string
  readonly callId: string
  readonly action: ActionSnapshot
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly generation: string
  readonly configurationFingerprint: string
}

/**
 * Minimal decision-record port used by the gate before H4 hardens it with a
 * durable Storage Domain implementation. The three-state result is the
 * security-critical distinction between "cannot confirm right now" and
 * "the record conflicts with an existing decision".
 */
export interface GateDecisionRecord {
  readonly reviewRunId: string
  readonly requestId: string
  readonly parentSessionId: string
  readonly callId: string
  readonly actionHash: string
  readonly generation: string
  readonly configurationFingerprint: string
  readonly disposition: SealedDispositionKind
}

export type GateDecisionRecordResult = 'confirmed' | 'conflict' | 'unavailable'

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
  readonly now?: () => number
}

export interface GatePipeline {
  decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1>
}

function recordFor(
  request: GateMachineRequestV1,
  facts: GateActionFacts,
  disposition: SealedDispositionKind,
  reviewRunId: string,
): GateDecisionRecord {
  return {
    reviewRunId,
    requestId: request.requestId ?? '',
    parentSessionId: request.parentSessionId,
    callId: request.callId ?? '',
    actionHash: request.actionHash,
    generation: facts.generation,
    configurationFingerprint: facts.configurationFingerprint,
    disposition,
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
    try {
      return await this.decideVerified(request)
    } catch (error: unknown) {
      return gateFailureOutcome(error, this.deps.mode)
    }
  }

  private async decideVerified(request: GateMachineRequestV1): Promise<GateMachineDecisionV1> {
    const requestId = request.requestId
    const callId = request.callId
    if (requestId === undefined || callId === undefined) return 'unavailable'
    const facts = await this.deps.facts.resolve(request)
    if (facts === undefined) return 'unavailable'
    if (facts.directChildOrigin || !facts.rootRequester) return 'unavailable'

    const classification = facts.classification
    if (classification.kind === 'catalog-mismatch') return 'unavailable'
    if (classification.kind === 'unclassified') return 'unavailable'

    if (this.deps.breaker.lookup(facts.breakerKey)) return 'rejected'

    if (facts.trustEnvelope !== undefined && this.deps.trustEnvelope.evaluate(facts.trustEnvelope).kind === 'inside') {
      const record = recordFor(request, facts, 'allow', requestId)
      const result = await this.deps.records.createConfirmed(record)
      if (result === 'confirmed') {
        this.deps.allowCache.recordGuardianAllow(facts.allowCacheKey)
        return 'allowed-once'
      }
      if (result === 'conflict') return 'unavailable'
      return this.delegateOrUnavailable()
    }

    if (this.deps.allowCache.lookup(facts.allowCacheKey)) return 'allowed-once'

    {
      const replay = this.deps.seals.lookup(requestId, callId, request.actionHash)
      if (replay.kind === 'sealed') {
        const now = this.deps.now?.() ?? Date.now()
        if (!replay.disposition.replayable || replay.disposition.deadlineAt < now) return 'unavailable'
        // A sealed outcome is a single-use replay for an ask identity. Consuming
        // here closes the infinite-replay hole; if another path raced us, the
        // registry reports consumed and the gate fails closed.
        if (!this.deps.seals.consume(requestId, callId)) return 'unavailable'
        return this.mapDisposition(replay.disposition.disposition)
      }
      if (replay.kind === 'consumed' || replay.kind === 'mismatch') return 'unavailable'
    }

    const sealed = await this.deps.preReview.preReview({
      requestId,
      parentSessionId: request.parentSessionId,
      callId,
      action: facts.action,
      ...request.reason === undefined ? {} : { reason: request.reason },
      ...request.signal === undefined ? {} : { signal: request.signal },
      generation: facts.generation,
      configurationFingerprint: facts.configurationFingerprint,
    })
    const mapped = this.mapDisposition(sealed.disposition)
    const record = recordFor(request, facts, sealed.disposition, sealed.reviewRunId)

    if (mapped === 'allowed-once') {
      const result = await this.deps.records.createConfirmed(record)
      if (result === 'conflict') return 'unavailable'
      if (result !== 'confirmed') return this.delegateOrUnavailable()
      this.deps.allowCache.recordGuardianAllow(facts.allowCacheKey)
    } else if (mapped === 'rejected') {
      await this.deps.records.recordBestEffort(record)
      this.deps.breaker.recordGuardianDeny(facts.breakerKey)
    }
    return mapped
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
