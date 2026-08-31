import {
  REVIEWER_PROVIDER,
  parseReviewerProviderData,
} from '../domain/protocol.js'
import type { ReviewerProviderDataV1 } from '../domain/protocol.js'
import type { ParentAuthority, ManagedReviewerPort } from '../ports/managed-reviewer.js'

/**
 * Plugin-owned instance policy: one accurate Reviewer child per parent Session
 * and configuration generation. The directory only discovers or creates; it
 * never runs an approval, deadline, or decision.
 */
export interface ReviewerDirectory<Parent, SessionId> {
  ensure(
    authority: ParentAuthority<Parent, SessionId>,
    preset: ReviewerProviderDataV1,
    signal?: AbortSignal,
  ): Promise<SessionId>
}

export class DefaultReviewerDirectory<Parent, SessionId extends string>
  implements ReviewerDirectory<Parent, SessionId> {
  constructor(
    private readonly port: ManagedReviewerPort<Parent, SessionId>,
    private readonly reviewerProvider: string = REVIEWER_PROVIDER,
    private readonly maxDeliveryAttemptsPerChild: number = 64,
  ) {
    if (!Number.isSafeInteger(maxDeliveryAttemptsPerChild) || maxDeliveryAttemptsPerChild < 1) {
      throw new TypeError('maxDeliveryAttemptsPerChild must be a positive safe integer')
    }
  }

  async ensure(
    authority: ParentAuthority<Parent, SessionId>,
    preset: ReviewerProviderDataV1,
    signal?: AbortSignal,
  ): Promise<SessionId> {
    const desired = parseReviewerProviderData(preset)
    const children = await this.port.list(
      authority.sessionId,
      signal,
    )
    const matching = children.filter((child) => {
      if (child.provider !== this.reviewerProvider || child.parentSessionId !== authority.sessionId) return false
      // Contaminated and capacity-retired children remain auditable but are
      // permanently ineligible, including after a cold resume.
      if (child.contaminated || child.retired) return false
      if (!Number.isSafeInteger(child.deliveryAttempts) || child.deliveryAttempts < 0) {
        throw new Error(`managed Reviewer ${String(child.id)} has an invalid durable delivery-attempt count`)
      }
      try {
        const data = parseReviewerProviderData(child.providerData)
        return data.generation === desired.generation
          && data.configurationFingerprint === desired.configurationFingerprint
      } catch {
        return false
      }
    })
    if (matching.length > 1) {
      throw new Error(
        `multiple Approval Reviewers match parent ${String(authority.sessionId)} and generation ${desired.generation}`,
      )
    }
    const existing = matching[0]
    if (existing !== undefined) {
      if (existing.deliveryAttempts >= this.maxDeliveryAttemptsPerChild) {
        return this.port.renew(authority, existing.id, signal)
      }
      return existing.id
    }
    return this.port.create(authority, {
      label: 'Approval Reviewer',
      providerData: desired,
      ...signal === undefined ? {} : { signal },
    })
  }
}
