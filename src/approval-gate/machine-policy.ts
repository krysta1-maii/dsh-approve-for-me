/**
 * DSH-neutral machine-policy port. The DSH adapter maps the patched
 * `MachineApprovalPolicy` (ApprovalRequest / ApprovalOutcome | 'delegate')
 * onto this port, keeping the gate implementation free of DSH types.
 */

export interface GateMachineRequestV1 {
  readonly requestId?: string
  readonly parentSessionId: string
  readonly callId?: string
  readonly toolName: string
  readonly reason?: string
  readonly actionHash: string
  /** Host-owned absolute deadline for the complete machine-policy path. */
  readonly deadlineAt: number
  readonly mode: 'auto' | 'auto-then-user'
  readonly signal?: AbortSignal
}

export type GateMachineDecisionV1 =
  | 'allowed-once'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'
  | 'delegate'

export interface GateMachinePolicyV1 {
  readonly id: 'dsh-approve-for-me/v1'
  decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1>
}
