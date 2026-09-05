import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationMatch,
  ConversationMatchResult,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  readReasonCode,
  readReasonCodeFrom,
  type ApprovalReasonCodeReader,
  type ReasonCode,
} from './reason-code.js'

/** Browser-only projection of the canonical approval audit pair. */
export interface ApprovalFlowData {
  readonly requestId: string
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly askedSeq: number
  readonly askedAt: number
  readonly outcome?: ApprovalOutcome
  readonly decidedSeq?: number
  readonly decidedAt?: number
  /**
   * Resolved Gate failure reason code for a decided row, when the event or the
   * read-only sidecar provides one. Purely presentational — it never re-derives
   * `outcome` and never affects authorization.
   */
  readonly reasonCode?: ReasonCode
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One durable approval request and its authoritative final outcome. */
    'approve-for-me': ApprovalFlowData
  }
}

const OUTCOMES = new Set<ApprovalOutcome>([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
])

/**
 * Read-only sidecar query surface for the reason code of a decided approval.
 * The server stores it in a metadata-only decision row; the browser resolves it
 * here so no mutable/authorizing channel is needed. Defaults to a missing reader
 * (safe generic line) until the server half wires the real read API.
 */
let reasonCodeSidecarReader: ApprovalReasonCodeReader | undefined = undefined

/** Wire (or clear) the read-only sidecar reader used to enrich decided rows. */
export function setApprovalReasonCodeSidecarReader(reader: ApprovalReasonCodeReader | undefined): void {
  reasonCodeSidecarReader = reader
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function validCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/** Match only structurally valid members of the official durable approval pair. */
export function matchApprovalEvent(event: SessionEventLike): ConversationMatchResult | null {
  if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return null
  const data = record(event.data)
  const requestId = nonEmptyString(data?.['id'])
  if (requestId === undefined) return null
  if (event.type === 'approval/asked') {
    return nonEmptyString(data?.['toolName']) === undefined
      ? null
      : { id: requestId, role: 'start' }
  }
  return OUTCOMES.has(data?.['outcome'] as ApprovalOutcome)
    ? { id: requestId, role: 'update' }
    : null
}

function stateFromAsk(match: ConversationMatch): ApprovalFlowData {
  const data = record(match.event.data)
  const requestId = nonEmptyString(data?.['id'])
  const toolName = nonEmptyString(data?.['toolName'])
  const seq = validCoordinate(match.event.seq)
  const time = validCoordinate(match.event.time)
  if (match.event.type !== 'approval/asked'
    || requestId === undefined || toolName === undefined
    || seq === undefined || time === undefined) {
    throw new Error('approve-for-me conversation start requires a valid approval/asked event')
  }
  const callId = nonEmptyString(data?.['callId']) as ToolCallId | undefined
  const reason = nonEmptyString(data?.['reason'])
  return Object.freeze({
    requestId,
    toolName,
    ...callId === undefined ? {} : { callId },
    ...reason === undefined ? {} : { reason },
    askedSeq: seq,
    askedAt: time,
  })
}

function applyDecision(state: ApprovalFlowData, match: ConversationMatch): ApprovalFlowData {
  if (match.event.type !== 'approval/decided') return state
  const data = record(match.event.data)
  const requestId = nonEmptyString(data?.['id'])
  const outcome = data?.['outcome'] as ApprovalOutcome
  const seq = validCoordinate(match.event.seq)
  const time = validCoordinate(match.event.time)
  if (requestId !== state.requestId || !OUTCOMES.has(outcome)
    || seq === undefined || time === undefined) return state
  if (state.outcome === outcome && state.decidedSeq === seq && state.decidedAt === time) return state
  // The decided event may carry the Gate reason code as read-only metadata; it
  // is validated against the closed set so an unknown value degrades instead of
  // leaking into the node.
  const reasonCode = readReasonCode(data?.['reasonCode'])
  return Object.freeze({
    ...state,
    outcome,
    decidedSeq: seq,
    decidedAt: time,
    ...reasonCode === undefined ? {} : { reasonCode },
  })
}

/** Enrich a decided state with a known reason code from the read-only sidecar. */
function withSidecarReasonCode(state: ApprovalFlowData | undefined): ApprovalFlowData | undefined {
  if (state === undefined || state.reasonCode !== undefined || state.outcome === undefined) return state
  const code = readReasonCodeFrom(state.requestId, reasonCodeSidecarReader)
  if (code === undefined) return state
  return Object.freeze({ ...state, reasonCode: code })
}

function fallbackState(context: ConversationNodeContext<ApprovalFlowData>): ApprovalFlowData | undefined {
  const asked = context.matches.find(match => match.event.type === 'approval/asked')
  if (asked === undefined) return undefined
  let state = stateFromAsk(asked)
  for (const match of context.matches) state = applyDecision(state, match)
  return withSidecarReasonCode(state)
}

/**
 * Project the official non-surface audit pair into one stable Chat node. No new
 * Session event is introduced and no status text enters model history.
 */
export const approvalConversationDefinition: ConversationNodeDefinition<ApprovalFlowData> = {
  kind: 'dsh-approve-for-me/approval',
  target: 'chat',
  match: matchApprovalEvent,
  start: (_context, match) => stateFromAsk(match),
  update: (context, match) => applyDecision(context.state, match),
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = withSidecarReasonCode(context.state ?? fallbackState(context))
    if (state === undefined) return null
    return {
      key: context.key,
      kind: 'approve-for-me',
      id: context.id,
      target: 'chat',
      anchorSeq: state.askedSeq,
      // Approval is process evidence but its visibility is the feature: placing
      // the read-only row at Session scope keeps stock compact-transcript logic
      // from hiding it inside the collapsed "tool calls" disclosure.
      location: { kind: 'session' },
      visibility: 'visible',
      data: state,
    }
  },
}
