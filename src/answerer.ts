import { ReviewProtocolError } from './broker.js'
import { resolveApprovalDecision } from './protocol.js'
import type {
  ActionSnapshot,
  ApprovalDecision,
  ApprovalOutcome,
  ReviewerProviderDataV1,
  ReviewMode,
} from './protocol.js'
import type { ActionCaptureStore } from './capture.js'
import type { ReviewActionOptions } from './manager.js'

export interface ApprovalHookRequest<Parent extends object> {
  readonly agent: Parent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export interface ApprovalReviewer<Parent> {
  review(
    parent: Parent,
    parentSessionId: string,
    action: ActionSnapshot,
    providerData: ReviewerProviderDataV1,
    options?: ReviewActionOptions,
  ): Promise<ApprovalDecision>
}

export interface ApprovalAnswererOptions<Parent extends object> {
  readonly mode: ReviewMode
  readonly providerData: ReviewerProviderDataV1
  readonly parentSessionId: (parent: Parent) => string
}

export type ApprovalNext = () => Promise<ApprovalOutcome>
export type ApprovalAnswerer<Parent extends object> = (
  request: ApprovalHookRequest<Parent>,
  next: ApprovalNext,
) => Promise<ApprovalOutcome>

/**
 * Build the fail-closed DSH approval/request answerer. The request's exact live
 * Agent object is forwarded unchanged to the Reviewer manager.
 */
export function createApprovalAnswerer<Parent extends object>(
  reviewer: ApprovalReviewer<Parent>,
  captures: ActionCaptureStore<Parent>,
  options: ApprovalAnswererOptions<Parent>,
): ApprovalAnswerer<Parent> {
  const fallback = (next: ApprovalNext): Promise<ApprovalOutcome> =>
    options.mode === 'auto-then-user' ? next() : Promise.resolve('unavailable')

  return async (request, next) => {
    if (request.signal?.aborted) return 'cancelled'
    if (request.callId === undefined) return fallback(next)
    const captured = captures.lookup(request.agent, request.callId, request.toolName)
    if (captured === undefined) return fallback(next)
    const parentSessionId = options.parentSessionId(request.agent)
    if (captured.parentSessionId !== parentSessionId) return fallback(next)
    try {
      const decision = await reviewer.review(
        request.agent,
        parentSessionId,
        captured.action,
        options.providerData,
        {
          callId: request.callId,
          ...request.reason === undefined ? {} : { reason: request.reason },
          ...request.signal === undefined ? {} : { signal: request.signal },
        },
      )
      const resolution = resolveApprovalDecision(decision, options.mode)
      return resolution.kind === 'delegate' ? next() : resolution.outcome
    } catch (error: unknown) {
      if (error instanceof ReviewProtocolError && error.code === 'aborted') return 'cancelled'
      return 'unavailable'
    }
  }
}
