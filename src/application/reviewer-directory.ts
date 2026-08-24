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
  ) {}

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
    if (existing !== undefined) return existing.id
    return this.port.create(authority, {
      label: 'Approval Reviewer',
      providerData: desired,
      ...signal === undefined ? {} : { signal },
    })
  }
}
