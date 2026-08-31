import type { JsonValue } from '../domain/json.js'
import type { ReviewerProviderDataV1, ReviewerTextBlock } from '../domain/protocol.js'

/**
 * Exact live parent authority derived ONCE by a DSH adapter from the precise
 * object the event carried. Application services never accept a bare parent
 * object plus an arbitrary session-id string again.
 */
export interface ParentAuthority<Parent, SessionId> {
  /** The exact live parent Agent or equivalent owner object. */
  readonly live: Parent
  /** The parent's durable Session identity. */
  readonly sessionId: SessionId
}

/** Provider-private read-only view of one directly owned managed child. */
export interface ManagedOwnedReviewer<SessionId> {
  readonly id: SessionId
  readonly parentSessionId: SessionId
  readonly provider: string
  readonly label: string
  readonly providerData?: JsonValue
  readonly activity: 'running' | 'inactive'
  /** Persisted count of controller review-packet delivery attempts consumed before transport. */
  readonly deliveryAttempts: number
  /** Retired children remain auditable but are never selected again. */
  readonly retired: boolean
  /** A child whose transcript received unauthorized input is permanently unusable. */
  readonly contaminated: boolean
}

/**
 * The narrowest managed-child port the application layer needs. Mirrors the
 * `ManagedAgentController` capability of `dsh-managed-agent`, minus DSH
 * types: the DSH adapter maps `Agent`/`SessionId`/`ContentBlock` at the seam.
 */
export interface ManagedReviewerPort<Parent, SessionId> {
  create(
    authority: ParentAuthority<Parent, SessionId>,
    options: {
      readonly label: string
      readonly providerData: ReviewerProviderDataV1
      readonly signal?: AbortSignal
    },
  ): Promise<SessionId>
  list(parentSessionId: SessionId, signal?: AbortSignal): Promise<ManagedOwnedReviewer<SessionId>[]>
  /** Drain a contaminated Reviewer child and reserve a fresh clean one. */
  rotate(
    authority: ParentAuthority<Parent, SessionId>,
    childId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionId>
  /** Retire a clean capacity-limited Reviewer and reserve its successor. */
  renew(
    authority: ParentAuthority<Parent, SessionId>,
    childId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionId>
  deliver(
    authority: ParentAuthority<Parent, SessionId>,
    childId: SessionId,
    content: readonly ReviewerTextBlock[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>
  interrupt(authority: ParentAuthority<Parent, SessionId>, childId: SessionId): void
}
