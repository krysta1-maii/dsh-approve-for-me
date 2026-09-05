/**
 * Browser half of the Gate failure reason-code vocabulary.
 *
 * The Gate classifies every failure landing at the DSH boundary with a closed
 * reason code (src/application/gate-failure.ts, plus the WP5-a sealed/storage
 * codes). The decided Chat node carries the authoritative 'outcome'; this module
 * maps an optional reason code to ONE line of safe copy so the user sees WHY
 * approval went to 'unavailable' or to the human waterfall.
 *
 * Hard constraints honoured here:
 *  - Presentational only. Resolving a code never reads or writes the
 *    authoritative 'outcome' (the Gate result), so a missing renderer or a
 *    failed sidecar read can NEVER change authorization.
 *  - Closed set + safe degradation. An unrecognized or absent code produces the
 *    generic 'reason.miss' line and marks the presentation as a miss (the
 *    reason-code-render-miss counter the brief asks for).
 *  - No new Session event, no agent.inject / model surface, no request claim.
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { ApproveForMeLocaleKey } from './locales.js'

/** Closed vocabulary of Gate failure reason codes (landed + WP5-a sealed/storage). */
export type ReasonCode =
  // Tamper / integrity signals: unavailable, never delegated.
  | 'sealed-current-conflict'
  | 'seal-chain-invalid'
  | 'seal-live-rebind-failed'
  | 'integrity'
  | 'conflict'
  // Capacity / explainable-missing: delegate in auto-then-user mode.
  | 'sealed-current-missing'
  | 'tail-budget-overflow'
  | 'ledger-budget-overflow'
  | 'budget-overflow'
  | 'retryable-capability'
  // Storage: unavailable.
  | 'ledger-storage-unavailable'
  | 'ledger-conflict'
  // Projection: unavailable.
  | 'activity-projection-invalid'
  // Lifecycle / timing: unavailable (or cancelled for abort).
  | 'deadline'
  | 'lifecycle'
  | 'abort'

/** Presentation tone driving the reason line's visual weight. */
export type ReasonCodeTone = 'error' | 'warn' | 'muted'

/** The broad reason class used for the data-reason-class attribute. */
export type ReasonCodeClass = 'tamper' | 'capacity' | 'storage' | 'projection' | 'lifecycle' | 'generic'

export interface ReasonCodeDescriptor {
  readonly class: ReasonCodeClass
  readonly tone: ReasonCodeTone
  readonly copyKey: ApproveForMeLocaleKey
}

/**
 * Closed reason-code table. The copyKey keys resolve through the
 * approve-for-me locale namespace; the class/tone drive the renderer tone.
 */
export const REASON_CODE_TABLE: Readonly<Record<ReasonCode, ReasonCodeDescriptor>> = {
  'sealed-current-conflict': { class: 'tamper', tone: 'error', copyKey: 'reason.sealed-current-conflict' },
  'seal-chain-invalid': { class: 'tamper', tone: 'error', copyKey: 'reason.seal-chain-invalid' },
  'seal-live-rebind-failed': { class: 'tamper', tone: 'error', copyKey: 'reason.seal-live-rebind-failed' },
  integrity: { class: 'tamper', tone: 'error', copyKey: 'reason.integrity' },
  conflict: { class: 'tamper', tone: 'error', copyKey: 'reason.conflict' },
  'sealed-current-missing': { class: 'capacity', tone: 'warn', copyKey: 'reason.sealed-current-missing' },
  'tail-budget-overflow': { class: 'capacity', tone: 'warn', copyKey: 'reason.tail-budget-overflow' },
  'ledger-budget-overflow': { class: 'capacity', tone: 'warn', copyKey: 'reason.ledger-budget-overflow' },
  // budget-overflow: listed in the §4.4 brief but currently unreachable from the
  // Gate mapping -- the compileSealed hot-packet size overflow routes to
  // 'retryable-capability' (source-backed-gate-facts). Retained defensively as
  // part of the closed set.
  'budget-overflow': { class: 'capacity', tone: 'warn', copyKey: 'reason.budget-overflow' },
  'retryable-capability': { class: 'capacity', tone: 'warn', copyKey: 'reason.retryable-capability' },
  'ledger-storage-unavailable': { class: 'storage', tone: 'warn', copyKey: 'reason.ledger-storage-unavailable' },
  'ledger-conflict': { class: 'storage', tone: 'warn', copyKey: 'reason.ledger-conflict' },
  'activity-projection-invalid': { class: 'projection', tone: 'warn', copyKey: 'reason.activity-projection-invalid' },
  deadline: { class: 'lifecycle', tone: 'muted', copyKey: 'reason.deadline' },
  lifecycle: { class: 'lifecycle', tone: 'muted', copyKey: 'reason.lifecycle' },
  abort: { class: 'lifecycle', tone: 'muted', copyKey: 'reason.abort' },
}

/** Generic safe copy shown on an unexplained unavailable outcome. */
export const REASON_MISS_COPY_KEY: ApproveForMeLocaleKey = 'reason.miss'

const REASON_CODE_SET: ReadonlySet<string> = new Set(Object.keys(REASON_CODE_TABLE))

/**
 * Decode an untrusted reason-code value against the closed set. Returns an
 * unknown-safe 'undefined' for anything not exactly a known code (empty,
 * non-string, or an unrecognized value), which the presenter degrades.
 */
export function readReasonCode(value: unknown): ReasonCode | undefined {
  return typeof value === 'string' && REASON_CODE_SET.has(value) ? value as ReasonCode : undefined
}

/** The resolved presentational state for one decided row's reason line. */
export interface ReasonCodeResolution {
  /** Locale key for the reason line; 'undefined' when no reason line is warranted. */
  readonly copyKey?: ApproveForMeLocaleKey
  readonly class: ReasonCodeClass
  readonly tone: ReasonCodeTone
  /**
   * True when an 'unavailable' outcome could not be explained by a known code
   * (absent, unrecognized, or a failed sidecar read) and the generic
   * reason.miss line is shown instead. Drives the reason-code-render-miss
   * counter and never touches the outcome.
   */
  readonly miss: boolean
}

/**
 * Pure presentational mapping from an authoritative outcome + optional reason
 * code to the reason line shown in the Chat node. Never mutates or re-derives
 * 'outcome': the Gate result is a fixed input.
 */
export function resolveReasonCodePresentation(
  outcome: ApprovalOutcome,
  value: unknown,
): ReasonCodeResolution {
  const code = readReasonCode(value)
  if (code !== undefined) {
    const descriptor = REASON_CODE_TABLE[code]
    return { copyKey: descriptor.copyKey, class: descriptor.class, tone: descriptor.tone, miss: false }
  }
  if (outcome === 'unavailable') {
    return { copyKey: REASON_MISS_COPY_KEY, class: 'generic', tone: 'muted', miss: true }
  }
  // A decided outcome that is not 'unavailable' needs no reason line.
  return { class: 'generic', tone: 'muted', miss: false }
}

/**
 * Read-only sidecar query surface for the decided approval's reason code. The
 * server stores the code in a metadata-only decision row; the renderer projects
 * it here so the browser never needs a mutable or authorizing channel. A
 * missing/failing reader reports 'undefined', which degrades to the generic
 * safe line — authorization is untouched by construction.
 */
export interface ApprovalReasonCodeReader {
  /** Resolve the reason code recorded for a decided approval request id. */
  readonly read: (requestId: string) => ReasonCode | undefined
}

/** Default reader: no sidecar is available, always misses (safe generic copy). */
export const missingReasonCodeReader: ApprovalReasonCodeReader = {
  read: () => undefined,
}

/** Enrich a node's reason-code source through an optional sidecar reader. */
export function readReasonCodeFrom(
  requestId: string,
  reader: ApprovalReasonCodeReader | undefined,
): ReasonCode | undefined {
  if (reader === undefined) return undefined
  try {
    return readReasonCode(reader.read(requestId))
  } catch {
    // A failing read must never surface: safe generic line, null effect on Gate.
    return undefined
  }
}

/**
 * Browser-side resolve function backed by the server's read-only reason-code
 * query, plus a synchronous cache for values already resolved. The server
 * half {@link setApprovalReasonCodeServerReader} wires the durable, metadata-only
 * query; a miss (unset, unclearable or failing read) degrades to the generic
 * safe line and never touches the Gate outcome. This signature keeps the
 * reader {@link ApprovalReasonCodeReader} synchronous for `buildViewNode`.
 */
export interface ApprovalReasonCodeServerBridge {
  /** Resolve (and cache) a reason code for a decided approval request id. */
  readonly resolve: (requestId: string) => ReasonCode | undefined
}

/** WP5-c: the installed server-backed read bridge, or `undefined` (all misses). */
let serverReasonCodeBridge: ApprovalReasonCodeServerBridge | undefined = undefined

/** Wire (or clear) the server-backed read-only reason-code bridge. */
export function setApprovalReasonCodeServerReader(
  bridge: ApprovalReasonCodeServerBridge | undefined,
): void {
  serverReasonCodeBridge = bridge
}

/** The default browser reader: read through the server bridge, else miss. */
export function createServerBackedReasonCodeReader(): ApprovalReasonCodeReader {
  return { read: requestId => serverReasonCodeBridge?.resolve(requestId) }
}
