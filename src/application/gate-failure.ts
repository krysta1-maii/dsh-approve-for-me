import type { GateMachineDecisionV1 } from '../approval-gate/machine-policy.js'
import type { ReviewMode } from '../domain/protocol.js'

/** Closed classification for expected Gate failures at the DSH boundary. */
export type GateFailureCode =
  | 'integrity'
  | 'conflict'
  | 'retryable-capability'
  | 'abort'
  | 'deadline'
  | 'lifecycle'
  /**
   * WP4-b4 sealed hot-path reason codes. Both are bounded-capability gaps that
   * route to the official human waterfall in auto-then-user mode (auto stays
   * unavailable), never to an automatic grant. They are distinct from the
   * integrity/conflict class so an unknown tampering signal can never be
   * disguised as an explainable missing seal or a capacity overflow.
   */
  | 'tail-budget-overflow'
  | 'sealed-current-missing'

/** A failure whose business meaning is known and must not escape as an Error. */
export class GateFailure extends Error {
  constructor(readonly code: GateFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GateFailure'
  }
}

/** Map only explicitly retryable failures to the official human waterfall. */
export function gateFailureOutcome(error: unknown, mode: ReviewMode): GateMachineDecisionV1 {
  if (!(error instanceof GateFailure)) return 'unavailable'
  switch (error.code) {
    case 'abort': return 'cancelled'
    case 'retryable-capability':
    case 'tail-budget-overflow':
    case 'sealed-current-missing': return mode === 'auto-then-user' ? 'delegate' : 'unavailable'
    case 'integrity':
    case 'conflict':
    case 'deadline':
    case 'lifecycle': return 'unavailable'
  }
}
