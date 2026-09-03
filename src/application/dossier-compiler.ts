import { canonicalJson, freezeJson, parseUniqueJson, snapshotJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type {
  DirectUserMessageV1,
  DossierCompilationResultV1,
  EventRefV1,
  GuardianDossierCompiler,
  GuardianDossierCompilerDependencies,
  InteractionTurnV1,
  InstructionMessageV1,
  ParentSessionFactSnapshotV1,
  PrincipalDelegationEntryV1,
  SessionFactEventV1,
  ToolAttemptV1,
} from '../domain/dossier.js'
import {
  effectiveToolBindingsFromRequestHeaderV1,
  isApprovalEnvironmentEvidenceV1,
  sealSourceVerifiedDossier,
  validateDelegationToolCatalog,
  validateDurableToolCatalogCommitmentV1,
  validateToolTrajectorySection,
} from '../domain/dossier.js'
import { hashAction } from '../domain/protocol.js'
import type { ActionSnapshot } from '../domain/protocol.js'

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function sameLifecycle(
  left: { readonly sessionId: string; readonly sessionFormatVersion: number; readonly createdAt: number; readonly cwd?: string },
  right: { readonly sessionId: string; readonly sessionFormatVersion: number; readonly createdAt: number; readonly cwd?: string },
): boolean {
  return left.sessionId === right.sessionId
    && left.sessionFormatVersion === right.sessionFormatVersion
    && left.createdAt === right.createdAt
    && left.cwd === right.cwd
}

function canonicalSize(value: unknown): { readonly bytes: number; readonly characters: number } {
  const json = canonicalJson(value as JsonValue)
  return Object.freeze({ bytes: new TextEncoder().encode(json).byteLength, characters: json.length })
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function validPrincipalSession(session: ParentSessionFactSnapshotV1['session']): boolean {
  const nonNegative = nonNegativeSafeInteger
  return typeof session.sessionId === 'string' && session.sessionId.length > 0
    && nonNegative(session.sessionFormatVersion)
    && nonNegative(session.createdAt)
    && (session.cwd === undefined || (typeof session.cwd === 'string' && session.cwd.length > 0))
    && nonNegative(session.effectiveDelegationDepth)
    && (session.parentSessionId === undefined || (typeof session.parentSessionId === 'string' && session.parentSessionId.length > 0))
}

function actionArgumentsMatchCall(actionArguments: JsonValue, rawArguments: unknown): boolean {
  try {
    const parsed = typeof rawArguments === 'string' ? parseUniqueJson(rawArguments) : snapshotJson(rawArguments)
    return canonicalJson(parsed) === canonicalJson(actionArguments)
  } catch {
    return false
  }
}

function validTerminalOutcome(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const outcome = value as Record<string, unknown>
  if (outcome.kind === 'completed' || outcome.kind === 'tool-error') return Object.keys(outcome).length === 1
  if (outcome.kind !== 'sandbox-denied'
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(outcome.mode as string)
    || (outcome.enforcement !== undefined && outcome.enforcement !== 'full' && outcome.enforcement !== 'partial')) return false
  const keys = Object.keys(outcome)
  return keys.length === (outcome.enforcement === undefined ? 2 : 3)
    && keys.every(key => key === 'kind' || key === 'mode' || key === 'enforcement')
}

function directUserMessage(event: SessionFactEventV1, turn: number | undefined): DirectUserMessageV1 | undefined {
  if (event.retention !== 'included' || event.type !== 'user/message'
    || (event.surfaceState !== undefined && event.surfaceState !== 'visible' && event.surfaceState !== 'superseded')) return undefined
  const data = record(event.data)
  const source = data === undefined ? undefined : record(data.source as JsonValue)
  const messageId = data?.id
  const content = data?.content
  if (source?.kind !== 'user' || typeof messageId !== 'string' || messageId.length === 0
    || !Array.isArray(content) || turn === undefined) return undefined
  return Object.freeze({
    event: Object.freeze({ seq: event.seq, type: event.type, turn }),
    messageId,
    content: Object.freeze([...content] as JsonValue[]),
    surfaceState: event.surfaceState ?? 'visible',
  })
}

function instructionMessage(event: SessionFactEventV1): InstructionMessageV1 | undefined {
  if (event.retention !== 'included' || event.type !== 'user/message' || event.surfaceState !== 'visible') return undefined
  const data = record(event.data)
  const source = data === undefined ? undefined : record(data.source as JsonValue)
  const messageId = data?.id
  const content = data?.content
  if (source?.form !== 'instructions' || typeof source.kind !== 'string' || source.kind.length === 0
    || typeof messageId !== 'string' || messageId.length === 0 || !Array.isArray(content)) return undefined
  if (source.baseline !== undefined && typeof source.baseline !== 'boolean') return undefined
  if (source.baselineIdentity !== undefined && (typeof source.baselineIdentity !== 'string' || source.baselineIdentity.length === 0)) return undefined
  if (source.changes !== undefined && !Array.isArray(source.changes)) return undefined
  return Object.freeze({
    event: Object.freeze({ seq: event.seq, type: event.type }),
    messageId,
    source: Object.freeze({
      kind: source.kind,
      form: 'instructions' as const,
      ...(source.baseline === undefined ? {} : { baseline: source.baseline as boolean }),
      ...(source.baselineIdentity === undefined ? {} : { baselineIdentity: source.baselineIdentity as string }),
      ...(source.changes === undefined ? {} : { changes: Object.freeze([...source.changes] as JsonValue[]) }),
    }),
    content: Object.freeze([...content] as JsonValue[]),
  })
}

function instructionsFrom(facts: ParentSessionFactSnapshotV1): readonly InstructionMessageV1[] | undefined {
  const messages: InstructionMessageV1[] = []
  for (const event of facts.events) {
    if (event.type !== 'user/message') continue
    const data = event.retention === 'included' ? record(event.data) : undefined
    const source = data === undefined ? undefined : record(data.source as JsonValue)
    if (source?.form !== 'instructions') continue
    const message = instructionMessage(event)
    if (message === undefined) return undefined
    messages.push(message)
  }
  return Object.freeze(messages)
}

function requestHeadersFrom(facts: ParentSessionFactSnapshotV1): readonly JsonValue[] | undefined {
  const headers: JsonValue[] = []
  for (const event of facts.events) {
    if (event.type !== 'request/header') continue
    const snapshot = event.retention === 'included' ? record(event.data) : undefined
    const header = snapshot === undefined ? undefined : record(snapshot.header as JsonValue)
    // DSH persists `request/header` as `{ header: EpochHeader, reason }`; only
    // the contained complete canonical header is material for the dossier.
    if (header === undefined || header.config === undefined
      || (header.tools !== undefined && !Array.isArray(header.tools))
      || (header.system !== undefined && typeof header.system !== 'string')
      || (snapshot?.reason !== 'initial' && snapshot?.reason !== 'resume' && snapshot?.reason !== 'change' && snapshot?.reason !== 'series')) return undefined
    headers.push(header)
  }
  return Object.freeze(headers)
}

function requestHeaderFrom(facts: ParentSessionFactSnapshotV1): JsonValue | undefined {
  const headers = requestHeadersFrom(facts)
  return headers === undefined ? undefined : headers.at(-1)
}

function approvalPolicyHistoryIsConsistent(events: readonly SessionFactEventV1[]): boolean {
  let latest: 'ask' | 'never' | undefined
  for (const event of events) {
    if (event.type !== 'approval/policy') continue
    if (event.retention !== 'included') return false
    const data = record(event.data)
    if (data === undefined || (data.policy !== 'ask' && data.policy !== 'never')
      || (data.source !== undefined && data.source !== 'delegation')
      || Object.keys(data).some(key => key !== 'policy' && key !== 'source')) return false
    latest = data.policy
  }
  // ApprovalService checks the effective policy before it appends the bound
  // approval/asked event. A prefix ending in a pending ask cannot legitimately
  // have an explicit `never` override in effect.
  return latest !== 'never'
}

function requestContextFrom(facts: ParentSessionFactSnapshotV1): JsonValue | undefined {
  let latest: JsonValue | undefined
  for (const event of facts.events) {
    if (event.type !== 'request/context') continue
    const context = event.retention === 'included' ? record(event.data) : undefined
    const contextWindow = context?.contextWindow
    if (context === undefined || typeof context.provider !== 'string' || context.provider.length === 0
      || typeof context.model !== 'string' || context.model.length === 0
      || (contextWindow !== undefined && (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 0))) {
      return undefined
    }
    latest = context
  }
  return latest
}

function assistantMessagesForCalls(
  events: readonly SessionFactEventV1[],
  calls: readonly { readonly eventSeq: number; readonly callId: string; readonly toolName: string; readonly rawArguments: unknown; readonly turn: number; readonly step: number }[],
  currentTurn: number,
  currentStep: number,
): ReadonlyMap<number, { readonly issuedIn: EventRefV1; readonly blockIndex: number }> | undefined {
  const validPosition = (turn: unknown, step: unknown): turn is number => Number.isSafeInteger(turn) && (turn as number) >= 0
    && Number.isSafeInteger(step) && (step as number) >= 0
    && ((turn as number) < currentTurn || ((turn as number) === currentTurn && (step as number) <= currentStep))
  if (events.filter(event => event.type === 'assistant/chunk').some(event => {
    const data = event.retention === 'included' ? record(event.data) : undefined
    return !validPosition(data?.turn, data?.step)
  })) return undefined
  const byStep = new Map<string, typeof calls>()
  for (const call of calls) {
    const key = `${call.turn}:${call.step}`
    byStep.set(key, [...(byStep.get(key) ?? []), call])
  }
  const bindings = new Map<number, { readonly issuedIn: EventRefV1; readonly blockIndex: number }>()
  const boundSteps = new Set<string>()
  for (const event of events.filter(candidate => candidate.type === 'assistant/message')) {
    const data = event.retention === 'included' ? record(event.data) : undefined
    const message = data === undefined ? undefined : record(data.message as JsonValue)
    const source = message === undefined ? undefined : record(message.source as JsonValue)
    const messageTurn = data?.turn
    const messageStep = data?.step
    if (!validPosition(messageTurn, messageStep) || data?.interrupted === true || message?.role !== 'assistant'
      || typeof message.id !== 'string' || message.id.length === 0 || source?.kind !== 'model' || !Array.isArray(message.content)) return undefined
    const toolBlocks = message.content.map((block, blockIndex) => ({ block: record(block as JsonValue), blockIndex }))
      .filter(item => item.block?.type === 'tool-call')
    if (toolBlocks.length === 0) continue
    if (message.content.some(block => {
      const type = record(block as JsonValue)?.type
      return type !== 'tool-call' && type !== 'text' && type !== 'reasoning'
    })) return undefined
    const key = `${messageTurn}:${messageStep}`
    const callsForMessage = byStep.get(key)
    if (callsForMessage === undefined || boundSteps.has(key) || callsForMessage.some(call => call.eventSeq <= event.seq)
      || toolBlocks.length !== callsForMessage.length) return undefined
    boundSteps.add(key)
    for (const [index, call] of callsForMessage.entries()) {
      const item = toolBlocks[index]!
      if (item.block?.id !== call.callId || item.block.name !== call.toolName || item.block.arguments !== call.rawArguments) return undefined
      bindings.set(call.eventSeq, Object.freeze({
        issuedIn: Object.freeze({ seq: event.seq, type: event.type, turn: messageTurn, step: messageStep as number }),
        blockIndex: item.blockIndex,
      }))
    }
  }
  return bindings.size === calls.length ? bindings : undefined
}

function pendingTurnIsOpen(events: readonly SessionFactEventV1[], turn: number, step: number): boolean {
  const exactEvent = (type: 'turn/start' | 'step/start', expected: Record<string, number>) => {
    const matches = events.filter(event => {
      if (event.type !== type || event.retention !== 'included') return false
      const data = record(event.data)
      return data !== undefined && Object.entries(expected).every(([key, value]) => data[key] === value)
    })
    return matches.length === 1 ? matches[0] : undefined
  }
  const turnStart = exactEvent('turn/start', { turn })
  if (turnStart === undefined) return false
  let previousEndSeq = turnStart.seq
  // Alpha.1 persisted sessions number steps from 1; older fixtures/providers
  // may start at 0. Require one contiguous convention for the whole turn.
  const firstStep = exactEvent('step/start', { turn, step: 0 }) === undefined ? 1 : 0
  if (step < firstStep) return false
  for (let candidateStep = firstStep; candidateStep <= step; candidateStep++) {
    const stepStart = exactEvent('step/start', { turn, step: candidateStep })
    if (stepStart === undefined || stepStart.seq <= previousEndSeq) return false
    const ends = events.filter(event => {
      if (event.type !== 'step/end' || event.retention !== 'included') return false
      const data = record(event.data)
      return data?.turn === turn && data.step === candidateStep
    })
    if ((candidateStep < step && ends.length !== 1) || (candidateStep === step && ends.length !== 0)) return false
    const end = ends[0]
    if (end !== undefined && end.seq <= stepStart.seq) return false
    if (events.some(event => {
      const data = event.retention === 'included' ? record(event.data) : undefined
      return data?.turn === turn && data.step === candidateStep && event.seq < stepStart.seq
    })) return false
    if (end !== undefined) previousEndSeq = end.seq
  }
  return !events.some(event => {
    if (event.type !== 'turn/end') return false
    const data = event.retention === 'included' ? record(event.data) : undefined
    return data?.turn === turn
  })
}

function turnEndSummary(reason: JsonValue | undefined): InteractionTurnV1['end'] | undefined {
  const structured = reason === undefined ? undefined : record(reason)
  const kind = typeof reason === 'string' ? reason : structured?.kind
  if (typeof kind !== 'string' || kind.length === 0) return undefined
  if (kind === 'completed' || kind === 'aborted' || kind === 'blocked' || kind === 'max-tokens' || kind === 'interrupted') {
    return Object.freeze({ kind }) as InteractionTurnV1['end']
  }
  if (kind === 'error') {
    const code = structured === undefined ? undefined : record(structured.error as JsonValue)?.code
    return Object.freeze({ kind: 'error' as const, ...(typeof code === 'string' && code.length > 0 ? { code } : {}) })
  }
  return Object.freeze({ kind: 'extension' as const, reason: reason as JsonValue })
}

function interactionFrom(facts: ParentSessionFactSnapshotV1, toolMessageSeqs: ReadonlySet<number>): InteractionTurnV1[] | undefined {
  const users = new Map<number, DirectUserMessageV1[]>()
  const starts = new Map<number, SessionFactEventV1>()
  const ends = new Map<number, SessionFactEventV1>()
  const assistants = new Map<number, SessionFactEventV1[]>()
  let activeTurn: number | undefined
  for (const event of facts.events) {
    if (event.type === 'turn/start') {
      const turn = event.retention === 'included' ? record(event.data)?.turn : undefined
      if (!Number.isSafeInteger(turn) || (turn as number) < 0 || activeTurn !== undefined || starts.has(turn as number)) return undefined
      starts.set(turn as number, event)
      activeTurn = turn as number
      continue
    }
    if (event.type === 'turn/end') {
      const turn = event.retention === 'included' ? record(event.data)?.turn : undefined
      if (!Number.isSafeInteger(turn) || (turn as number) < 0 || activeTurn !== turn || ends.has(turn as number)
        || starts.get(turn as number) === undefined || starts.get(turn as number)!.seq >= event.seq) return undefined
      ends.set(turn as number, event)
      activeTurn = undefined
      continue
    }
    if (event.type === 'assistant/message') {
      const turn = event.retention === 'included' ? record(event.data)?.turn : undefined
      if (!Number.isSafeInteger(turn) || (turn as number) < 0 || starts.get(turn as number) === undefined) return undefined
      assistants.set(turn as number, [...(assistants.get(turn as number) ?? []), event])
      continue
    }
    if (event.type !== 'user/message') continue
    const data = event.retention === 'included' ? record(event.data) : undefined
    const source = data === undefined ? undefined : record(data.source as JsonValue)
    // Only canonical direct-user messages contribute user authority. Stock Host
    // plugin snapshots share the user/message event type but remain non-authorizing.
    if (source?.kind !== 'user') continue
    const message = directUserMessage(event, activeTurn)
    if (message === undefined || message.event.turn === undefined) return undefined
    users.set(message.event.turn, [...(users.get(message.event.turn) ?? []), message])
  }
  for (const [turn, messages] of assistants) {
    if (ends.has(turn)) continue
    if (messages.some(event => !toolMessageSeqs.has(event.seq))) return undefined
  }
  const turns = new Set([...users.keys(), ...ends.keys()])
  const result: InteractionTurnV1[] = []
  for (const turn of [...turns].sort((a, b) => a - b)) {
    const endEvent = ends.get(turn)
    const endData = endEvent === undefined || endEvent.retention !== 'included' ? undefined : record(endEvent.data)
    const reason = endData?.reason
    const end = reason === undefined ? undefined : turnEndSummary(reason)
    if (endEvent !== undefined && end === undefined) return undefined
    let delivery: InteractionTurnV1['delivery']
    const messages = assistants.get(turn) ?? []
    if (endEvent !== undefined && messages.some(message => message.seq >= endEvent.seq)) return undefined
    const deliveryMessages = messages.filter(message => !toolMessageSeqs.has(message.seq))
    if (end?.kind !== 'completed' && deliveryMessages.length > 0) return undefined
    if (end?.kind === 'completed' && deliveryMessages.length > 0) {
      if (deliveryMessages.length !== 1) return undefined
      const event = deliveryMessages[0]!
      const data = event.retention === 'included' ? record(event.data) : undefined
      const message = data === undefined ? undefined : record(data.message as JsonValue)
      const source = message === undefined ? undefined : record(message.source as JsonValue)
      const content = message?.content
      const textBlocks: string[] = []
      if (Array.isArray(content)) {
        for (const block of content) {
          const text = record(block as JsonValue)
          if (text?.type === 'reasoning' && typeof text.text === 'string') continue
          if (text?.type !== 'text' || typeof text.text !== 'string' || text.text.length === 0) {
            textBlocks.length = 0
            break
          }
          textBlocks.push(text.text)
        }
      }
      if ((event.surfaceState !== 'visible' && event.surfaceState !== 'superseded') || data?.interrupted === true || message?.role !== 'assistant'
        || source?.kind !== 'model' || typeof message.id !== 'string' || message.id.length === 0
        || !Array.isArray(content) || textBlocks.length === 0) return undefined
      delivery = Object.freeze({ event: Object.freeze({ seq: event.seq, type: event.type, turn }), messageId: message.id, textBlocks: Object.freeze(textBlocks), surfaceState: event.surfaceState })
    }
    result.push(Object.freeze({ turn, directUserMessages: Object.freeze(users.get(turn) ?? []), ...(delivery === undefined ? {} : { delivery }), ...(end === undefined ? {} : { end }) }))
  }
  return result
}

/**
 * Deterministic D1 compiler (current pure subset). It validates the frozen
 * source snapshot's principal/authority/execution-fact requirements and builds
 * a bounded `GuardianDossierV1`. It retains direct-user/instruction surfaces,
 * visible principal deliveries, content-free historical tool outcomes, and
 * parent-side delegation receipts without copying tool output or reasoning.
 */
export class DefaultDossierCompiler implements GuardianDossierCompiler {
  constructor(private readonly deps: GuardianDossierCompilerDependencies) {}

  compile(input: {
    readonly facts: ParentSessionFactSnapshotV1
    readonly signal?: AbortSignal
  }): DossierCompilationResultV1 {
    if (input.signal?.aborted) return { kind: 'incomplete', reason: 'aborted' }
    let facts: ParentSessionFactSnapshotV1
    try {
      facts = freezeJson(snapshotJson(input.facts)) as unknown as ParentSessionFactSnapshotV1
    } catch {
      return { kind: 'incomplete', reason: 'invalid-fact-snapshot' }
    }
    if (!Number.isSafeInteger(this.deps.maxDossierBytes) || this.deps.maxDossierBytes < 1) {
      return { kind: 'incomplete', reason: 'invalid-dossier-budget' }
    }
    if (facts.version !== 1 || facts.eventProjection.policyId !== 'dsh-session-facts-v1') {
      return { kind: 'incomplete', reason: 'event-projection-policy-mismatch' }
    }
    if (!validPrincipalSession(facts.session)) {
      return { kind: 'incomplete', reason: 'invalid-parent-session-identity' }
    }
    if (facts.session.effectiveDelegationDepth !== 0 || facts.session.parentSessionId !== undefined) {
      return { kind: 'incomplete', reason: 'unsupported-delegated-requester' }
    }
    if (facts.approvalBinding.approvalRequestId.length === 0 || facts.approvalBinding.callId.length === 0
      || facts.approvalBinding.toolName.length === 0) return { kind: 'incomplete', reason: 'missing-call-id' }
    if (facts.throughSeq !== facts.approvalBinding.event.seq || facts.approvalBinding.event.type !== 'approval/asked') {
      return { kind: 'incomplete', reason: 'invalid-approval-binding' }
    }
    const snapshots = facts.approvalSnapshots.filter(item =>
      item.approvalRequestId === facts.approvalBinding.approvalRequestId)
    if (snapshots.length !== 1) return { kind: 'incomplete', reason: 'missing-required-projection' }
    const snapshot = snapshots[0]!
    const executions = facts.executionFacts.filter(item =>
      item.request.eventSeq === snapshot.execution.requestEventSeq
      && item.request.callId === facts.approvalBinding.callId
      && item.request.toolName === facts.approvalBinding.toolName)
    if (executions.length !== 1) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    const execution = executions[0]!
    if (execution.version !== 1
      || validateDurableToolCatalogCommitmentV1(execution.catalogCommitment).kind !== 'ok'
      || canonicalJson(execution.catalogCommitment.classificationCatalog) !== canonicalJson(facts.eventProjection.classificationCatalog)
      || !sameLifecycle(execution.session, facts.session)
      || execution.projection.action.toolName !== execution.request.toolName
      || execution.projection.projectorId !== execution.projection.action.projectorId
      || execution.projection.actionHash !== hashAction(execution.projection.action)) {
      return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    }
    if (this.deps.semanticActionBindings !== undefined) {
      const semantic = this.deps.semanticActionBindings.filter(binding => binding.toolName === execution.request.toolName)
      if (semantic.length !== 1 || semantic[0]!.family !== execution.projection.action.semantics.family
        || semantic[0]!.projectorId !== execution.projection.action.projectorId) {
        return { kind: 'incomplete', reason: 'semantic-projection-mismatch' }
      }
    }
    const catalogDescriptors = facts.eventProjection.classificationCatalog.descriptors.filter(descriptor =>
      descriptor.toolName === execution.request.toolName)
    if (catalogDescriptors.length !== 1
      || execution.toolClassification.classificationCatalogFingerprint !== facts.eventProjection.classificationCatalog.fingerprint
      || canonicalJson(catalogDescriptors[0]!) !== canonicalJson(execution.toolClassification.descriptor)) {
      return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    }
    if (snapshot.version !== 1 || !sameLifecycle(snapshot.session, facts.session) || snapshot.approvalAskedSeq !== facts.throughSeq
      || !Number.isSafeInteger(snapshot.execution.requestEventSeq) || snapshot.execution.requestEventSeq < 0
      || snapshot.execution.requestEventSeq !== execution.request.eventSeq
      || snapshot.execution.callId.length === 0 || snapshot.execution.callId !== execution.request.callId
      || snapshot.execution.toolName.length === 0 || snapshot.execution.toolName !== execution.request.toolName
      || snapshot.execution.actionHash !== execution.projection.actionHash
      || snapshot.execution.classificationCatalogFingerprint !== execution.toolClassification.classificationCatalogFingerprint
      || snapshot.execution.projectorId.length === 0 || snapshot.execution.projectorId !== execution.projection.projectorId
      || !isApprovalEnvironmentEvidenceV1(snapshot.environment)) {
      return { kind: 'incomplete', reason: 'missing-required-projection' }
    }
    // Build a content-free, source-bijective trajectory across completed prior
    // turns and the open approval turn. Tool outputs and model reasoning stay
    // excluded; terminal outcomes, delegation receipts, and visible deliveries
    // remain represented so ordinary long-running histories are not discarded.
    if (facts.events.length !== facts.throughSeq + 1 || facts.events.some((event, index) => !nonNegativeSafeInteger(event.seq) || event.seq !== index)) {
      return { kind: 'incomplete', reason: 'non-contiguous-event-prefix' }
    }
    if (facts.events.some((event, index) => !nonNegativeSafeInteger(event.time)
      || (index > 0 && event.time < facts.events[index - 1]!.time))) {
      return { kind: 'incomplete', reason: 'invalid-event-time-order' }
    }
    const askedEvent = facts.events[facts.throughSeq]
    const askedData = askedEvent?.retention === 'included' ? record(askedEvent.data) : undefined
    if (facts.approvalBinding.event.seq !== facts.throughSeq || facts.approvalBinding.event.type !== 'approval/asked') {
      return { kind: 'incomplete', reason: 'invalid-approval-binding' }
    }
    if (askedEvent?.type !== 'approval/asked' || askedData?.id !== facts.approvalBinding.approvalRequestId
      || askedData.callId !== facts.approvalBinding.callId || askedData.toolName !== facts.approvalBinding.toolName) {
      return { kind: 'incomplete', reason: 'missing-current-request-event' }
    }
    if (!nonNegativeSafeInteger(askedEvent.time)) return { kind: 'incomplete', reason: 'invalid-frozen-event-time' }

    const callEvent = facts.events[execution.request.eventSeq]
    const callData = callEvent?.retention === 'included' ? record(callEvent.data) : undefined
    if (execution.request.eventSeq >= facts.throughSeq || callEvent?.type !== execution.request.eventType
      || execution.projection.observedAt !== callEvent.time) {
      return { kind: 'incomplete', reason: 'missing-required-execution-event' }
    }
    const nativeRootEvents = facts.events.filter(event => event.type === 'tool/call')
    const nativeRootByEventSeq = new Map<number, SessionFactEventV1>()
    for (const event of nativeRootEvents) {
      const data = event.retention === 'included' ? record(event.data) : undefined
      if (typeof data?.callId !== 'string' || data.callId.length === 0) {
        return { kind: 'incomplete', reason: 'missing-required-execution-event' }
      }
      nativeRootByEventSeq.set(event.seq, event)
    }
    let currentPositionEvent = callEvent
    if (execution.request.kind === 'model-tool-call') {
      if (callData?.callId !== execution.request.callId || callData.name !== execution.request.toolName
        || !actionArgumentsMatchCall(execution.projection.action.arguments, callData.arguments)) {
        return { kind: 'incomplete', reason: 'missing-required-execution-event' }
      }
    } else {
      const root = nativeRootByEventSeq.get(execution.request.rootRequestEventSeq)
      const parent = facts.events[execution.request.parentRequestEventSeq]
      const rootData = root?.retention === 'included' ? record(root.data) : undefined
      const parentData = parent?.retention === 'included' ? record(parent.data) : undefined
      if (callData?.rootCallId !== execution.request.rootCallId || callData.parentCallId !== execution.request.parentCallId
        || callData.subCallId !== execution.request.callId || callData.name !== execution.request.toolName
        || rootData?.callId !== execution.request.rootCallId || rootData.name !== 'run_code'
        || parent === undefined || (parent.type === 'tool/call' ? parentData?.callId : parentData?.subCallId) !== execution.request.parentCallId
        || root === undefined || root.seq >= callEvent.seq || parent.seq >= callEvent.seq
        || !actionArgumentsMatchCall(execution.projection.action.arguments, callData.arguments)
        || canonicalJson(execution.request.arguments) !== canonicalJson(callData.arguments)) {
        return { kind: 'incomplete', reason: 'missing-required-execution-event' }
      }
      currentPositionEvent = root
    }
    const currentPositionData = currentPositionEvent.retention === 'included' ? record(currentPositionEvent.data) : undefined
    const allowed = new Set([
      'turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'request/context',
      'user/message', 'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result',
      'tool/code-dispatch-start', 'tool/code-dispatch', 'approval/asked', 'approval/decided', 'approval/policy', 'session/end-seed',
      // Alpha.1 stock Host lifecycle/metadata events are retained for the
      // sequence/hash chain but carry no approval authority.
      'permission/preset', 'sandbox/mode', 'agent/inbox/spliced', 'session/title', 'session/title-llm-request',
    ])
    if (facts.events.some(event => !allowed.has(event.type)) || !approvalPolicyHistoryIsConsistent(facts.events)) {
      { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch events-allowlist'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
    }
    const turn = Number.isSafeInteger(currentPositionData?.turn) && (currentPositionData?.turn as number) >= 0 ? currentPositionData!.turn as number : undefined
    const step = Number.isSafeInteger(currentPositionData?.step) && (currentPositionData?.step as number) >= 0 ? currentPositionData!.step as number : undefined
    if (turn === undefined || step === undefined
      || (facts.approvalBinding.event.turn !== undefined && facts.approvalBinding.event.turn !== turn)
      || (facts.approvalBinding.event.step !== undefined && facts.approvalBinding.event.step !== step)) {
      return { kind: 'incomplete', reason: 'missing-current-turn' }
    }

    const callEvents = facts.events.filter(event => event.type === 'tool/call' || event.type === 'tool/code-dispatch-start')
    if (callEvents.length === 0 || facts.executionFacts.length !== callEvents.length) {
      { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch receipt-dup'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
    }
    const receiptKeys = facts.delegationReceipts.map(receipt => canonicalJson(receipt as unknown as JsonValue))
    if (new Set(receiptKeys).size !== receiptKeys.length) { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch calls-mismatch'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
    const usedReceiptKeys = new Set<string>()
    const assistantCalls: { readonly eventSeq: number; readonly callId: string; readonly toolName: string; readonly rawArguments: unknown; readonly turn: number; readonly step: number }[] = []
    const projected: Array<{
      readonly event: SessionFactEventV1
      readonly candidate: (typeof facts.executionFacts)[number]
      readonly descriptor: (typeof facts.eventProjection.classificationCatalog.descriptors)[number]
      readonly callId: string
      readonly toolName: string
      readonly requestKind: 'model-tool-call' | 'code-dispatch'
      readonly rawArguments: JsonValue
      readonly assistantRootEventSeq: number
      readonly turn: number
      readonly step: number
      readonly outcome: ToolAttemptV1['outcome']
    }> = []
    for (const event of callEvents) {
      const data = event.retention === 'included' ? record(event.data) : undefined
      const requestKind = event.type === 'tool/call' ? 'model-tool-call' as const : 'code-dispatch' as const
      const callId = requestKind === 'model-tool-call' ? data?.callId : data?.subCallId
      const toolName = data?.name
      const candidates = facts.executionFacts.filter(item => item.request.eventSeq === event.seq
        && item.request.callId === callId && item.request.toolName === toolName)
      if (candidates.length !== 1) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
      const candidate = candidates[0]!
      let callTurn: JsonValue | undefined = data?.turn
      let callStep: JsonValue | undefined = data?.step
      let assistantRootEventSeq = event.seq
      if (requestKind === 'code-dispatch') {
        const rootCallId = data?.rootCallId
        const parentCallId = data?.parentCallId
        const rootEvent = candidate.request.kind === 'code-dispatch'
          ? nativeRootByEventSeq.get(candidate.request.rootRequestEventSeq)
          : undefined
        const parentEvent = candidate.request.kind === 'code-dispatch'
          ? facts.events[candidate.request.parentRequestEventSeq]
          : undefined
        const rootData = rootEvent?.retention === 'included' ? record(rootEvent.data) : undefined
        const parentData = parentEvent?.retention === 'included' ? record(parentEvent.data) : undefined
        const observedParentCallId = parentEvent?.type === 'tool/call' ? parentData?.callId : parentData?.subCallId
        if (typeof rootCallId !== 'string' || rootCallId.length === 0 || typeof parentCallId !== 'string' || parentCallId.length === 0
          || rootEvent === undefined || rootEvent.seq >= event.seq || rootData?.name !== 'run_code' || rootData.callId !== rootCallId
          || parentEvent === undefined || parentEvent.seq >= event.seq || observedParentCallId !== parentCallId
          || data?.arguments === undefined || record(data.arguments) === undefined) {
          return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
        }
        callTurn = rootData.turn
        callStep = rootData.step
        assistantRootEventSeq = rootEvent.seq
      }
      if (typeof callId !== 'string' || callId.length === 0
        || typeof toolName !== 'string' || toolName.length === 0
        || (requestKind === 'model-tool-call' && typeof data?.arguments !== 'string')
        || !Number.isSafeInteger(callTurn) || (callTurn as number) < 0 || !Number.isSafeInteger(callStep) || (callStep as number) < 0
        || (callTurn as number) > turn || ((callTurn as number) === turn && (callStep as number) > step)) {
        return { kind: 'incomplete', reason: 'missing-current-turn' }
      }
      const descriptors = facts.eventProjection.classificationCatalog.descriptors.filter(item => item.toolName === toolName)
      if (descriptors.length !== 1) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
      const descriptor = descriptors[0]!
      const requestMatches = requestKind === 'model-tool-call'
        ? candidate.request.kind === 'model-tool-call' && candidate.request.eventType === 'tool/call'
        : candidate.request.kind === 'code-dispatch' && candidate.request.eventType === 'tool/code-dispatch-start'
          && candidate.request.rootCallId === data?.rootCallId && candidate.request.parentCallId === data.parentCallId
          && candidate.request.rootRequestEventSeq === assistantRootEventSeq
          && canonicalJson(candidate.request.arguments) === canonicalJson(data.arguments)
      if (candidate.version !== 1 || !requestMatches
        || validateDurableToolCatalogCommitmentV1(candidate.catalogCommitment).kind !== 'ok'
        || candidate.catalogCommitment.fingerprint !== execution.catalogCommitment.fingerprint
        || !sameLifecycle(candidate.session, facts.session) || candidate.projection.action.toolName !== toolName
        || candidate.projection.projectorId !== candidate.projection.action.projectorId
        || candidate.projection.actionHash !== hashAction(candidate.projection.action)
        || candidate.projection.observedAt !== event.time
        || candidate.toolClassification.classificationCatalogFingerprint !== facts.eventProjection.classificationCatalog.fingerprint
        || canonicalJson(candidate.toolClassification.descriptor) !== canonicalJson(descriptor)
        || !actionArgumentsMatchCall(candidate.projection.action.arguments, data?.arguments)) {
        return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
      }
      const outcome: ToolAttemptV1['outcome'] | undefined = candidate.result === undefined
        ? Object.freeze({ kind: 'pending' as const })
        : (() => {
            const resultEvent = facts.events[candidate.result.eventSeq]
            const expectedResultType = requestKind === 'model-tool-call' ? 'tool/result' : 'tool/code-dispatch'
            if (candidate.result.eventType !== expectedResultType
              || !validTerminalOutcome(candidate.result.outcome)
              || candidate.result.eventSeq <= event.seq || candidate.result.eventSeq >= facts.throughSeq
              || resultEvent?.type !== expectedResultType || resultEvent.retention !== 'excluded-content'
              || resultEvent.exclusion !== 'tool-result-content'
              || (requestKind === 'model-tool-call' && (resultEvent.sourceEventSeqs?.length !== 1 || resultEvent.sourceEventSeqs[0] !== event.seq))) return undefined
            return Object.freeze(candidate.result.outcome)
          })()
      if (outcome === undefined) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
      if (descriptor.classification === 'ordinary' && candidate.delegationReceipt !== undefined) {
        return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
      }
      if (candidate.delegationReceipt !== undefined) {
        const receipt = candidate.delegationReceipt
        const key = canonicalJson(receipt as unknown as JsonValue)
        if (descriptor.classification !== 'delegation' || !receiptKeys.includes(key) || usedReceiptKeys.has(key)
          || !sameLifecycle(receipt.session, facts.session) || receipt.requestEventSeq !== event.seq
          || receipt.callId !== callId || receipt.classificationCatalogFingerprint !== facts.eventProjection.classificationCatalog.fingerprint
          || receipt.projectorId !== descriptor.projectorId || receipt.resultEvent.seq !== candidate.result?.eventSeq
          || receipt.resultEvent.type !== candidate.result?.eventType) {
          return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
        }
        usedReceiptKeys.add(key)
      }
      if (requestKind === 'model-tool-call') {
        assistantCalls.push({ eventSeq: event.seq, callId, toolName, rawArguments: data!.arguments, turn: callTurn as number, step: callStep as number })
      }
      projected.push({
        event, candidate, descriptor, callId, toolName, requestKind,
        rawArguments: data!.arguments as JsonValue, assistantRootEventSeq,
        turn: callTurn as number, step: callStep as number, outcome,
      })
    }
    if (usedReceiptKeys.size !== facts.delegationReceipts.length) { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch unused-receipts'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
    const resultEventSeqs = facts.executionFacts.flatMap(item => item.result === undefined ? [] : [item.result.eventSeq])
    if (new Set(resultEventSeqs).size !== resultEventSeqs.length
      || facts.events.some(event => (event.type === 'tool/result' || event.type === 'tool/code-dispatch') && !resultEventSeqs.includes(event.seq))) {
      { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch result-seqs'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
    }
    const assistantMessages = assistantMessagesForCalls(facts.events, assistantCalls, turn, step)
    if (assistantMessages === undefined || facts.events.some(event => (event.type === 'assistant/chunk' || event.type === 'assistant/message')
      && event.seq >= execution.request.eventSeq)) {
      return { kind: 'incomplete', reason: 'invalid-current-assistant-message' }
    }
    const targetRootEventSeq = execution.request.kind === 'model-tool-call'
      ? execution.request.eventSeq
      : execution.request.rootRequestEventSeq
    const targetAssistantMessage = targetRootEventSeq === undefined ? undefined : assistantMessages.get(targetRootEventSeq)
    if (targetAssistantMessage === undefined
      || facts.events.some(event => event.type === 'request/header' && event.seq >= targetAssistantMessage.issuedIn.seq)) {
      return { kind: 'incomplete', reason: 'invalid-request-header' }
    }
    if (facts.events.some(event => event.type === 'request/context' && event.seq >= targetAssistantMessage.issuedIn.seq)) {
      return { kind: 'incomplete', reason: 'invalid-request-context' }
    }

    const attempts: ToolAttemptV1[] = []
    const historicalAttempts = new Map<number, ToolAttemptV1[]>()
    const delegationEntries: PrincipalDelegationEntryV1[] = []
    let pendingRequest: ToolAttemptV1['request'] | undefined
    for (const item of projected) {
      const binding = assistantMessages.get(item.assistantRootEventSeq)
      if (binding === undefined) return { kind: 'incomplete', reason: 'invalid-current-assistant-message' }
      const request: ToolAttemptV1['request'] = item.requestKind === 'model-tool-call'
        ? Object.freeze({
            kind: 'model-tool-call' as const,
            issuedIn: binding.issuedIn,
            blockIndex: binding.blockIndex,
            callId: item.callId,
            toolName: item.toolName,
            rawArguments: item.rawArguments as string,
            callEvent: Object.freeze({ seq: item.event.seq, type: item.event.type, turn: item.turn, step: item.step }),
          })
        : Object.freeze({
            kind: 'code-dispatch' as const,
            dispatchStart: Object.freeze({ seq: item.event.seq, type: item.event.type, turn: item.turn, step: item.step }),
            rootCallId: (item.candidate.request as Extract<typeof item.candidate.request, { readonly kind: 'code-dispatch' }>).rootCallId,
            parentCallId: (item.candidate.request as Extract<typeof item.candidate.request, { readonly kind: 'code-dispatch' }>).parentCallId,
            callId: item.callId,
            toolName: item.toolName,
            arguments: item.rawArguments,
          })
      const attempt: ToolAttemptV1 = Object.freeze({ request, outcome: item.outcome })
      if (item.event.seq === execution.request.eventSeq) {
        if (item.outcome.kind !== 'pending') {
          { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch current-not-pending'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
        }
        pendingRequest = request
        continue
      }
      if ((item.turn < turn || item.step < step)
        && item.outcome.kind !== 'completed' && item.outcome.kind !== 'tool-error'
        && item.outcome.kind !== 'sandbox-denied') {
        { if (process.env.DSH_APPROVE_FOR_ME_DEBUG) console.error('[approve-for-me dossier] incomplete-branch historical-outcome'); return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' } }
      }
      if (item.descriptor.classification === 'delegation') {
        const projectedDelegation = this.deps.delegationProjector.project({
          principalSessionId: facts.session.sessionId,
          attempt,
          descriptor: item.descriptor,
          ...(item.candidate.delegationReceipt === undefined ? {} : { receipt: item.candidate.delegationReceipt }),
        })
        if (projectedDelegation.kind !== 'delegation') return { kind: 'incomplete', reason: 'invalid-delegation-projection' }
        delegationEntries.push(projectedDelegation.entry)
      } else if (item.turn < turn) {
        historicalAttempts.set(item.turn, [...(historicalAttempts.get(item.turn) ?? []), attempt])
      } else {
        attempts.push(attempt)
      }
    }
    if (pendingRequest === undefined) return { kind: 'incomplete', reason: 'missing-required-execution-event' }
    if (facts.events.some(event => event.type === 'request/header' && event.seq >= execution.request.eventSeq)) {
      return { kind: 'incomplete', reason: 'invalid-request-header' }
    }
    if (facts.events.some(event => event.type === 'request/context' && event.seq >= execution.request.eventSeq)) {
      return { kind: 'incomplete', reason: 'invalid-request-context' }
    }
    const instructions = instructionsFrom(facts)
    if (instructions === undefined || instructions.some(instruction => instruction.event.seq >= execution.request.eventSeq)) {
      return { kind: 'incomplete', reason: 'invalid-instruction-evidence' }
    }
    const toolMessageSeqs = new Set([...assistantMessages.values()].map(binding => binding.issuedIn.seq))
    const interaction = interactionFrom(facts, toolMessageSeqs)
    if (interaction === undefined || interaction.length === 0
      || interaction.some(item => item.directUserMessages.some(message => message.event.seq >= execution.request.eventSeq))) {
      return { kind: 'incomplete', reason: 'missing-direct-user-evidence' }
    }
    const requestHeaders = requestHeadersFrom(facts)
    const requestHeader = requestHeaders === undefined ? undefined : requestHeaders.at(-1)
    if (facts.events.some(event => event.type === 'request/header') && requestHeaders === undefined) {
      return { kind: 'incomplete', reason: 'invalid-request-header' }
    }
    const requestContext = requestContextFrom(facts)
    if (facts.events.some(event => event.type === 'request/context') && requestContext === undefined) {
      return { kind: 'incomplete', reason: 'invalid-request-context' }
    }
    const effectiveTools = requestHeader === undefined
      ? undefined
      : effectiveToolBindingsFromRequestHeaderV1(requestHeader)
    const effectiveRootEvent = execution.request.kind === 'code-dispatch'
      ? nativeRootByEventSeq.get(execution.request.rootRequestEventSeq)
      : undefined
    const effectiveRootToolName = execution.request.kind === 'model-tool-call'
      ? execution.request.toolName
      : effectiveRootEvent?.retention === 'included'
        ? record(effectiveRootEvent.data)?.name
        : undefined
    if (effectiveTools === undefined
      || typeof effectiveRootToolName !== 'string'
      || effectiveRootToolName.length === 0
      || !effectiveTools.some(tool => tool.toolName === effectiveRootToolName)
      || validateDelegationToolCatalog(facts.eventProjection.classificationCatalog, effectiveTools).kind !== 'ok') {
      return { kind: 'incomplete', reason: 'invalid-effective-tool-binding' }
    }
    if (requestHeaders?.some(header => {
      const historicalTools = effectiveToolBindingsFromRequestHeaderV1(header)
      return historicalTools === undefined
        || validateDelegationToolCatalog(facts.eventProjection.classificationCatalog, historicalTools).kind !== 'ok'
    })) {
      return { kind: 'incomplete', reason: 'invalid-historical-effective-tool-binding' }
    }

    if (!pendingTurnIsOpen(facts.events, turn, step)) {
      return { kind: 'incomplete', reason: 'invalid-current-turn-lifecycle' }
    }
    const historicalTools = Object.freeze([...historicalAttempts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([historicalTurn, historical]) => Object.freeze({ turn: historicalTurn, attempts: Object.freeze(historical) })))
    const requestedSandboxPermissions = execution.projection.action.requestedPermissions
      .filter(permission => permission.kind === 'sandbox')
    const requestedSandboxScope = requestedSandboxPermissions.length === 1
      ? requestedSandboxPermissions[0]!.scope
      : undefined
    const requestedSandboxMode = requestedSandboxScope === 'workspace-write' || requestedSandboxScope === 'danger-full-access'
      ? requestedSandboxScope
      : undefined
    const earlierSandboxDenials = Object.freeze(projected
      .filter(item => item.turn === turn
        && item.event.seq < execution.request.eventSeq
        && item.outcome.kind === 'sandbox-denied')
      .map(item => Object.freeze({
        source: Object.freeze({
          event: Object.freeze({ seq: item.candidate.result!.eventSeq, type: item.candidate.result!.eventType }),
          requestEventSeq: item.event.seq,
          callId: item.callId,
        }),
      })))
    const dossier = Object.freeze({
      version: 1 as const,
      kind: 'guardian-dossier' as const,
      freeze: {
        parent: {
          sessionId: facts.session.sessionId,
          sessionFormatVersion: facts.session.sessionFormatVersion,
          createdAt: facts.session.createdAt,
          ...(facts.session.cwd === undefined ? {} : { cwd: facts.session.cwd }),
        },
        throughSeq: facts.throughSeq,
        currentTurn: turn,
        currentStep: step,
        // Bind to the immutable approval/asked event, never the wall-clock time
        // at recompilation, so the same frozen facts have the same dossier hash.
        frozenAt: askedEvent.time,
      },
      environment: Object.freeze({
        approvalSnapshot: snapshot.environment,
        ...requestHeader === undefined ? {} : { requestHeader },
        ...requestContext === undefined ? {} : { requestContext },
      }),
      instructions: Object.freeze({ messages: instructions }),
      interaction: Object.freeze({
        turns: Object.freeze(interaction),
        historicalTools,
        delegations: Object.freeze({
          model: 'principal-extension-v1', principalSessionId: facts.session.sessionId,
          descendantsGrantAuthority: false, childOutputPolicy: 'exclude-direct-origin-v1',
          classificationCatalog: facts.eventProjection.classificationCatalog, entries: Object.freeze(delegationEntries),
        }),
      }),
      currentTurnTools: Object.freeze({
        turn,
        excludedPendingRequest: {
          callId: facts.approvalBinding.callId,
          requestEventSeq: execution.request.eventSeq,
        },
        attempts: Object.freeze(attempts),
      }),
      pendingApproval: Object.freeze({
        request: pendingRequest,
        approvalAsked: facts.approvalBinding.event,
        approvalRequestId: facts.approvalBinding.approvalRequestId,
        callId: execution.request.callId,
        toolName: execution.request.toolName,
        action: execution.projection.action,
        actionHash: execution.projection.actionHash,
        projectorId: execution.projection.projectorId,
        confinement: { kind: 'unconfined-composition' },
        ...(requestedSandboxMode === undefined ? {} : { requestedSandboxMode }),
        earlierSandboxDenials,
      }),
      completeness: Object.freeze({ complete: true, sourceThroughSeq: facts.throughSeq, omissions: [] }),
    })
    // A dossier that advertises missing evidence must never be branded
    // source-verified. Callers may only send a complete dossier to Guardian.
    if ((dossier.completeness as { readonly complete?: unknown }).complete !== true) {
      return { kind: 'incomplete', reason: 'dossier-completeness-not-ready' }
    }
    if (validateToolTrajectorySection(dossier.currentTurnTools).kind !== 'ok') {
      return { kind: 'incomplete', reason: 'invalid-tool-trajectory' }
    }
    const dossierSize = canonicalSize(dossier)
    const sections = Object.freeze([
      ['environment', dossier.environment],
      ['instructions', dossier.instructions],
      ['interaction', dossier.interaction],
      ['currentTurnTools', dossier.currentTurnTools],
      ['pendingApproval', dossier.pendingApproval],
    ].map(([name, value]) => Object.freeze({ name: name as 'environment' | 'instructions' | 'interaction' | 'currentTurnTools' | 'pendingApproval', ...canonicalSize(value as JsonValue) })))
    const metrics = Object.freeze({
      dossierVersion: 1 as const,
      delegationClassificationCatalogFingerprint: facts.eventProjection.classificationCatalog.fingerprint,
      ...dossierSize,
      sections,
      eventCount: facts.events.length,
      includedEventCount: facts.events.filter(event => event.retention === 'included').length,
      excludedEventCount: facts.events.filter(event => event.retention === 'excluded-content').length,
      delegationEntryCount: delegationEntries.length,
      attemptCount: facts.executionFacts.length,
      totalBytes: facts.events.reduce((sum, event) => sum + ('originalBytes' in event ? event.originalBytes ?? 0 : 0), 0),
    })
    if (dossierSize.bytes > this.deps.maxDossierBytes) {
      return { kind: 'incomplete', reason: 'budget-overflow', metrics }
    }
    return {
      kind: 'ready',
      verified: sealSourceVerifiedDossier(dossier as never),
      metrics,
    }
  }
}
