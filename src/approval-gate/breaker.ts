/**
 * Exact rejection circuit breaker. v1 keys only on identity + exact
 * `actionHash`; semantic equivalence is explicitly out of scope. A miss only
 * costs one extra review — the breaker can never grant.
 */

export interface ExactDenialBreakerKeyV1 {
  readonly parentLifecycleFingerprint: string
  readonly turn: number
  readonly actionHash: string
}

export interface ExactDenialBreakerV1 {
  /** True when this exact key was denied by Guardian earlier. */
  lookup(key: ExactDenialBreakerKeyV1): boolean
  /** Record a Guardian deny; never records allow/human/unavailable. */
  recordGuardianDeny(key: ExactDenialBreakerKeyV1): void
  /** Drop all entries for one parent lifecycle (unload/reload boundary). */
  clearParent(parentLifecycleFingerprint: string): void
}

/**
 * Session-scoped allow replay cache; v1.1. Unlike the exact-denial breaker, the
 * allow cache keeps the direct-user frontier so a cached grant is only replayed
 * for the same user intent boundary.
 */
export interface AllowCacheKeyV1 {
  readonly parentLifecycleFingerprint: string
  readonly turn: number
  readonly directUserFrontierSeq: number
  readonly actionHash: string
  readonly configurationFingerprint: string
  readonly generation: string
}

export interface AllowCacheV1 {
  lookup(key: AllowCacheKeyV1): boolean
  recordGuardianAllow(key: AllowCacheKeyV1): void
  clearParent(parentLifecycleFingerprint: string): void
}
