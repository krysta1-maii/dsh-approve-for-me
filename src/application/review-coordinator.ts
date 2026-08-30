import { randomUUID } from 'node:crypto'
import { ReviewProtocolError } from './decision-channel.js'
import type { DecisionChannel, ReviewClock } from './decision-channel.js'
import { SerialLanes } from './serial-lanes.js'
import {
  approvalReviewPacketContent,
  createApprovalReviewRequest,
  hashAction,
  parseActionSnapshot,
} from '../domain/protocol.js'
import { createApprovalReviewPacketV1, createApprovalReviewPacketV2 } from '../domain/records.js'
import type { SourceVerifiedDossierV1 } from '../domain/dossier.js'
import { canonicalJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type { ApprovalReviewPacketV1, ApprovalReviewPacketV2 } from '../domain/records.js'
import type { RiskAssessmentV1 } from '../domain/risk-assessment.js'
import type {
  ActionSnapshot,
  ApprovalDecision,
  ApprovalReviewRequest,
  ReviewerProviderDataV1,
  ReviewerTextBlock,
} from '../domain/protocol.js'
import type { ParentAuthority, ManagedReviewerPort } from '../ports/managed-reviewer.js'
import type { ReviewerDirectory } from './reviewer-directory.js'

/** True for Guarded Continuable errors that mean the selected child is contaminated. */
function isContaminationError(error: unknown): boolean {
  return error instanceof Error && /contaminated|unauthorized transcript/i.test(error.message)
}

/**
 * R6 deliberately keeps the business-attempt retry vocabulary closed. Raw
 * delivery/provider errors have no typed host contract yet, so retrying them
 * could repeat an unknown side effect. A routed malformed result is the only
 * repairable protocol failure currently proven to belong to this review.
 */
function isRetryableAttemptFailure(error: unknown): boolean {
  return error instanceof ReviewProtocolError && error.code === 'invalid-result'
}

function dossierBindsReviewAction(
  verified: SourceVerifiedDossierV1,
  action: ActionSnapshot,
  authoritySessionId: string,
  callId: string | undefined,
): boolean {
  if (verified.dossier.freeze.parent.sessionId !== authoritySessionId) return false
  const pending = verified.dossier.pendingApproval
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) return false
  const value = pending as Record<string, unknown>
  if (typeof value.callId !== 'string' || value.callId.length === 0
    || (callId !== undefined && value.callId !== callId)
    || typeof value.actionHash !== 'string') return false
  try {
    const pendingAction = parseActionSnapshot(value.action)
    return value.actionHash === hashAction(action)
      && canonicalJson(pendingAction) === canonicalJson(action)
  } catch {
    return false
  }
}

/** One complete application-owned approval review. */
export interface ReviewCoordinator<Parent, SessionId extends string> {
  review(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly action: ActionSnapshot
    readonly verifiedDossier: SourceVerifiedDossierV1
    /** Source-derived R4 evidence, which selects the assessed packet codec. */
    readonly assessment?: RiskAssessmentV1
    /** Host-owned business-run correlation, preserved outside the wire protocol. */
    readonly reviewRunId?: string
    /** One absolute deadline shared by all protocol attempts in this run. */
    readonly deadlineAt?: number
    readonly callId?: string
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<ApprovalDecision>
}

export interface ReviewCoordinatorOptions<Parent, SessionId extends string> {
  readonly port: ManagedReviewerPort<Parent, SessionId>
  readonly directory: ReviewerDirectory<Parent, SessionId>
  readonly channel: DecisionChannel
  readonly lane: SerialLanes
  readonly timeoutMs: number
  readonly preset: ReviewerProviderDataV1
  readonly now?: () => number
  readonly reviewId?: () => string
  readonly buildContent?: (packet: ApprovalReviewPacketV1 | ApprovalReviewPacketV2) => readonly ReviewerTextBlock[]
}

/**
 * Orchestrates one approval against a per-parent lane:
 * ensure child → arm the channel → deliver the request → await the decision
 * → interrupt the child when the review fails.
 */
export class DefaultReviewCoordinator<Parent, SessionId extends string>
  implements ReviewCoordinator<Parent, SessionId> {
  private readonly now: () => number
  private readonly reviewId: () => string
  private readonly buildContent: (packet: ApprovalReviewPacketV1 | ApprovalReviewPacketV2) => readonly ReviewerTextBlock[]

  constructor(private readonly options: ReviewCoordinatorOptions<Parent, SessionId>) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }
    this.now = options.now ?? Date.now
    this.reviewId = options.reviewId ?? randomUUID
    this.buildContent = options.buildContent ?? approvalReviewPacketContent
  }

  review(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly action: ActionSnapshot
    readonly verifiedDossier: SourceVerifiedDossierV1
    /** Source-derived R4 evidence, which selects the assessed packet codec. */
    readonly assessment?: RiskAssessmentV1
    /** Host-owned business-run correlation, preserved outside the wire protocol. */
    readonly reviewRunId?: string
    /** One absolute deadline shared by all protocol attempts in this run. */
    readonly deadlineAt?: number
    readonly callId?: string
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<ApprovalDecision> {
    const action = parseActionSnapshot(input.action)
    if (input.signal?.aborted) {
      // An already-aborted review never enters the lane: no child ensure, no
      // deliver, no interrupt.
      return Promise.reject(new ReviewProtocolError('aborted', 'review was aborted before it started'))
    }
    if (!dossierBindsReviewAction(input.verifiedDossier, action, input.authority.sessionId, input.callId)) {
      return Promise.reject(new ReviewProtocolError('invalid-result', 'review action is not bound to the verified dossier'))
    }
    // The business review owns one absolute deadline across every recovery
    // attempt. A contaminated-child rotation is infrastructure recovery, not a
    // new review window, so it must never extend the authority granted to the
    // Reviewer. Pre-review owns the production deadline; standalone callers
    // retain the bounded legacy fallback.
    const startedAt = this.now()
    const deadlineAt = input.deadlineAt ?? startedAt + this.options.timeoutMs
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= startedAt) {
      return Promise.reject(new ReviewProtocolError('timed-out', 'review deadline is absent or already expired'))
    }
    return this.options.lane.run(input.authority.sessionId, async () => {
      // At most two business attempts may share the immutable evidence and
      // deadline. Child contamination is separate infrastructure recovery and
      // never consumes one of those attempts.
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this.reviewAttempt(input, action, deadlineAt)
        } catch (error: unknown) {
          lastError = error
          if (attempt === 0 && isRetryableAttemptFailure(error)) continue
          throw error
        }
      }
      throw lastError
    })
  }

  /** Recover a freshly discovered contaminated child at most once. */
  private async reviewAttempt(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly action: ActionSnapshot
      readonly verifiedDossier: SourceVerifiedDossierV1
      readonly assessment?: RiskAssessmentV1
      readonly reviewRunId?: string
      readonly deadlineAt?: number
      readonly callId?: string
      readonly reason?: string
      readonly signal?: AbortSignal
    },
    action: ActionSnapshot,
    deadlineAt: number,
  ): Promise<ApprovalDecision> {
    let lastError: unknown
    for (let recovery = 0; recovery < 2; recovery += 1) {
      try {
        return await this.reviewOnce(input, action, deadlineAt)
      } catch (error: unknown) {
        lastError = error
        if (recovery === 0 && isContaminationError(error)) continue
        throw error
      }
    }
    throw lastError
  }

  private async reviewOnce(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly action: ActionSnapshot
      readonly verifiedDossier: SourceVerifiedDossierV1
      readonly assessment?: RiskAssessmentV1
      readonly callId?: string
      readonly reason?: string
      readonly signal?: AbortSignal
    },
    action: ActionSnapshot,
    deadlineAt: number,
  ): Promise<ApprovalDecision> {
    if (input.signal?.aborted) {
      throw new ReviewProtocolError('aborted', 'review was aborted before an attempt started')
    }
    if (this.now() >= deadlineAt) {
      throw new ReviewProtocolError('timed-out', 'review reached its business deadline before an attempt started')
    }
    const childId = await this.options.directory.ensure(
      input.authority,
      this.options.preset,
      input.signal,
    )
    const issuedAt = this.now()
    if (issuedAt >= deadlineAt) {
      throw new ReviewProtocolError('timed-out', 'review reached its business deadline before delivery')
    }
    const request = createApprovalReviewRequest(action, {
      reviewId: this.reviewId(),
      parentSessionId: input.authority.sessionId,
      reviewerSessionId: childId,
      generation: this.options.preset.generation,
      ...input.callId === undefined ? {} : { callId: input.callId },
      ...input.reason === undefined ? {} : { reason: input.reason },
      issuedAt,
      deadlineAt,
    })
    // `arm` throws synchronously when the request can never be pending
    // (disposed channel, duplicate id, abort racing past the early check,
    // expired deadline): such a review is never delivered to the child.
    const packet = input.assessment === undefined
      ? createApprovalReviewPacketV1({
          request,
          dossier: input.verifiedDossier.dossier as unknown as JsonValue,
          dossierHash: input.verifiedDossier.dossierHash,
        })
      : createApprovalReviewPacketV2({
          request,
          dossier: input.verifiedDossier.dossier as unknown as JsonValue,
          dossierHash: input.verifiedDossier.dossierHash,
          policy: {
            version: this.options.preset.policyVersion,
            configurationFingerprint: this.options.preset.configurationFingerprint,
          },
          baseline: input.assessment,
        })
    const result = this.options.channel.arm(request, input.signal)
    // A very fast scoped tool may settle before deliver()'s acceptance promise
    // resumes this task. Attach containment immediately while preserving the
    // original promise for the authoritative await below.
    void result.catch(() => undefined)
    try {
      await this.options.port.deliver(
        input.authority,
        childId,
        this.buildContent(packet),
        input.signal === undefined ? {} : { signal: input.signal },
      )
    } catch (error: unknown) {
      this.options.channel.cancel(request.reviewId, 'delivery-failed', `review ${request.reviewId} delivery failed`)
      await result.catch(() => undefined)
      if (isContaminationError(error)) {
        // Drain the contaminated child and reserve a clean replacement before
        // the retry selects a child from the durable catalog.
        await this.options.port.rotate(input.authority, childId, input.signal)
      }
      throw error
    }
    try {
      return await result
    } catch (error: unknown) {
      if (error instanceof ReviewProtocolError && error.code !== 'disposed') {
        this.options.port.interrupt(input.authority, childId)
      }
      throw error
    }
  }
}
