import { parseApprovalDecision } from '../domain/protocol.js'
import type { ApprovalDecision, ApprovalReviewRequest } from '../domain/protocol.js'

export type ReviewFailureCode =
  | 'aborted'
  | 'cancelled'
  | 'delivery-failed'
  | 'disposed'
  | 'identity-mismatch'
  | 'invalid-result'
  | 'timed-out'

export class ReviewProtocolError extends Error {
  constructor(readonly code: ReviewFailureCode, message: string) {
    super(message)
    this.name = 'ReviewProtocolError'
  }
}

export interface DecisionSubmissionContext {
  readonly actualReviewerSessionId: string
  readonly receivedAt?: number
}

export type SubmitDecisionResult =
  | { readonly status: 'accepted'; readonly decision: ApprovalDecision }
  | { readonly status: 'duplicate'; readonly reviewId: string }
  | { readonly status: 'identity-mismatch'; readonly reviewId: string }
  | { readonly status: 'invalid'; readonly reviewId?: string; readonly error: TypeError }
  | { readonly status: 'late'; readonly reviewId: string }
  | { readonly status: 'unknown'; readonly reviewId: string }

export interface ReviewClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: ReviewClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * One-shot result channel owned by the application layer. The decision tool
 * stages a candidate; the child-scoped `tools/result` observer calls
 * {@link DecisionChannel.submit} with the ACTUAL reviewer Session that called
 * the tool, so identity is never taken from model payload alone.
 */
export interface DecisionChannel {
  /**
   * Arm a one-shot review. Throws SYNCHRONOUSLY — before returning — when the
   * request can never be pending: the channel is disposed, the review id is
   * already pending or settled, the signal is already aborted, or the deadline
   * has already passed. A review that never entered the channel is never
   * delivered. The returned promise only settles through `submit`, `cancel`,
   * `dispose`, timeout, or an abort that arrives after arming.
   */
  arm(request: ApprovalReviewRequest, signal?: AbortSignal): Promise<ApprovalDecision>
  submit(payload: unknown, context: DecisionSubmissionContext): SubmitDecisionResult
  cancel(
    reviewId: string,
    code?: Exclude<ReviewFailureCode, 'disposed' | 'timed-out'>,
    message?: string,
  ): boolean
  dispose(): void
}

interface PendingReview {
  readonly request: ApprovalReviewRequest
  readonly resolve: (decision: ApprovalDecision) => void
  readonly reject: (error: ReviewProtocolError) => void
  readonly timer: unknown
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

type TerminalStatus = 'accepted' | ReviewFailureCode

function routingReviewId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>).reviewId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Owns arm/await/submit correlation, deadline, cancellation, and tombstones. */
export class DefaultDecisionChannel implements DecisionChannel {
  private readonly pending = new Map<string, PendingReview>()
  private readonly terminal = new Map<string, TerminalStatus>()
  private disposed = false

  constructor(
    private readonly clock: ReviewClock = systemClock,
    private readonly terminalHistoryLimit = 1024,
  ) {
    if (!Number.isSafeInteger(terminalHistoryLimit) || terminalHistoryLimit < 1) {
      throw new TypeError('terminalHistoryLimit must be a positive safe integer')
    }
  }

  arm(request: ApprovalReviewRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (this.disposed) {
      throw new ReviewProtocolError('disposed', 'decision channel is disposed')
    }
    if (this.pending.has(request.reviewId) || this.terminal.has(request.reviewId)) {
      throw new TypeError(`review ${request.reviewId} has already been armed`)
    }
    if (signal?.aborted) {
      this.remember(request.reviewId, 'aborted')
      throw new ReviewProtocolError('aborted', `review ${request.reviewId} was aborted before delivery`)
    }
    const delay = request.deadlineAt - this.clock.now()
    if (delay <= 0) {
      this.remember(request.reviewId, 'timed-out')
      throw new ReviewProtocolError('timed-out', `review ${request.reviewId} reached its deadline`)
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.rejectPending(request.reviewId, 'timed-out', `review ${request.reviewId} reached its deadline`)
      }, delay)
      const onAbort = signal === undefined
        ? undefined
        : () => { this.rejectPending(request.reviewId, 'aborted', `review ${request.reviewId} was aborted`) }
      if (onAbort !== undefined) signal!.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.reviewId, {
        request,
        resolve,
        reject,
        timer,
        ...signal === undefined ? {} : { signal },
        ...onAbort === undefined ? {} : { onAbort },
      })
    })
  }

  submit(payload: unknown, context: DecisionSubmissionContext): SubmitDecisionResult {
    const routedReviewId = routingReviewId(payload)
    let decision: ApprovalDecision
    try {
      decision = parseApprovalDecision(payload)
    } catch (error: unknown) {
      const typed = error instanceof TypeError ? error : new TypeError(String(error))
      // v2 fix: an invalid payload must not terminate another child's pending
      // review. Only the exact pending entry whose owning Reviewer matches the
      // actual caller may be closed on an invalid result.
      const pending = routedReviewId === undefined ? undefined : this.pending.get(routedReviewId)
      if (pending !== undefined && pending.request.reviewerSessionId === context.actualReviewerSessionId) {
        this.rejectPending(routedReviewId!, 'invalid-result', `review ${routedReviewId} returned an invalid result`)
      }
      return { status: 'invalid', ...routedReviewId === undefined ? {} : { reviewId: routedReviewId }, error: typed }
    }
    const entry = this.pending.get(decision.reviewId)
    if (entry === undefined) {
      const terminal = this.terminal.get(decision.reviewId)
      if (terminal === 'accepted') return { status: 'duplicate', reviewId: decision.reviewId }
      if (terminal !== undefined) return { status: 'late', reviewId: decision.reviewId }
      return { status: 'unknown', reviewId: decision.reviewId }
    }
    const now = context.receivedAt ?? this.clock.now()
    if (now > entry.request.deadlineAt) {
      this.rejectPending(decision.reviewId, 'timed-out', `review ${decision.reviewId} returned after its deadline`)
      return { status: 'late', reviewId: decision.reviewId }
    }
    const matches = decision.parentSessionId === entry.request.parentSessionId
      && decision.reviewerSessionId === entry.request.reviewerSessionId
      && context.actualReviewerSessionId === entry.request.reviewerSessionId
      && decision.generation === entry.request.generation
      && decision.actionHash === entry.request.actionHash
    if (!matches) {
      this.rejectPending(decision.reviewId, 'identity-mismatch', `review ${decision.reviewId} returned mismatched identity`)
      return { status: 'identity-mismatch', reviewId: decision.reviewId }
    }
    this.pending.delete(decision.reviewId)
    this.cleanup(entry)
    this.remember(decision.reviewId, 'accepted')
    entry.resolve(decision)
    return { status: 'accepted', decision }
  }

  cancel(
    reviewId: string,
    code: Exclude<ReviewFailureCode, 'disposed' | 'timed-out'> = 'cancelled',
    message?: string,
  ): boolean {
    return this.rejectPending(reviewId, code, message ?? `review ${reviewId} was ${code}`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const reviewId of [...this.pending.keys()]) {
      this.rejectPending(reviewId, 'disposed', `review ${reviewId} was closed with the channel`)
    }
  }

  private rejectPending(reviewId: string, code: ReviewFailureCode, message: string): boolean {
    const entry = this.pending.get(reviewId)
    if (entry === undefined) return false
    this.pending.delete(reviewId)
    this.cleanup(entry)
    this.remember(reviewId, code)
    entry.reject(new ReviewProtocolError(code, message))
    return true
  }

  private cleanup(entry: PendingReview): void {
    this.clock.clearTimeout(entry.timer)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
  }

  private remember(reviewId: string, status: TerminalStatus): void {
    this.terminal.set(reviewId, status)
    while (this.terminal.size > this.terminalHistoryLimit) {
      const oldest = this.terminal.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.terminal.delete(oldest)
    }
  }
}
