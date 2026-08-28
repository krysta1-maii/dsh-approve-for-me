import type {
  SealedDispositionLookupV1,
  SealedDispositionRegistryV1,
  SealedDispositionV1,
} from '../approval-gate/sealed-decision.js'

/**
 * In-memory registry for one pre-review disposition. Sealing binds the
 * decision to the exact ask identity; lookups that do not match the original
 * `callId`/`actionHash` are reported as mismatches and can never be replayed
 * under a different ask.
 */
export class InMemorySealedDispositionRegistry implements SealedDispositionRegistryV1 {
  private readonly byRequestId = new Map<string, SealedDispositionV1>()
  private readonly consumed = new Set<string>()

  seal(disposition: SealedDispositionV1): void {
    if (this.byRequestId.has(disposition.requestId)) {
      throw new Error(`sealed disposition for request ${disposition.requestId} already exists`)
    }
    this.byRequestId.set(disposition.requestId, disposition)
  }

  lookup(
    requestId: string,
    callId: string,
    actionHash: string,
  ): SealedDispositionLookupV1 {
    if (this.consumed.has(this.key(requestId, callId))) return { kind: 'consumed' }
    const disposition = this.byRequestId.get(requestId)
    if (disposition === undefined) return { kind: 'missing' }
    if (disposition.callId !== callId) {
      return { kind: 'mismatch', reason: `sealed disposition is bound to callId "${disposition.callId}", got "${callId}"` }
    }
    if (disposition.actionHash !== actionHash) {
      return { kind: 'mismatch', reason: 'sealed disposition actionHash does not match the asked action' }
    }
    return { kind: 'sealed', disposition }
  }

  consume(requestId: string, callId: string): boolean {
    const key = this.key(requestId, callId)
    if (this.consumed.has(key)) return false
    const disposition = this.byRequestId.get(requestId)
    if (disposition === undefined || disposition.callId !== callId) return false
    this.consumed.add(key)
    return true
  }

  clearParent(parentSessionId: string): void {
    for (const [requestId, disposition] of this.byRequestId) {
      if (disposition.parentSessionId === parentSessionId) {
        this.byRequestId.delete(requestId)
        this.consumed.delete(this.key(requestId, disposition.callId))
      }
    }
  }

  private key(requestId: string, callId: string): string {
    return `${requestId}\0${callId}`
  }
}
