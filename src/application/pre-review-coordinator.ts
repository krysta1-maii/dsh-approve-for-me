import { randomUUID } from 'node:crypto'
import { hashAction } from '../domain/protocol.js'
import type {
  ActionSnapshot,
  ApprovalDecision,
  ReviewMode,
} from '../domain/protocol.js'
import type {
  SealedDispositionLookupV1,
  SealedDispositionRegistryV1,
  SealedDispositionV1,
} from '../approval-gate/sealed-decision.js'
import type { ParentAuthority } from '../ports/managed-reviewer.js'
import type { SourceVerifiedDossierV1 } from '../domain/dossier.js'
import type { ReviewCoordinator } from './review-coordinator.js'
import { GateFailure } from './gate-failure.js'
import { validateDecisionAssessmentV1 } from '../domain/risk-assessment.js'
import type { RiskAssessmentV1 } from '../domain/risk-assessment.js'

export interface PreReviewInput<Parent, SessionId extends string> {
  readonly authority: ParentAuthority<Parent, SessionId>
  readonly requestId: string
  readonly callId: string
  readonly action: ActionSnapshot
  readonly verifiedDossier?: SourceVerifiedDossierV1
  /** R4 assessment derived from the exact source-verified dossier. */
  readonly assessment?: RiskAssessmentV1
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly generation: string
  readonly configurationFingerprint: string
  /** policy-v2 refuses uncited model authorization claims. */
  readonly policyVersion?: string
  readonly issuedAt: number
  readonly deadlineAt: number
}

export interface PreReviewCoordinator<Parent, SessionId extends string> {
  preReview(input: PreReviewInput<Parent, SessionId>): Promise<SealedDispositionV1>
  replay(input: { requestId: string; callId: string; actionHash: string }): SealedDispositionLookupV1
}

function dispositionFor(decision: ApprovalDecision): SealedDispositionV1['disposition'] {
  switch (decision.decision) {
    case 'allow': return 'allow'
    case 'deny': return 'deny'
    case 'human_review': return 'human'
  }
}

/**
 * Wraps the existing Guardian {@link ReviewCoordinator} with sealed
 * disposition semantics. A succeeded review is sealed before it is returned,
 * so any later approval ask for the same request can only replay the sealed
 * outcome — it cannot trigger a second Guardian review.
 */
export class DefaultPreReviewCoordinator<Parent, SessionId extends string>
  implements PreReviewCoordinator<Parent, SessionId> {
  constructor(
    private readonly review: ReviewCoordinator<Parent, SessionId>,
    private readonly seals: SealedDispositionRegistryV1,
    private readonly now: () => number = Date.now,
    private readonly reviewRunId: () => string = randomUUID,
  ) {}

  async preReview(input: PreReviewInput<Parent, SessionId>): Promise<SealedDispositionV1> {
    if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0
      || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= input.issuedAt) {
      throw new GateFailure('integrity', 'pre-review requires a valid absolute deadline')
    }
    if (this.now() >= input.deadlineAt) {
      throw new GateFailure('deadline', 'pre-review deadline expired before Guardian review')
    }
    if (input.verifiedDossier === undefined) {
      throw new GateFailure('integrity', 'a source-verified dossier is required before Guardian review')
    }
    const reviewRunId = this.reviewRunId()
    if (typeof reviewRunId !== 'string' || reviewRunId.length === 0) {
      throw new GateFailure('integrity', 'pre-review requires a non-empty host review run id')
    }
    const decision = await this.review.review({
      authority: input.authority,
      action: input.action,
      verifiedDossier: input.verifiedDossier,
      ...input.assessment === undefined ? {} : { assessment: input.assessment },
      reviewRunId,
      deadlineAt: input.deadlineAt,
      callId: input.callId,
      ...input.reason === undefined ? {} : { reason: input.reason },
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
    if (input.signal?.aborted) {
      throw new GateFailure('abort', 'approval review completed after its lifecycle was cancelled')
    }
    if (this.now() >= input.deadlineAt) {
      throw new GateFailure('deadline', 'pre-review deadline expired during Guardian review')
    }
    const actionHash = hashAction(input.action)
    if (
      decision.parentSessionId !== input.authority.sessionId
      || decision.actionHash !== actionHash
      || decision.generation !== input.generation
    ) {
      throw new GateFailure('integrity', 'Guardian decision identity does not match the pre-review request')
    }
    const assessmentValidity = input.assessment === undefined ? undefined
      : input.policyVersion === 'policy-v2' && decision.assessment === undefined
        ? { kind: 'under-evidenced' as const, reason: 'policy-v2 requires a cited decision assessment' }
        : validateDecisionAssessmentV1(decision, input.assessment)
    // The transport channel accepts an identity-valid model answer; this is the
    // first authority boundary that constrains its disposition using dossier
    // evidence. Under-evidence becomes human review; a prohibited allow denies.
    const dispositionKind = decision.decision !== 'allow' ? dispositionFor(decision)
      : assessmentValidity?.kind === 'under-evidenced' ? 'human'
        : assessmentValidity?.kind === 'prohibited' ? 'deny'
          : dispositionFor(decision)
    const disposition: SealedDispositionV1 = Object.freeze({
      version: 1,
      reviewRunId,
      requestId: input.requestId,
      parentSessionId: input.authority.sessionId,
      callId: input.callId,
      actionHash,
      generation: input.generation,
      configurationFingerprint: input.configurationFingerprint,
      disposition: dispositionKind,
      reviewAttempts: decision.execution.attempts,
      contaminatedRotationAttempts: decision.execution.contaminatedRotationAttempts,
      contaminatedRotations: decision.execution.contaminatedRotations,
      issuedAt: input.issuedAt,
      deadlineAt: input.deadlineAt,
      replayable: true,
    })
    this.seals.seal(disposition)
    return disposition
  }

  replay(input: { requestId: string; callId: string; actionHash: string }): SealedDispositionLookupV1 {
    return this.seals.lookup(input.requestId, input.callId, input.actionHash)
  }
}
