/**
 * A pre-review decision that the approval/request answerer may only replay.
 * Sealing binds the decision to the exact ask identity and action hash, so a
 * late, duplicated, or mismatched request cannot consume another review's
 * outcome.
 */

export type SealedDispositionKind = 'allow' | 'deny' | 'human'

export interface SealedDispositionV1 {
  readonly version: 1
  readonly reviewRunId: string
  readonly requestId: string
  readonly parentSessionId: string
  readonly callId: string
  readonly actionHash: string
  readonly generation: string
  readonly configurationFingerprint: string
  readonly disposition: SealedDispositionKind
  readonly issuedAt: number
  readonly deadlineAt: number
  /** Consumed by tools/result; a settled execution can no longer replay. */
  readonly replayable: boolean
}

export type SealedDispositionLookupV1 =
  | { readonly kind: 'sealed'; readonly disposition: SealedDispositionV1 }
  | { readonly kind: 'missing' }
  | { readonly kind: 'mismatch'; readonly reason: string }
  | { readonly kind: 'consumed' }
