import type {
  AllowCacheKeyV1,
  AllowCacheV1,
  ExactDenialBreakerKeyV1,
  ExactDenialBreakerV1,
} from '../approval-gate/breaker.js'

/**
 * In-memory exact-denial breaker. It can only reject a previously
 * Guardian-denied exact action hash; a miss costs one extra review and can
 * never grant access.
 */
export class InMemoryExactDenialBreaker implements ExactDenialBreakerV1 {
  private readonly byParent = new Map<string, Map<number, Map<number, Set<string>>>>()

  lookup(key: ExactDenialBreakerKeyV1): boolean {
    return this.byParent.get(key.parentLifecycleFingerprint)
      ?.get(key.turn)
      ?.get(key.directUserFrontierSeq)
      ?.has(key.actionHash) ?? false
  }

  recordGuardianDeny(key: ExactDenialBreakerKeyV1): void {
    let turns = this.byParent.get(key.parentLifecycleFingerprint)
    if (turns === undefined) {
      turns = new Map()
      this.byParent.set(key.parentLifecycleFingerprint, turns)
    }
    let frontier = turns.get(key.turn)
    if (frontier === undefined) {
      frontier = new Map()
      turns.set(key.turn, frontier)
    }
    let hashes = frontier.get(key.directUserFrontierSeq)
    if (hashes === undefined) {
      hashes = new Set()
      frontier.set(key.directUserFrontierSeq, hashes)
    }
    hashes.add(key.actionHash)
  }

  clearParent(parentLifecycleFingerprint: string): void {
    this.byParent.delete(parentLifecycleFingerprint)
  }
}

/**
 * In-memory allow cache for exact action hashes. Like the breaker, a miss is
 * safe: it only produces another Guardian review, never a grant.
 */
export class InMemoryAllowCache implements AllowCacheV1 {
  private readonly byParent = new Map<string, Map<number, Map<number, Map<string, Set<string>>>>>()

  lookup(key: AllowCacheKeyV1): boolean {
    return this.byParent.get(key.parentLifecycleFingerprint)
      ?.get(key.turn)
      ?.get(key.directUserFrontierSeq)
      ?.get(key.actionHash)
      ?.has(`${key.configurationFingerprint}\0${key.generation}`) ?? false
  }

  recordGuardianAllow(key: AllowCacheKeyV1): void {
    let turns = this.byParent.get(key.parentLifecycleFingerprint)
    if (turns === undefined) {
      turns = new Map()
      this.byParent.set(key.parentLifecycleFingerprint, turns)
    }
    let frontier = turns.get(key.turn)
    if (frontier === undefined) {
      frontier = new Map()
      turns.set(key.turn, frontier)
    }
    let actions = frontier.get(key.directUserFrontierSeq)
    if (actions === undefined) {
      actions = new Map()
      frontier.set(key.directUserFrontierSeq, actions)
    }
    let identities = actions.get(key.actionHash)
    if (identities === undefined) {
      identities = new Set()
      actions.set(key.actionHash, identities)
    }
    identities.add(`${key.configurationFingerprint}\0${key.generation}`)
  }

  clearParent(parentLifecycleFingerprint: string): void {
    this.byParent.delete(parentLifecycleFingerprint)
  }
}
