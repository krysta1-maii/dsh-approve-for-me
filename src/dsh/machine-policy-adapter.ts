import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { GateMachinePolicyV1, GateMachineRequestV1 } from '../approval-gate/machine-policy.js'
import { gateFailureOutcome } from '../application/gate-failure.js'
import type { ReviewMode } from '../domain/protocol.js'

/**
 * Structural view of the patched `@deepseek-ai/dsh-user-approval`
 * `ApprovalRequestEvent`/`MachineApprovalPolicy` surface. This repo's installed
 * 0.1.1 types do not yet carry the fork additions, and the domain layer must
 * not depend on the patched official package, so the adapter keeps its own
 * minimal shape at the DSH seam.
 *
 * The real patched package types are structurally identical to this view:
 * `requestId` is the service-issued `approval/asked` id, `agent` is the exact
 * live parent Agent, and `callId` is the exact tool-call id (or undefined).
 */
export interface PatchedApprovalRequestLike {
  readonly agent: Agent
  readonly toolName: string
  readonly requestId?: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** The patched machine-policy contract as consumed by this plugin. */
export interface PatchedMachineApprovalPolicyLike {
  readonly id: string
  decide(request: PatchedApprovalRequestLike): Promise<ApprovalOutcome | 'delegate'>
}

export interface MachinePolicyAdapterOptions {
  readonly gate: GateMachinePolicyV1
  readonly mode: ReviewMode
  /**
   * Resolve the domain action hash for one exact approval ask. The DSH
   * adapter supplies this from the capture/execution side; when no capture is
   * available the resolver must fail closed (throw or return an empty hash)
   * rather than inventing an identity.
   */
  readonly resolveActionHash: (input: {
    readonly agent: Agent
    readonly parentSessionId: string
    readonly callId?: string
    readonly requestId: string
    readonly toolName: string
  }) => string
}

/**
 * Map the patched DSH `MachineApprovalPolicy` slot to the DSH-neutral gate
 * port. The adapter never decides itself: it only projects the real request
 * into {@link GateMachineRequestV1}, records the exact ask identity, and
 * returns the gate's closed outcome.
 */
export function createMachinePolicyAdapter(options: MachinePolicyAdapterOptions): PatchedMachineApprovalPolicyLike {
  return Object.freeze({
    id: 'dsh-approve-for-me/v1',
    async decide(request: PatchedApprovalRequestLike): Promise<ApprovalOutcome | 'delegate'> {
      if (request.signal?.aborted) return 'cancelled'
      // requestId and callId are mandatory links to durable approval and tool
      // history. Their absence is not a recoverable reason to ask a human.
      if (request.requestId === undefined || request.callId === undefined) return 'unavailable'
      const parentSessionId = String(request.agent.session?.id ?? '')
      if (parentSessionId.length === 0) return 'unavailable'
      const callId = String(request.callId)
      try {
        const actionHash = options.resolveActionHash({
          agent: request.agent,
          parentSessionId,
          callId,
          requestId: request.requestId,
          toolName: request.toolName,
        })
        if (actionHash.length === 0) return 'unavailable'
        const gateRequest: GateMachineRequestV1 = {
          requestId: request.requestId,
          parentSessionId,
          callId,
          toolName: request.toolName,
          ...request.reason === undefined ? {} : { reason: request.reason },
          actionHash,
          mode: options.mode,
          ...request.signal === undefined ? {} : { signal: request.signal },
        }
        return await options.gate.decide(gateRequest)
      } catch (error: unknown) {
        return gateFailureOutcome(error, options.mode)
      }
    },
  })
}
