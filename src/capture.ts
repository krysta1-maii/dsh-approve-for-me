import { createActionSnapshot } from './protocol.js'
import type { ActionSnapshot, ActionSnapshotInput } from './protocol.js'

export interface CapturedAction {
  readonly parentSessionId: string
  readonly callId: string
  readonly reason?: string
  readonly action: ActionSnapshot
}

/** Correlates approval/request with the full ToolExecution seen in tools/pre-execute. */
export class ActionCaptureStore<Owner extends object> {
  private readonly byOwner = new WeakMap<Owner, Map<string, CapturedAction>>()

  capture(owner: Owner, input: ActionSnapshotInput & {
    readonly parentSessionId: string
    readonly callId: string
    readonly reason?: string
  }): CapturedAction {
    const captured: CapturedAction = Object.freeze({
      parentSessionId: input.parentSessionId,
      callId: input.callId,
      ...input.reason === undefined ? {} : { reason: input.reason },
      action: createActionSnapshot(input),
    })
    let calls = this.byOwner.get(owner)
    if (calls === undefined) {
      calls = new Map()
      this.byOwner.set(owner, calls)
    }
    if (calls.has(input.callId)) throw new TypeError(`tool call ${input.callId} is already captured`)
    calls.set(input.callId, captured)
    return captured
  }

  lookup(owner: Owner, callId: string, toolName: string): CapturedAction | undefined {
    const captured = this.byOwner.get(owner)?.get(callId)
    return captured?.action.toolName === toolName ? captured : undefined
  }

  release(owner: Owner, callId: string): boolean {
    const calls = this.byOwner.get(owner)
    if (calls === undefined) return false
    const removed = calls.delete(callId)
    if (calls.size === 0) this.byOwner.delete(owner)
    return removed
  }
}
