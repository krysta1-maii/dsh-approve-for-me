import type { ActionSnapshot, ActionSnapshotInput } from '../domain/protocol.js'

/**
 * Project one DSH-owned execution fact set into the domain action snapshot
 * input. The v1 adapter supplies a fixed projector; richer tool families
 * extend this port instead of putting functions into the serializable Config.
 */
export interface ActionProjector<Execution> {
  project(execution: Execution): ActionSnapshotInput
}

/** Correlates the complete action with the exact approval ask that follows. */
export interface ActionCapture<Owner, CallId> {
  remember(owner: Owner, callId: CallId, action: ActionSnapshot): void
  lookup(owner: Owner, callId: CallId, toolName: string): ActionSnapshot | undefined
  release(owner: Owner, callId: CallId): boolean
}

/** Exact-owner-keyed capture store using an identity-based owner map. */
export class DefaultActionCapture<Owner extends object, CallId extends string | number | symbol>
  implements ActionCapture<Owner, CallId> {
  private readonly byOwner = new WeakMap<Owner, Map<CallId, ActionSnapshot>>()

  remember(owner: Owner, callId: CallId, action: ActionSnapshot): void {
    let calls = this.byOwner.get(owner)
    if (calls === undefined) {
      calls = new Map()
      this.byOwner.set(owner, calls)
    }
    if (calls.has(callId)) throw new TypeError(`tool call ${String(callId)} is already captured`)
    calls.set(callId, action)
  }

  lookup(owner: Owner, callId: CallId, toolName: string): ActionSnapshot | undefined {
    const action = this.byOwner.get(owner)?.get(callId)
    return action?.toolName === toolName ? action : undefined
  }

  release(owner: Owner, callId: CallId): boolean {
    const calls = this.byOwner.get(owner)
    if (calls === undefined) return false
    const removed = calls.delete(callId)
    if (calls.size === 0) this.byOwner.delete(owner)
    return removed
  }
}
