import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '../domain/json.js'
import type {
  EventRefV1,
  ParentSessionFactSnapshotV1,
  PrincipalSessionIdentityV1,
  SessionFactEventV1,
} from '../domain/dossier.js'
import type { LiveAgentRegistry, ParentSessionFactSource } from '../ports/parent-session-facts.js'

interface SessionEventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: JsonValue
}

interface SessionLike {
  readonly id: unknown
  readonly header: {
    readonly version: unknown
    readonly id: unknown
    readonly createdAt: unknown
    readonly cwd?: unknown
    readonly parentSession?: unknown
    readonly delegationDepth?: unknown
  }
  readonly events: readonly SessionEventLike[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function eventRef(event: SessionEventLike): EventRefV1 {
  const data = event.data as Record<string, unknown>
  const turn = nonNegative(data?.turn)
  const step = nonNegative(data?.step)
  return Object.freeze({
    seq: event.seq,
    type: event.type,
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  })
}

function snapshotEvent(event: SessionEventLike, surfaceState?: 'visible' | 'superseded'): SessionFactEventV1 {
  const envelope = {
    seq: event.seq,
    time: event.time,
    type: event.type,
    ...event.ignorable === true ? { ignorable: true as const } : {},
    ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: Object.freeze([...event.sourceEventSeqs]) },
    ...event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp },
    ...surfaceState === undefined ? {} : { surfaceState },
  }
  // Tool results can contain unbounded/private content. Their existence remains
  // auditable but their contents are deliberately not copied into a review packet.
  if (event.type === 'tool/result' || event.type === 'tool/code-dispatch') {
    return Object.freeze({ ...envelope, retention: 'excluded-content' as const, exclusion: 'tool-result-content' as const })
  }
  return Object.freeze({ ...envelope, retention: 'included' as const, data: event.data as JsonValue })
}

/** Conservatively classify only surface events with explicit placement. */
function snapshotEvents(events: readonly SessionEventLike[]): readonly SessionFactEventV1[] {
  const superseded = new Set<number>()
  for (const event of events) {
    const op = event.surfaceOp as { readonly op?: unknown } | undefined
    if (op?.op === 'replace') {
      for (const sourceSeq of event.sourceEventSeqs ?? []) superseded.add(sourceSeq)
    }
  }
  return Object.freeze(events.map(event => {
    const surface = event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'
    const state = surface && event.surfaceOp !== undefined ? (superseded.has(event.seq) ? 'superseded' : 'visible') : undefined
    return snapshotEvent(event, state)
  }))
}

function sessionIdentity(agent: Agent): { session: SessionLike; identity: PrincipalSessionIdentityV1 } | undefined {
  const agentId = text((agent as unknown as { id?: unknown }).id)
  const session = agent.session as unknown as SessionLike | undefined
  if (session === undefined) return undefined
  const id = text(session.id)
  const headerId = text(session.header?.id)
  const version = nonNegative(session.header?.version)
  const createdAt = nonNegative(session.header?.createdAt)
  if (agentId === undefined || id === undefined || agentId !== id || id !== headerId || version === undefined || createdAt === undefined) return undefined
  const parentSessionId = session.header.parentSession === undefined ? undefined : text(session.header.parentSession)
  if (session.header.parentSession !== undefined && parentSessionId === undefined) return undefined
  const depth = session.header.delegationDepth === undefined ? 0 : nonNegative(session.header.delegationDepth)
  if (depth === undefined) return undefined
  // Header lineage and depth are independent evidence. Never repair a
  // disagreement heuristically: either shape could be stale or forged.
  if ((parentSessionId === undefined && depth !== 0) || (parentSessionId !== undefined && depth === 0)) return undefined
  const effectiveDelegationDepth = depth
  const cwd = session.header.cwd === undefined ? undefined : text(session.header.cwd)
  if (session.header.cwd !== undefined && cwd === undefined) return undefined
  return {
    session,
    identity: Object.freeze({
      sessionId: id,
      sessionFormatVersion: version,
      createdAt,
      ...cwd === undefined ? {} : { cwd },
      ...parentSessionId === undefined ? {} : { parentSessionId },
      ...session.header.delegationDepth === undefined ? {} : { headerDelegationDepth: depth },
      effectiveDelegationDepth,
    }),
  }
}

/** DSH Session adapter: freezes only facts already present in canonical history. */
export class DshParentSessionFactSource implements ParentSessionFactSource {
  constructor(private readonly agents: LiveAgentRegistry) {}

  snapshot(input: Parameters<ParentSessionFactSource['snapshot']>[0]): ParentSessionFactSnapshotV1 | undefined {
    if (input.signal?.aborted) return undefined
    const bound = sessionIdentity(input.agent)
    if (bound === undefined || this.agents.get(bound.identity.sessionId) !== input.agent) return undefined
    const events = bound.session.events
    if (!Array.isArray(events) || events.some((event, index) => event.seq !== index || nonNegative(event.time) === undefined
      || (index > 0 && event.time < events[index - 1]!.time))) return undefined
    const askedEvents = events.filter(event => { 
      if (event.type !== 'approval/asked') return false
      const data = event.data as Record<string, unknown>
      // The fork writes the audit id as approval/asked.data.id. The public
      // requestId is deliberately checked against that durable event identity.
      return data?.id === input.approvalRequestId
        && data.callId === input.callId
        && data.toolName === input.toolName
    })
    if (askedEvents.length !== 1) return undefined
    const asked = askedEvents[0]
    if (asked === undefined) return undefined
    const matchingCalls = events.filter(event => event.seq < asked.seq && (
      (event.type === 'tool/call' && (event.data as Record<string, unknown>).callId === input.callId && (event.data as Record<string, unknown>).name === input.toolName)
      || (event.type === 'tool/code-dispatch-start' && (event.data as Record<string, unknown>).subCallId === input.callId && (event.data as Record<string, unknown>).name === input.toolName)
    ))
    // A request id must bind to exactly one canonical execution event. Ambiguous
    // correlation is an integrity failure, not an excuse to select a first match.
    if (matchingCalls.length !== 1) return undefined
    const matchingCall = matchingCalls[0]
    if (matchingCall === undefined) return undefined
    const throughSeq = asked.seq
    const sameLifecycle = (item: { readonly session: { readonly sessionId: string; readonly sessionFormatVersion: number; readonly createdAt: number; readonly cwd?: string } }): boolean =>
      item.session.sessionId === bound.identity.sessionId
      && item.session.sessionFormatVersion === bound.identity.sessionFormatVersion
      && item.session.createdAt === bound.identity.createdAt
      && item.session.cwd === bound.identity.cwd
    const executions = input.executionFacts.filter(item => sameLifecycle(item) && item.request.eventSeq <= throughSeq)
    const approvals = input.approvalSnapshots.filter(item => sameLifecycle(item) && item.approvalAskedSeq === throughSeq)
    if (approvals.length !== 1 || approvals.some(item => item.approvalRequestId !== input.approvalRequestId)) return undefined
    const correlatedExecutions = executions.filter(item =>
      item.request.eventSeq === matchingCall.seq
      && item.request.callId === input.callId
      && item.request.toolName === input.toolName)
    if (correlatedExecutions.length !== 1) return undefined
    return Object.freeze({
      version: 1,
      session: bound.identity,
      eventProjection: Object.freeze({ policyId: 'dsh-session-facts-v1', classificationCatalog: input.classificationCatalog }),
      approvalBinding: Object.freeze({ event: eventRef(asked), approvalRequestId: input.approvalRequestId, callId: input.callId, toolName: input.toolName }),
      throughSeq,
      events: snapshotEvents(events.filter(event => event.seq <= throughSeq)),
      delegationReceipts: Object.freeze(executions.flatMap(item => item.delegationReceipt === undefined ? [] : [item.delegationReceipt])),
      executionFacts: Object.freeze(executions),
      approvalSnapshots: Object.freeze(approvals),
    })
  }
}
