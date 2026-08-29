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
    case 'retryable-capability': return mode === 'auto-then-user' ? 'delegate' : 'unavailable'
    case 'integrity':
    case 'conflict':
    case 'deadline':
    case 'lifecycle': return 'unavailable'
  }
}
