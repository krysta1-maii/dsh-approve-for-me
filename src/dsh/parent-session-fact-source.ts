import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { canonicalJson, freezeJson, snapshotJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import { genesisSealHash, parseActivityV1, parseSealV1 } from '../domain/sealed-facts.js'
import type { ActivityV1, SealV1 } from '../domain/sealed-facts.js'
import type { SealedFactsLedger } from './execution-projection-bridge.js'
import type {
  EventRefV1,
  ParentSessionFactSnapshotV1,
  PrincipalSessionIdentityV1,
  SessionFactEventV1,
  ToolExecutionFactRecordV1,
} from '../domain/dossier.js'
import { isApprovalEnvironmentEvidenceV1, validateDurableToolCatalogCommitmentV1 } from '../domain/dossier.js'
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
  readonly snapshotEvents?: () => readonly SessionEventLike[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0) ? value as number : undefined
}

/** Cross the source boundary with a detached, immutable strict-JSON value. */
function frozenSnapshot<T>(value: T): T | undefined {
  try {
    return freezeJson(snapshotJson(value)) as T
  } catch {
    return undefined
  }
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

function snapshotEvent(event: SessionEventLike, surfaceState?: 'visible' | 'superseded'): SessionFactEventV1 | undefined {
  if (event.sourceEventSeqs?.some(sequence => nonNegative(sequence) === undefined)) return undefined
  let surfaceOp: JsonValue | undefined
  let data: JsonValue
  try {
    surfaceOp = event.surfaceOp === undefined ? undefined : freezeJson(snapshotJson(event.surfaceOp)) as JsonValue
    data = freezeJson(snapshotJson(event.data)) as JsonValue
  } catch {
    return undefined
  }
  const envelope = {
    seq: event.seq,
    time: event.time,
    type: event.type,
    ...event.ignorable === true ? { ignorable: true as const } : {},
    ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: Object.freeze([...event.sourceEventSeqs]) },
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...surfaceState === undefined ? {} : { surfaceState },
  }
  // Tool results can contain unbounded/private content. Their existence remains
  // auditable but their contents are deliberately not copied into a review packet.
  if (event.type === 'tool/result' || event.type === 'tool/code-dispatch') {
    return Object.freeze({ ...envelope, retention: 'excluded-content' as const, exclusion: 'tool-result-content' as const })
  }
  return Object.freeze({ ...envelope, retention: 'included' as const, data })
}

/** Conservatively classify only surface events with explicit placement. */
function snapshotEvents(events: readonly SessionEventLike[]): readonly SessionFactEventV1[] | undefined {
  const superseded = new Set<number>()
  for (const event of events) {
    const op = event.surfaceOp as { readonly op?: unknown } | undefined
    if (op?.op === 'replace') {
      for (const sourceSeq of event.sourceEventSeqs ?? []) superseded.add(sourceSeq)
    }
  }
  const snapshots = events.map(event => {
    const surface = event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'
    const state = surface && event.surfaceOp !== undefined ? (superseded.has(event.seq) ? 'superseded' : 'visible') : undefined
    return snapshotEvent(event, state)
  })
  return snapshots.some(snapshot => snapshot === undefined)
    ? undefined
    : Object.freeze(snapshots as SessionFactEventV1[])
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
  const runtimeDepth = (agent as unknown as { readonly options?: { readonly subagentDepth?: unknown } }).options?.subagentDepth
  const runtimeSubagentDepth = runtimeDepth === undefined ? undefined : nonNegative(runtimeDepth)
  if (runtimeDepth !== undefined && runtimeSubagentDepth === undefined) return undefined
  let effectiveDelegationDepth: number
  try {
    effectiveDelegationDepth = delegationDepthOf(agent)
  } catch {
    return undefined
  }
  if (effectiveDelegationDepth !== Math.max(depth, runtimeSubagentDepth ?? 0)) return undefined
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
      ...runtimeSubagentDepth === undefined ? {} : { runtimeSubagentDepth },
      effectiveDelegationDepth,
    }),
  }
}

/** DSH Session adapter: freezes only facts already present in canonical history. */
export class DshParentSessionFactSource implements ParentSessionFactSource {
  constructor(private readonly agents: LiveAgentRegistry) {}

  snapshot(input: Parameters<ParentSessionFactSource['snapshot']>[0]): ParentSessionFactSnapshotV1 | undefined {
    const fail = (stage: string, detail?: unknown): undefined => {
      if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') console.error('[approve-for-me fact-source]', stage, detail === undefined ? '' : JSON.stringify(detail))
      return undefined
    }
    if (input.signal?.aborted) return fail('aborted')
    const bound = sessionIdentity(input.agent)
    if (bound === undefined || this.agents.get(bound.identity.sessionId) !== input.agent) return fail('identity')
    if (typeof bound.session.snapshotEvents !== 'function') return fail('no-snapshot-events')
    const events = bound.session.snapshotEvents()
    if (!Array.isArray(events) || events.some((event, index) => nonNegative(event.seq) === undefined || event.seq !== index || nonNegative(event.time) === undefined
      || (index > 0 && event.time < events[index - 1]!.time))) return fail('invalid-events')
    const askedEvents = events.filter(event => {
      if (event.type !== 'approval/asked') return false
      const data = event.data as Record<string, unknown>
      return data?.id === input.approvalRequestId
        && data.callId === input.callId
        && data.toolName === input.toolName
    })
    if (askedEvents.length !== 1 || askedEvents[0] === undefined) return fail('asked-event', { found: askedEvents.length, approvalRequestId: input.approvalRequestId, callId: input.callId })
    const asked = askedEvents[0]
    const throughSeq = asked.seq
    const sameLifecycle = (item: { readonly session: { readonly sessionId: string; readonly sessionFormatVersion: number; readonly createdAt: number; readonly cwd?: string } }): boolean =>
      item.session.sessionId === bound.identity.sessionId
      && item.session.sessionFormatVersion === bound.identity.sessionFormatVersion
      && item.session.createdAt === bound.identity.createdAt
      && item.session.cwd === bound.identity.cwd
    // Durable sidecars are host-private but still untrusted input: every fact
    // must bind to the exact canonical live events before it can enter the
    // frozen snapshot. A poisoned row that points at a different call or
    // result event is dropped here and makes the dossier incomplete.
    const executionMatchesLiveEvents = (item: { readonly session: { readonly sessionId: string; readonly sessionFormatVersion: number; readonly createdAt: number; readonly cwd?: string } } & ToolExecutionFactRecordV1): boolean => {
      const requestEvent = events[item.request.eventSeq]
      if (requestEvent === undefined || requestEvent.seq !== item.request.eventSeq) return false
      const requestData = requestEvent.data as Record<string, unknown>
      if (item.request.kind === 'model-tool-call') {
        if (requestEvent.type !== 'tool/call' || requestData.callId !== item.request.callId
          || requestData.name !== item.request.toolName) return false
      } else if (requestEvent.type !== 'tool/code-dispatch-start'
        || requestData.subCallId !== item.request.callId || requestData.name !== item.request.toolName
        || requestData.rootCallId !== item.request.rootCallId || requestData.parentCallId !== item.request.parentCallId) {
        return false
      }
      if (item.result === undefined) return true
      const resultEvent = events[item.result.eventSeq]
      if (resultEvent === undefined || resultEvent.seq !== item.result.eventSeq) return false
      const resultData = resultEvent.data as Record<string, unknown>
      if (item.request.kind === 'model-tool-call') {
        if (resultEvent.type !== 'tool/result' || !Array.isArray(resultEvent.sourceEventSeqs)
          || resultEvent.sourceEventSeqs.length !== 1 || resultEvent.sourceEventSeqs[0] !== requestEvent.seq) return false
        const message = resultData.message as Record<string, unknown> | undefined
        const source = message?.source as Record<string, unknown> | undefined
        const content = message?.content
        const block = Array.isArray(content) ? content[0] as Record<string, unknown> | undefined : undefined
        if (message === undefined || source?.kind !== 'tool' || source.callId !== item.request.callId
          || block?.type !== 'tool-result' || block.toolCallId !== item.request.callId) return false
      } else if (resultEvent.type !== 'tool/code-dispatch'
        || resultData.rootCallId !== item.request.rootCallId || resultData.parentCallId !== item.request.parentCallId
        || resultData.subCallId !== item.request.callId || resultData.name !== item.request.toolName) {
        return false
      }
      return true
    }
    const executions = input.executionFacts.filter(item => sameLifecycle(item)
      && item.request.eventSeq <= throughSeq
      && (item.result === undefined || item.result.eventSeq <= throughSeq)
      && executionMatchesLiveEvents(item))
    const approvals = input.approvalSnapshots.filter(item => sameLifecycle(item) && item.approvalAskedSeq === throughSeq)
    if (approvals.length !== 1 || approvals[0]?.approvalRequestId !== input.approvalRequestId) return fail('approval-sidecar', {
      found: approvals.length,
      listed: input.approvalSnapshots.length,
      throughSeq,
      rows: input.approvalSnapshots.map(item => ({ seq: item.approvalAskedSeq, requestId: item.approvalRequestId, session: item.session })),
      bound: bound.identity,
    })
    const approval = approvals[0]!
    const matchingCall = events[approval.execution.requestEventSeq]
    if (matchingCall === undefined || matchingCall.seq >= asked.seq) return fail('matching-call-seq')
    const matchingData = matchingCall.data as Record<string, unknown>
    if (!((matchingCall.type === 'tool/call' && matchingData.callId === input.callId && matchingData.name === input.toolName)
      || (matchingCall.type === 'tool/code-dispatch-start' && matchingData.subCallId === input.callId && matchingData.name === input.toolName))) return fail('matching-call-shape', { type: matchingCall.type, callId: matchingData.callId })
    const correlatedExecutions = executions.filter(item => item.request.eventSeq === matchingCall.seq
      && item.request.callId === input.callId && item.request.toolName === input.toolName)
    if (correlatedExecutions.length !== 1) return fail('correlated-executions', { found: correlatedExecutions.length, total: executions.length })
    const execution = correlatedExecutions[0]!
    const commitment = execution.catalogCommitment
    // Every execution anchors its own commitment to the exact request/header
    // in force at its root call. A legitimate mid-session catalog change starts
    // a new epoch anchored to the newer header; it never poisons earlier
    // executions still anchored to the older one. Cross-epoch uniformity is
    // replaced by per-epoch anchoring plus one-fingerprint-per-header.
    const headerSeqs = new Set(events.filter(event => event.type === 'request/header').map(event => event.seq))
    const orderedHeaderSeqs = [...headerSeqs].sort((left, right) => left - right)
    const epochFingerprints = new Map<number, string>()
    let catalogFailure: string | undefined
    const catalogAnchored = (item: typeof execution): boolean => {
      const refuse = (rule: string): boolean => { catalogFailure = rule; return false }
      const itemCommitment = item.catalogCommitment
      if (validateDurableToolCatalogCommitmentV1(itemCommitment).kind !== 'ok') return refuse('commitment-invalid')
      const itemRootRequestEventSeq = item.request.kind === 'model-tool-call'
        ? item.request.eventSeq
        : item.request.rootRequestEventSeq
      if (itemCommitment.requestHeaderEventSeq >= itemRootRequestEventSeq
        || itemRootRequestEventSeq > item.request.eventSeq) return refuse('header-seq-order')
      if (!headerSeqs.has(itemCommitment.requestHeaderEventSeq)) return refuse('header-missing')
      // The bound header must still be in force at the root call: a later
      // header at or before it means this record shopped an obsolete catalog.
      const nextHeaderSeq = orderedHeaderSeqs.find(seq => seq > itemCommitment.requestHeaderEventSeq)
      if (nextHeaderSeq !== undefined && nextHeaderSeq <= itemRootRequestEventSeq) return refuse('header-superseded')
      const headerEvent = events[itemCommitment.requestHeaderEventSeq]
      const header = headerEvent?.type === 'request/header'
        ? (headerEvent.data as Record<string, unknown>).header as Record<string, unknown> | undefined
        : undefined
      if (header === undefined
        || canonicalJson((header.tools ?? []) as JsonValue) !== canonicalJson(itemCommitment.wireSchemas as unknown as JsonValue)) return refuse('wire-schemas-mismatch')
      // One header epoch carries exactly one commitment fingerprint; a second
      // fingerprint under the same header means a record was rewritten.
      const epochFingerprint = epochFingerprints.get(itemCommitment.requestHeaderEventSeq)
      if (epochFingerprint !== undefined && epochFingerprint !== itemCommitment.fingerprint) return refuse('epoch-split')
      epochFingerprints.set(itemCommitment.requestHeaderEventSeq, itemCommitment.fingerprint)
      return true
    }
    if (executions.some(item => !catalogAnchored(item))) return fail('catalog-commitment', { rule: catalogFailure })
    if (!isApprovalEnvironmentEvidenceV1(approval.environment)
      || approval.execution.requestEventSeq !== matchingCall.seq || approval.execution.requestEventSeq !== execution.request.eventSeq
      || approval.execution.callId !== input.callId || approval.execution.callId !== execution.request.callId
      || approval.execution.toolName !== input.toolName || approval.execution.toolName !== execution.request.toolName
      || approval.execution.actionHash !== execution.projection.actionHash
      || approval.execution.classificationCatalogFingerprint !== commitment.classificationCatalog.fingerprint
      || approval.execution.classificationCatalogFingerprint !== execution.toolClassification.classificationCatalogFingerprint
      || approval.execution.projectorId !== execution.projection.projectorId) return fail('environment-binding')
    const eventSnapshots = snapshotEvents(events.filter(event => event.seq <= throughSeq))
    const classificationCatalog = frozenSnapshot(commitment.classificationCatalog)
    const executionSnapshots = executions.map(frozenSnapshot)
    const approvalSnapshots = approvals.map(frozenSnapshot)
    if (eventSnapshots === undefined || classificationCatalog === undefined
      || executionSnapshots.some(snapshot => snapshot === undefined)
      || approvalSnapshots.some(snapshot => snapshot === undefined)) return fail('freeze')
    const frozenExecutions = executionSnapshots as typeof executions
    const frozenApprovals = approvalSnapshots as typeof approvals
    return Object.freeze({
      version: 1,
      session: bound.identity,
      eventProjection: Object.freeze({ policyId: 'dsh-session-facts-v1', classificationCatalog }),
      approvalBinding: Object.freeze({ event: eventRef(asked), approvalRequestId: input.approvalRequestId, callId: input.callId, toolName: input.toolName }),
      throughSeq,
      events: eventSnapshots,
      delegationReceipts: Object.freeze(frozenExecutions.flatMap(item => item.delegationReceipt === undefined ? [] : [item.delegationReceipt])),
      executionFacts: Object.freeze(frozenExecutions),
      approvalSnapshots: Object.freeze(frozenApprovals),
    })
  }
}

/**
 * Bounded sealed-ledger input for WP4. Disk rows are only an integrity index:
 * each row is re-bound to the exact live Session event before it is returned.
 */
export interface SealedParentSessionFactsV1 {
  readonly version: 1
  readonly lifecycleFingerprint: string
  readonly current: { readonly seal: SealV1; readonly activity: ActivityV1 }
  readonly seals: readonly SealV1[]
  readonly activities: readonly ActivityV1[]
  readonly catalogEpochs: readonly { readonly epoch: number; readonly headerEventSeq: number; readonly commitment: string }[]
}

/** Return no facts for missing, polluted, unsealed, or non-live-rebindable history. */
export async function readSealedParentSessionFacts(input: {
  readonly agent: Agent
  readonly registry: LiveAgentRegistry
  readonly ledger: SealedFactsLedger | undefined
  readonly approvalRequestId: string
  readonly callId: string
  readonly toolName: string
  readonly signal?: AbortSignal
}): Promise<SealedParentSessionFactsV1 | undefined> {
  if (input.signal?.aborted || input.ledger === undefined) return undefined
  const bound = sessionIdentity(input.agent)
  if (bound === undefined || input.registry.get(bound.identity.sessionId) !== input.agent || typeof bound.session.snapshotEvents !== 'function') return undefined
  const events = bound.session.snapshotEvents()
  if (!Array.isArray(events) || events.some((event, index) => event.seq !== index || nonNegative(event.time) === undefined)) return undefined
  const lifecycleFingerprint = canonicalJson({ sessionId: bound.identity.sessionId, sessionFormatVersion: bound.identity.sessionFormatVersion, createdAt: bound.identity.createdAt, ...(bound.identity.cwd === undefined ? {} : { cwd: bound.identity.cwd }) })
  let rows: readonly { readonly seal: SealV1; readonly activity: ActivityV1 }[] | undefined
  try { rows = await input.ledger.read(lifecycleFingerprint) } catch { return undefined }
  if (input.signal?.aborted || rows === undefined || rows.length === 0) return undefined
  const epochs = new Map<number, { readonly epoch: number; readonly headerEventSeq: number; readonly commitment: string }>()
  const validatedRows: { readonly seal: SealV1; readonly activity: ActivityV1 }[] = []
  let previousSealHash = genesisSealHash(lifecycleFingerprint)
  let previousSourceSeq = -1
  for (const row of rows) {
    let seal: SealV1
    let activity: ActivityV1
    try { seal = parseSealV1(row.seal); activity = parseActivityV1(row.activity) } catch { return undefined }
    if (seal.lifecycleFingerprint !== lifecycleFingerprint || seal.sourceSeq <= previousSourceSeq || seal.previousSealHash !== previousSealHash) return undefined
    previousSealHash = seal.sealHash
    previousSourceSeq = seal.sourceSeq
    const request = events[seal.request.eventSeq]
    const asked = events[seal.approvalAsked.eventSeq]
    const result = events[seal.result.eventSeq]
    const header = events[seal.catalog.headerEventSeq]
    if (request?.seq !== seal.sourceSeq || asked?.seq !== seal.approvalAsked.eventSeq || result?.seq !== seal.result.eventSeq || header?.seq !== seal.catalog.headerEventSeq
      || header.type !== 'request/header' || asked.type !== 'approval/asked' || result.type !== (seal.request.eventType === 'tool/call' ? 'tool/result' : 'tool/code-dispatch')
      || activity.lifecycleFingerprint !== lifecycleFingerprint || activity.sourceSeq !== seal.sourceSeq || activity.sourceSealHash !== seal.sealHash) return undefined
    const requestData = request.data as Record<string, unknown>
    const askedData = asked.data as Record<string, unknown>
    const resultData = result.data as Record<string, unknown>
    if (askedData.id !== seal.approvalAsked.requestId || askedData.callId !== seal.request.callId || askedData.toolName !== seal.request.toolName) return undefined
    if (seal.request.eventType === 'tool/call') {
      if (request.type !== 'tool/call' || requestData.callId !== seal.request.callId || requestData.name !== seal.request.toolName
        || !Array.isArray(result.sourceEventSeqs) || result.sourceEventSeqs.length !== 1 || result.sourceEventSeqs[0] !== request.seq) return undefined
      const message = resultData.message as Record<string, unknown> | undefined
      const source = message?.source as Record<string, unknown> | undefined
      const block = Array.isArray(message?.content) ? message?.content[0] as Record<string, unknown> | undefined : undefined
      if (source?.kind !== 'tool' || source.callId !== seal.request.callId || block?.type !== 'tool-result' || block.toolCallId !== seal.request.callId) return undefined
    } else if (request.type !== 'tool/code-dispatch-start' || requestData.subCallId !== seal.request.callId || requestData.name !== seal.request.toolName
      || resultData.subCallId !== seal.request.callId || resultData.name !== seal.request.toolName
      || requestData.rootCallId !== resultData.rootCallId || requestData.parentCallId !== resultData.parentCallId) return undefined
    const prior = epochs.get(seal.catalog.epoch)
    const epoch = { epoch: seal.catalog.epoch, headerEventSeq: seal.catalog.headerEventSeq, commitment: seal.catalog.commitment }
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(epoch)) return undefined
    epochs.set(epoch.epoch, Object.freeze(epoch))
    validatedRows.push(Object.freeze({ seal, activity }))
  }
  const current = validatedRows.filter(row => row.seal.approvalAsked.requestId === input.approvalRequestId && row.seal.request.callId === input.callId && row.seal.request.toolName === input.toolName)
  if (current.length !== 1) return undefined
  return Object.freeze({ version: 1, lifecycleFingerprint, current: current[0]!, seals: Object.freeze(validatedRows.map(row => row.seal)), activities: Object.freeze(validatedRows.map(row => row.activity)), catalogEpochs: Object.freeze([...epochs.values()].sort((a,b) => a.epoch - b.epoch)) })
}
