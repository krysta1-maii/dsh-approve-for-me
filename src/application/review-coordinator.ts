import { randomUUID } from 'node:crypto'
import { ReviewProtocolError } from './decision-channel.js'
import type { DecisionChannel, ReviewClock } from './decision-channel.js'
import { SerialLanes } from './serial-lanes.js'
import {
  approvalReviewRequestContent,
  createApprovalReviewRequest,
  parseActionSnapshot,
} from '../domain/protocol.js'
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

/** One complete application-owned approval review. */
export interface ReviewCoordinator<Parent, SessionId extends string> {
  review(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly action: ActionSnapshot
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
  readonly buildContent?: (request: ApprovalReviewRequest) => readonly ReviewerTextBlock[]
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
  private readonly buildContent: (request: ApprovalReviewRequest) => readonly ReviewerTextBlock[]

  constructor(private readonly options: ReviewCoordinatorOptions<Parent, SessionId>) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }
    this.now = options.now ?? Date.now
    this.reviewId = options.reviewId ?? randomUUID
    this.buildContent = options.buildContent ?? approvalReviewRequestContent
  }

  review(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly action: ActionSnapshot
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
    return this.options.lane.run(input.authority.sessionId, async () => {
      // A contaminated child may only be discovered between `list()` and
      // `deliver()` (the Guard sets the flag during admission checks). Retry
      // once against a freshly reserved child; every failure after that stays
      // fail-closed and is never silently allowed.
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this.reviewOnce(input, action)
        } catch (error: unknown) {
          if (attempt === 0 && isContaminationError(error)) {
            lastError = error
            continue
          }
          throw error
        }
      }
      throw lastError
    })
  }

  private async reviewOnce(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly action: ActionSnapshot
      readonly callId?: string
      readonly reason?: string
      readonly signal?: AbortSignal
    },
    action: ActionSnapshot,
  ): Promise<ApprovalDecision> {
    const childId = await this.options.directory.ensure(
      input.authority,
      this.options.preset,
      input.signal,
    )
    const issuedAt = this.now()
    const request = createApprovalReviewRequest(action, {
      reviewId: this.reviewId(),
      parentSessionId: input.authority.sessionId,
      reviewerSessionId: childId,
      generation: this.options.preset.generation,
      ...input.callId === undefined ? {} : { callId: input.callId },
      ...input.reason === undefined ? {} : { reason: input.reason },
      issuedAt,
      deadlineAt: issuedAt + this.options.timeoutMs,
    })
    // `arm` throws synchronously when the request can never be pending
    // (disposed channel, duplicate id, abort racing past the early check,
    // expired deadline): such a review is never delivered to the child.
    const result = this.options.channel.arm(request, input.signal)
    // A very fast scoped tool may settle before deliver()'s acceptance promise
    // resumes this task. Attach containment immediately while preserving the
    // original promise for the authoritative await below.
    void result.catch(() => undefined)
    try {
      await this.options.port.deliver(
        input.authority,
        childId,
        this.buildContent(request),
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
