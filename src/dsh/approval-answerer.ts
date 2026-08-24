import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { ReviewProtocolError } from '../application/decision-channel.js'
import type { ReviewCoordinator } from '../application/review-coordinator.js'
import { resolveApprovalDecision } from '../domain/protocol.js'
import type { ReviewMode } from '../domain/protocol.js'
import type { ActionCapture } from '../ports/action-projector.js'

export type ApprovalAnswerer = (
  request: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

export interface ApprovalAnswererOptions {
  readonly coordinator: ReviewCoordinator<Agent, string>
  readonly captures: ActionCapture<Agent, string>
  readonly mode: ReviewMode
}

/**
 * Real `approval/request` waterfall answerer. The request's exact live Agent
 * is forwarded unchanged as the parent authority; `next()` is used ONLY by
 * `auto-then-user` delegation. Any incomplete fact path fails closed.
 */
export function createApprovalAnswerer(options: ApprovalAnswererOptions): ApprovalAnswerer {
  const fallback = (next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> =>
    options.mode === 'auto-then-user' ? next() : Promise.resolve('unavailable')

  return async (request, next) => {
    if (request.signal?.aborted) return 'cancelled'
    if (request.callId === undefined) return fallback(next)
    const captured = options.captures.lookup(request.agent, String(request.callId), request.toolName)
    if (captured === undefined) return fallback(next)
    const authority = { live: request.agent, sessionId: String(request.agent.id) }
    try {
      const decision = await options.coordinator.review({
        authority,
        action: captured,
        callId: String(request.callId),
        ...request.reason === undefined ? {} : { reason: request.reason },
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
      const resolution = resolveApprovalDecision(decision, options.mode)
      return resolution.kind === 'delegate' ? next() : resolution.outcome
    } catch (error: unknown) {
      if (error instanceof ReviewProtocolError && error.code === 'aborted') return 'cancelled'
      return 'unavailable'
    }
  }
}
