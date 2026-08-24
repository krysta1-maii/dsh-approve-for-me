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
}

/**
 * The narrowest managed-child port the application layer needs. Mirrors the
 * `ManagedSubagentController` capability of `dsh-managed-agent`, minus DSH
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
  deliver(
    authority: ParentAuthority<Parent, SessionId>,
    childId: SessionId,
    content: readonly ReviewerTextBlock[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>
  interrupt(authority: ParentAuthority<Parent, SessionId>, childId: SessionId): void
}
