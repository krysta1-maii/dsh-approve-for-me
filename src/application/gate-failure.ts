import type { GateMachineDecisionV1 } from '../approval-gate/machine-policy.js'
import type { ReviewMode } from '../domain/protocol.js'

/**
 * Closed classification for expected Gate failures at the DSH boundary. Every
 * failure the gate can name has a machine code; an unknown code is rejected by
 * the gate decision-record parser rather than accepted by memory.
 */
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
  | 'ledger-budget-overflow'
  | 'sealed-current-missing'
  /**
   * WP5-a §4.4 reason codes. Tamper signals (sealed-current-conflict /
   * seal-chain-invalid / seal-live-rebind-failed), Storage-domain failures
   * (ledger-storage-unavailable / ledger-conflict) and an invalid activity
   * projection (activity-projection-invalid) are all hard unavailable: they
   * must never be routed to the human waterfall as if they were an explainable
   * missing seal or a capacity overflow.
   */
  | 'sealed-current-conflict'
  | 'seal-chain-invalid'
  | 'seal-live-rebind-failed'
  | 'ledger-storage-unavailable'
  | 'ledger-conflict'
  | 'activity-projection-invalid'

/** Runtime closed set used to validate decision rows and metrics snapshots. */
export const GATE_FAILURE_CODES: readonly GateFailureCode[] = [
  'integrity',
  'conflict',
  'retryable-capability',
  'abort',
  'deadline',
  'lifecycle',
  'tail-budget-overflow',
  'ledger-budget-overflow',
  'sealed-current-missing',
  'sealed-current-conflict',
  'seal-chain-invalid',
  'seal-live-rebind-failed',
  'ledger-storage-unavailable',
  'ledger-conflict',
  'activity-projection-invalid',
]

/**
 * Non-sensitive correlation metadata a source-backed failure may carry so the
 * gate can record an audit row for a failure that surfaces before it could
 * resolve GateActionFacts. Only identity, hashes, version and generation
 * strings are carried; never packet, rationale, tool arguments or content.
 */
export interface GateFailureCorrelationV1 {
  readonly parentSessionId: string
  readonly parentLifecycleFingerprint: string
  readonly requestId: string
  readonly callId: string
  readonly actionHash: string
  readonly generation: string
  readonly policyVersion: string
  readonly configurationFingerprint: string
}

/** A failure whose business meaning is known and must not escape as an Error. */
export class GateFailure extends Error {
  constructor(
    readonly code: GateFailureCode,
    message: string,
    options?: { cause?: unknown; correlation?: GateFailureCorrelationV1 },
  ) {
    super(message, options)
    this.name = 'GateFailure'
    if (options?.correlation !== undefined) this.correlation = options.correlation
  }
  /** Present only for a failure raised at the source-backed facts boundary. */
  readonly correlation?: GateFailureCorrelationV1
}

/** Map only explicitly retryable failures to the official human waterfall. */
export function gateFailureOutcome(error: unknown, mode: ReviewMode): GateMachineDecisionV1 {
  if (!(error instanceof GateFailure)) return 'unavailable'
  switch (error.code) {
    case 'abort': return 'cancelled'
    case 'retryable-capability':
    case 'tail-budget-overflow':
    case 'ledger-budget-overflow':
    case 'sealed-current-missing': return mode === 'auto-then-user' ? 'delegate' : 'unavailable'
    // WP5-a: tamper signals, Storage-domain failures and an invalid activity
    // projection are hard unavailable in every mode. They must never be
    // disguised as an explainable sealed-current-missing or a capacity overflow
    // that delegates to the human waterfall.
    case 'integrity':
    case 'conflict':
    case 'deadline':
    case 'lifecycle':
    case 'sealed-current-conflict':
    case 'seal-chain-invalid':
    case 'seal-live-rebind-failed':
    case 'ledger-storage-unavailable':
    case 'ledger-conflict':
    case 'activity-projection-invalid': return 'unavailable'
    // WP5-a 闭集拒绝未知码: an unrecognized code at runtime must fail closed to
    // unavailable, never return a non-decision (undefined) or a delegated path.
    default: return 'unavailable'
  }
}
