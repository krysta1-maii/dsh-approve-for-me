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
import type { ReviewerTelemetryFailureV1, ReviewerTelemetrySink } from '../ports/reviewer-telemetry.js'

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

interface ReviewerTelemetryRunState {
  attempts: number
  rotationAttempts: number
  rotations: number
}

const systemReviewClock: ReviewClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** One cancellation source and race shared by every await in a business review. */
class ReviewDeadlineScope {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly timer: unknown
  private deadlineExpired = false
  private disposed = false
  private readonly onCallerAbort?: () => void

  constructor(
    private readonly deadlineAt: number,
    callerSignal: AbortSignal | undefined,
    private readonly clock: ReviewClock,
  ) {
    this.signal = this.controller.signal
    if (callerSignal !== undefined) {
      this.onCallerAbort = () => { this.controller.abort() }
      callerSignal.addEventListener('abort', this.onCallerAbort, { once: true })
    }
    const remaining = Math.max(0, deadlineAt - clock.now())
    this.timer = clock.setTimeout(() => {
      this.deadlineExpired = true
      this.controller.abort()
    }, remaining)
    if (callerSignal?.aborted) this.controller.abort()
  }

  async wait<T>(operation: PromiseLike<T>): Promise<T> {
    this.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        this.signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => finish(() => reject(this.failure()))
      this.signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(operation).then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      )
      if (this.signal.aborted) onAbort()
    })
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw this.failure()
  }

  close(callerSignal?: AbortSignal): void {
    if (this.disposed) return
    this.disposed = true
    this.clock.clearTimeout(this.timer)
    if (callerSignal !== undefined && this.onCallerAbort !== undefined) {
      callerSignal.removeEventListener('abort', this.onCallerAbort)
    }
  }

  private failure(): ReviewProtocolError {
    return this.deadlineExpired || this.clock.now() >= this.deadlineAt
      ? new ReviewProtocolError('timed-out', 'review reached its absolute business deadline')
      : new ReviewProtocolError('aborted', 'review lifecycle was cancelled')
  }
}

/** Bounded, content-free execution summary for the sealed audit boundary. */
export interface ReviewExecutionSummaryV1 {
  readonly attempts: number
  readonly contaminatedRotationAttempts: number
  readonly contaminatedRotations: number
}

export type ReviewOutcomeV1 = ApprovalDecision & { readonly execution: ReviewExecutionSummaryV1 }

function telemetryFailure(error: unknown): ReviewerTelemetryFailureV1 {
  if (!(error instanceof ReviewProtocolError)) return 'infrastructure'
  switch (error.code) {
    case 'invalid-result': return 'invalid-result'
    case 'timed-out': return 'timed-out'
    case 'aborted': return 'aborted'
    case 'disposed': return 'disposed'
    case 'delivery-failed': return 'delivery-failed'
    default: return 'infrastructure'
  }
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
  }): Promise<ReviewOutcomeV1>
}

export interface ReviewCoordinatorOptions<Parent, SessionId extends string> {
  readonly port: ManagedReviewerPort<Parent, SessionId>
  readonly directory: ReviewerDirectory<Parent, SessionId>
  readonly channel: DecisionChannel
  readonly lane: SerialLanes
  readonly timeoutMs: number
  readonly preset: ReviewerProviderDataV1
  /** Scheduler shared with the decision channel for deterministic absolute deadlines. */
  readonly clock?: ReviewClock
  readonly now?: () => number
  readonly reviewId?: () => string
  readonly buildContent?: (packet: ApprovalReviewPacketV1 | ApprovalReviewPacketV2) => readonly ReviewerTextBlock[]
  /** Scalar-only observer invoked after a Reviewer run settles. */
  readonly telemetry?: ReviewerTelemetrySink
}

/**
 * Orchestrates one approval against a per-parent lane:
 * ensure child → arm the channel → deliver the request → await the decision
 * → interrupt the child when the review fails.
 */
export class DefaultReviewCoordinator<Parent, SessionId extends string>
  implements ReviewCoordinator<Parent, SessionId> {
  private readonly clock: ReviewClock
  private readonly now: () => number
  private readonly reviewId: () => string
  private readonly buildContent: (packet: ApprovalReviewPacketV1 | ApprovalReviewPacketV2) => readonly ReviewerTextBlock[]

  constructor(private readonly options: ReviewCoordinatorOptions<Parent, SessionId>) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }
    this.clock = options.clock ?? systemReviewClock
    this.now = options.now ?? this.clock.now
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
  }): Promise<ReviewOutcomeV1> {
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
    const telemetry: ReviewerTelemetryRunState = { attempts: 0, rotationAttempts: 0, rotations: 0 }
    const deadline = new ReviewDeadlineScope(deadlineAt, input.signal, this.clock)
    const laneRun = this.options.lane.run(input.authority.sessionId, async () => {
      deadline.throwIfAborted()
      // At most two business attempts may share the immutable evidence and
      // deadline. Child contamination is separate infrastructure recovery and
      // never consumes one of those attempts.
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        telemetry.attempts += 1
        try {
          return await this.reviewAttempt(input, action, deadlineAt, deadline, telemetry)
        } catch (error: unknown) {
          lastError = error
          if (attempt === 0 && isRetryableAttemptFailure(error)) continue
          throw error
        }
      }
      throw lastError
    })
    const run = deadline.wait(laneRun)
    return run.then(
      decision => {
        this.observeTelemetry({
          kind: 'review', outcome: decision.decision === 'human_review' ? 'human' : decision.decision, durationMs: this.durationSince(startedAt),
          attempts: telemetry.attempts, contaminatedRotationAttempts: telemetry.rotationAttempts,
          contaminatedRotations: telemetry.rotations,
        })
        return Object.freeze({
          ...decision,
          execution: Object.freeze({
            attempts: telemetry.attempts,
            contaminatedRotationAttempts: telemetry.rotationAttempts,
            contaminatedRotations: telemetry.rotations,
          }),
        })
      },
      error => {
        this.observeTelemetry({
          kind: 'review', outcome: 'error', durationMs: this.durationSince(startedAt),
          attempts: telemetry.attempts, contaminatedRotationAttempts: telemetry.rotationAttempts,
          contaminatedRotations: telemetry.rotations, failure: telemetryFailure(error),
        })
        throw error
      },
    ).finally(() => { deadline.close(input.signal) })
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
    deadline: ReviewDeadlineScope,
    telemetry: ReviewerTelemetryRunState,
  ): Promise<ApprovalDecision> {
    let lastError: unknown
    for (let recovery = 0; recovery < 2; recovery += 1) {
      try {
        return await this.reviewOnce(input, action, deadlineAt, deadline, telemetry)
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
    deadline: ReviewDeadlineScope,
    telemetry: ReviewerTelemetryRunState,
  ): Promise<ApprovalDecision> {
    deadline.throwIfAborted()
    if (this.now() >= deadlineAt) {
      throw new ReviewProtocolError('timed-out', 'review reached its business deadline before an attempt started')
    }
    const childId = await deadline.wait(this.options.directory.ensure(
      input.authority,
      this.options.preset,
      deadline.signal,
    ))
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
    const result = this.options.channel.arm(request, deadline.signal)
    // A very fast scoped tool may settle before deliver()'s acceptance promise
    // resumes this task. Attach containment immediately while preserving the
    // original promise for the authoritative await below.
    void result.catch(() => undefined)
    try {
      await deadline.wait(this.options.port.deliver(
        input.authority,
        childId,
        this.buildContent(packet),
        { signal: deadline.signal },
      ))
    } catch (error: unknown) {
      if (!(error instanceof ReviewProtocolError && (error.code === 'timed-out' || error.code === 'aborted'))) {
        this.options.channel.cancel(request.reviewId, 'delivery-failed', `review ${request.reviewId} delivery failed`)
      }
      await result.catch(() => undefined)
      if (isContaminationError(error)) {
        // Drain the contaminated child and reserve a clean replacement before
        // the retry selects a child from the durable catalog.
        telemetry.rotationAttempts += 1
        await deadline.wait(this.options.port.rotate(input.authority, childId, deadline.signal))
        telemetry.rotations += 1
      } else if (error instanceof ReviewProtocolError && error.code !== 'disposed') {
        this.options.port.interrupt(input.authority, childId)
      }
      throw error
    }
    try {
      return await deadline.wait(result)
    } catch (error: unknown) {
      if (error instanceof ReviewProtocolError && error.code !== 'disposed') {
        this.options.port.interrupt(input.authority, childId)
      }
      throw error
    }
  }

  private durationSince(startedAt: number): number {
    const elapsed = this.now() - startedAt
    return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0
  }

  private observeTelemetry(observation: Parameters<ReviewerTelemetrySink['observe']>[0]): void {
    try { this.options.telemetry?.observe(observation) } catch { /* telemetry never authorizes */ }
  }
}
