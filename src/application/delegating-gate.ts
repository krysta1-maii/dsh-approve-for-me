import type { GateMachineDecisionV1, GateMachinePolicyV1 } from '../approval-gate/machine-policy.js'

/**
 * Transitional gate used while the P2 pipeline is not yet installed.
 *
 * It deliberately declines every request (`'delegate'`) so the patched service
 * continues into the existing `approval/request` waterfall and the current
 * reviewer answerer remains the effective decision path. This keeps the
 * machine-policy slot wired end-to-end (identity mapping, registration,
 * non-claiming fallback) without silently changing authorization behavior
 * before the real pipeline is ready.
 */
export function createDelegatingGate(): GateMachinePolicyV1 {
  return Object.freeze({
    id: 'dsh-approve-for-me/v1',
    async decide(): Promise<GateMachineDecisionV1> {
      return 'delegate'
    },
  })
}
