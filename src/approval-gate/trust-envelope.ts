/**
 * Deterministic fast path for long-running unattended sessions: actions that
 * stay inside the configured trust envelope are granted without an LLM review.
 * Anything outside the envelope continues to the Guardian tier.
 */

export type TrustEnvelopeToolFamily = 'bash' | 'filesystem' | 'patch' | 'network' | 'process' | 'mcp' | 'other'

export interface TrustEnvelopeConfigV1 {
  readonly version: 1
  readonly enabled: boolean
  /** Tool families the envelope covers; anything else leaves the envelope. */
  readonly tools: readonly TrustEnvelopeToolFamily[]
  /** Highest requested sandbox mode the envelope may grant automatically. */
  readonly maxRequestedMode: 'read-only' | 'workspace-write'
  /** Targets must resolve inside the session workspace root. */
  readonly workspaceOnly: boolean
  /** Escalation requests must carry a non-empty justification. */
  readonly requireJustification: boolean
  /** Only strictly-wider sandbox ladder steps are grantable. */
  readonly requireStrictWidening: boolean
}

export type TrustEnvelopeEvaluationV1 =
  | { readonly kind: 'inside' }
  | { readonly kind: 'outside'; readonly reason: TrustEnvelopeRejectReasonV1 }

export type TrustEnvelopeRejectReasonV1 =
  | 'disabled'
  | 'tool-family-not-covered'
  | 'mode-above-ceiling'
  | 'outside-workspace'
  | 'missing-justification'
  | 'not-strictly-wider'
  | 'unclassified-action'
