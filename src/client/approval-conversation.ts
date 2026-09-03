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
  return Object.freeze({ ...state, outcome, decidedSeq: seq, decidedAt: time })
}

function fallbackState(context: ConversationNodeContext<ApprovalFlowData>): ApprovalFlowData | undefined {
  const asked = context.matches.find(match => match.event.type === 'approval/asked')
  if (asked === undefined) return undefined
  let state = stateFromAsk(asked)
  for (const match of context.matches) state = applyDecision(state, match)
  return state
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
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    return {
      key: context.key,
      kind: 'approve-for-me',
      id: context.id,
      target: 'chat',
      anchorSeq: state.askedSeq,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: state,
    }
  },
}
