import { canonicalJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type {
  DirectUserMessageV1,
  DossierCompilationResultV1,
  GuardianDossierCompiler,
  GuardianDossierCompilerDependencies,
  InteractionTurnV1,
  InstructionMessageV1,
  ParentSessionFactSnapshotV1,
  SessionFactEventV1,
} from '../domain/dossier.js'
import { sealSourceVerifiedDossier } from '../domain/dossier.js'
import { hashAction } from '../domain/protocol.js'

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

function validPrincipalSession(session: ParentSessionFactSnapshotV1['session']): boolean {
  return typeof session.sessionId === 'string' && session.sessionId.length > 0
    && Number.isSafeInteger(session.sessionFormatVersion) && session.sessionFormatVersion >= 0
    && Number.isSafeInteger(session.createdAt) && session.createdAt >= 0
    && (session.cwd === undefined || (typeof session.cwd === 'string' && session.cwd.length > 0))
    && Number.isSafeInteger(session.effectiveDelegationDepth) && session.effectiveDelegationDepth >= 0
    && (session.parentSessionId === undefined || (typeof session.parentSessionId === 'string' && session.parentSessionId.length > 0))
}

function actionArgumentsMatchCall(actionArguments: JsonValue, rawArguments: unknown): boolean {
  if (typeof rawArguments !== 'string') return false
  try {
    return canonicalJson(JSON.parse(rawArguments) as JsonValue) === canonicalJson(actionArguments)
  } catch {
    return false
  }
}

function directUserMessage(event: SessionFactEventV1, turn: number | undefined): DirectUserMessageV1 | undefined {
  if (event.retention !== 'included' || event.type !== 'user/message' || event.surfaceState !== 'visible') return undefined
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

function requestHeaderFrom(facts: ParentSessionFactSnapshotV1): JsonValue | undefined {
  let latest: JsonValue | undefined
  for (const event of facts.events) {
    if (event.type !== 'request/header') continue
    const snapshot = event.retention === 'included' ? record(event.data) : undefined
    const header = snapshot === undefined ? undefined : record(snapshot.header as JsonValue)
    // DSH persists `request/header` as `{ header: EpochHeader, reason }`; only
    // the contained complete canonical header is material for the dossier.
    if (header === undefined || header.config === undefined
      || (header.tools !== undefined && !Array.isArray(header.tools))
      || (header.system !== undefined && typeof header.system !== 'string')
      || (snapshot?.reason !== 'initial' && snapshot?.reason !== 'resume' && snapshot?.reason !== 'change')) return undefined
    latest = header
  }
  return latest
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

function currentAssistantMessagesMatchCall(
  events: readonly SessionFactEventV1[],
  callId: string,
  toolName: string,
  rawArguments: JsonValue | undefined,
  turn: number,
  step: number,
): boolean {
  const chunks = events.filter(event => event.type === 'assistant/chunk')
  if (chunks.some(event => {
    const data = event.retention === 'included' ? record(event.data) : undefined
    return data?.turn !== turn || data.step !== step
  })) return false
  const messages = events.filter(event => event.type === 'assistant/message')
  if (messages.length === 0) return true
  // `tool/call` is the canonical request record. When its assembled model
  // message is available, retain no duplicate model text: require it to be an
  // exact one-tool-call wrapper around that canonical request instead.
  if (messages.length !== 1) return false
  const data = messages[0]?.retention === 'included' ? record(messages[0].data) : undefined
  const message = data === undefined ? undefined : record(data.message as JsonValue)
  const source = message === undefined ? undefined : record(message.source as JsonValue)
  const content = message?.content
  const block = Array.isArray(content) && content.length === 1 ? record(content[0] as JsonValue) : undefined
  return data?.turn === turn && data.step === step && data.interrupted !== true
    && message?.role === 'assistant' && typeof message.id === 'string' && message.id.length > 0
    && source?.kind === 'model' && block?.type === 'tool-call' && block.id === callId
    && block.name === toolName && block.arguments === rawArguments
}

function pendingTurnIsOpen(events: readonly SessionFactEventV1[], turn: number, step: number): boolean {
  const exactStart = (type: 'turn/start' | 'step/start', expected: Record<string, number>) => {
    const starts = events.filter(event => event.type === type)
    if (starts.length !== 1) return false
    const data = starts[0]?.retention === 'included' ? record(starts[0].data) : undefined
    return data !== undefined && Object.entries(expected).every(([key, value]) => data[key] === value)
  }
  if (!exactStart('turn/start', { turn }) || !exactStart('step/start', { turn, step })) return false
  return !events.some(event => {
    if (event.type !== 'turn/end' && event.type !== 'step/end') return false
    const data = event.retention === 'included' ? record(event.data) : undefined
    return data?.turn === turn && (event.type === 'turn/end' || data.step === step)
  })
}

function interactionFrom(facts: ParentSessionFactSnapshotV1): InteractionTurnV1[] | undefined {
  const byTurn = new Map<number, DirectUserMessageV1[]>()
  let activeTurn: number | undefined
  for (const event of facts.events) {
    if (event.type === 'turn/start') {
      const turn = event.retention === 'included' ? record(event.data)?.turn : undefined
      if (!Number.isSafeInteger(turn) || (turn as number) < 0) return undefined
      activeTurn = turn as number
      continue
    }
    if (event.type !== 'user/message') continue
    const data = event.retention === 'included' ? record(event.data) : undefined
    const source = data === undefined ? undefined : record(data.source as JsonValue)
    if (source?.form === 'instructions') continue
    const message = directUserMessage(event, activeTurn)
    if (message === undefined || message.event.turn === undefined) return undefined
    const messages = byTurn.get(message.event.turn) ?? []
    messages.push(message)
    byTurn.set(message.event.turn, messages)
  }
  return [...byTurn.entries()].sort(([a], [b]) => a - b).map(([turn, directUserMessages]) => Object.freeze({
    turn, directUserMessages: Object.freeze(directUserMessages),
  }))
}

/**
 * Deterministic D1 compiler (current pure subset). It validates the frozen
 * source snapshot's principal/authority/execution-fact requirements and builds
 * a minimal `GuardianDossierV1`. Sections are currently filled conservatively;
 * the full instruction/tool trajectory/delegation projections remain future D1
 * work, but every prepared dossier passes `assertDossierShape()`.
 */
export class DefaultDossierCompiler implements GuardianDossierCompiler {
  constructor(private readonly deps: GuardianDossierCompilerDependencies) {}

  compile(input: {
    readonly facts: ParentSessionFactSnapshotV1
    readonly signal?: AbortSignal
  }): DossierCompilationResultV1 {
    const { facts } = input
    if (input.signal?.aborted) return { kind: 'incomplete', reason: 'aborted' }
    if (!Number.isSafeInteger(this.deps.maxDossierBytes) || this.deps.maxDossierBytes < 1) {
      return { kind: 'incomplete', reason: 'invalid-dossier-budget' }
    }
    if (facts.version !== 1 || facts.eventProjection.policyId !== 'dsh-session-facts-v1'
      || canonicalJson(facts.eventProjection.classificationCatalog) !== canonicalJson(this.deps.delegationProjector.catalog)) {
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
    const executions = facts.executionFacts.filter(item =>
      item.request.callId === facts.approvalBinding.callId
      && item.request.toolName === facts.approvalBinding.toolName)
    if (executions.length !== 1) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    const execution = executions[0]!
    if (!sameLifecycle(execution.session, facts.session)
      || execution.projection.action.toolName !== execution.request.toolName
      || execution.projection.actionHash !== hashAction(execution.projection.action)) {
      return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    }
    const catalogDescriptors = facts.eventProjection.classificationCatalog.descriptors.filter(descriptor =>
      descriptor.toolName === execution.request.toolName)
    if (catalogDescriptors.length !== 1
      || execution.toolClassification.classificationCatalogFingerprint !== facts.eventProjection.classificationCatalog.fingerprint
      || canonicalJson(catalogDescriptors[0]!) !== canonicalJson(execution.toolClassification.descriptor)) {
      return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    }
    const snapshots = facts.approvalSnapshots.filter(item =>
      item.approvalRequestId === facts.approvalBinding.approvalRequestId)
    if (snapshots.length !== 1) return { kind: 'incomplete', reason: 'missing-required-projection' }
    const snapshot = snapshots[0]!
    if (!sameLifecycle(snapshot.session, facts.session) || snapshot.approvalAskedSeq !== facts.throughSeq) {
      return { kind: 'incomplete', reason: 'missing-required-projection' }
    }
    // v1's first complete shape deliberately accepts only a single pending
    // execution. Its raw stream and assembled one-tool-call wrapper are safe
    // transport duplicates; prior tools, instructions, or unknown history wait
    // for dedicated projectors rather than being silently omitted.
    if (facts.events.length !== facts.throughSeq + 1 || facts.events.some((event, index) => event.seq !== index)) {
      return { kind: 'incomplete', reason: 'non-contiguous-event-prefix' }
    }
    if (facts.events.some((event, index) => !Number.isSafeInteger(event.time) || event.time < 0
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
    if (!Number.isSafeInteger(askedEvent.time) || askedEvent.time < 0) {
      return { kind: 'incomplete', reason: 'invalid-frozen-event-time' }
    }
    const callEvent = facts.events[execution.request.eventSeq]
    const callData = callEvent?.retention === 'included' ? record(callEvent.data) : undefined
    if (execution.request.eventType !== 'tool/call' || execution.request.eventSeq >= facts.throughSeq
      || callEvent?.type !== execution.request.eventType
      || callData?.callId !== execution.request.callId
      || callData.name !== execution.request.toolName
      || !actionArgumentsMatchCall(execution.projection.action.arguments, callData.arguments)) {
      return { kind: 'incomplete', reason: 'missing-required-execution-event' }
    }
    const allowed = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'request/context', 'user/message', 'assistant/chunk', 'assistant/message', 'tool/call', 'approval/asked'])
    if (facts.events.some(event => !allowed.has(event.type)) || facts.events.filter(event => event.type === 'tool/call').length !== 1
      || facts.executionFacts.length !== 1 || facts.delegationReceipts.length !== 0) {
      return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' }
    }
    const turn = Number.isSafeInteger(callData?.turn) && (callData?.turn as number) >= 0
      ? callData?.turn as number
      : undefined
    const step = Number.isSafeInteger(callData?.step) && (callData?.step as number) >= 0
      ? callData?.step as number
      : undefined
    if (turn === undefined || step === undefined || facts.approvalBinding.event.turn !== turn
      || facts.approvalBinding.event.step !== step) {
      return { kind: 'incomplete', reason: 'missing-current-turn' }
    }
    if (!currentAssistantMessagesMatchCall(facts.events, execution.request.callId, execution.request.toolName, callData.arguments, turn, step)
      || facts.events.some(event => (event.type === 'assistant/chunk' || event.type === 'assistant/message')
        && event.seq >= execution.request.eventSeq)) {
      return { kind: 'incomplete', reason: 'invalid-current-assistant-message' }
    }
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
    const interaction = interactionFrom(facts)
    if (interaction === undefined || interaction.length === 0
      || interaction.some(item => item.directUserMessages.some(message => message.event.seq >= execution.request.eventSeq))) {
      return { kind: 'incomplete', reason: 'missing-direct-user-evidence' }
    }
    const requestHeader = requestHeaderFrom(facts)
    if (facts.events.some(event => event.type === 'request/header') && requestHeader === undefined) {
      return { kind: 'incomplete', reason: 'invalid-request-header' }
    }
    const requestContext = requestContextFrom(facts)
    if (facts.events.some(event => event.type === 'request/context') && requestContext === undefined) {
      return { kind: 'incomplete', reason: 'invalid-request-context' }
    }

    if (!pendingTurnIsOpen(facts.events, turn, step)) {
      return { kind: 'incomplete', reason: 'invalid-current-turn-lifecycle' }
    }
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
        delegations: Object.freeze({
          model: 'principal-extension-v1', principalSessionId: facts.session.sessionId,
          descendantsGrantAuthority: false, childOutputPolicy: 'exclude-direct-origin-v1',
          classificationCatalog: facts.eventProjection.classificationCatalog, entries: Object.freeze([]),
        }),
      }),
      currentTurnTools: Object.freeze({
        turn,
        excludedPendingRequest: {
          callId: facts.approvalBinding.callId,
          requestEventSeq: execution.request.eventSeq,
        },
        attempts: [],
      }),
      pendingApproval: Object.freeze({
        request: {
          kind: execution.request.kind === 'model-tool-call' ? 'model-tool-call' : 'code-dispatch',
          callId: execution.request.callId,
          toolName: execution.request.toolName,
          rawArguments: canonicalJson(execution.projection.action.arguments),
          eventSeq: execution.request.eventSeq,
        },
        approvalAsked: facts.approvalBinding.event,
        approvalRequestId: facts.approvalBinding.approvalRequestId,
        callId: execution.request.callId,
        toolName: execution.request.toolName,
        action: execution.projection.action,
        actionHash: execution.projection.actionHash,
        projectorId: execution.projection.projectorId,
        confinement: { kind: 'unconfined-composition' },
        earlierSandboxDenials: [],
      }),
      completeness: Object.freeze({ complete: true, sourceThroughSeq: facts.throughSeq, omissions: [] }),
    })
    // A dossier that advertises missing evidence must never be branded
    // source-verified. Callers may only send a complete dossier to Guardian.
    if ((dossier.completeness as { readonly complete?: unknown }).complete !== true) {
      return { kind: 'incomplete', reason: 'dossier-completeness-not-ready' }
    }
    const dossierSize = canonicalSize(dossier)
    if (dossierSize.bytes > this.deps.maxDossierBytes) {
      return { kind: 'incomplete', reason: 'budget-overflow' }
    }
    const sections = Object.freeze([
      ['environment', dossier.environment],
      ['instructions', dossier.instructions],
      ['interaction', dossier.interaction],
      ['currentTurnTools', dossier.currentTurnTools],
      ['pendingApproval', dossier.pendingApproval],
    ].map(([name, value]) => Object.freeze({ name: name as 'environment' | 'instructions' | 'interaction' | 'currentTurnTools' | 'pendingApproval', ...canonicalSize(value as JsonValue) })))
    return {
      kind: 'ready',
      verified: sealSourceVerifiedDossier(dossier as never),
      metrics: {
        dossierVersion: 1,
        delegationClassificationCatalogFingerprint: facts.eventProjection.classificationCatalog.fingerprint,
        ...dossierSize,
        sections,
        eventCount: facts.events.length,
        includedEventCount: facts.events.filter(event => event.retention === 'included').length,
        excludedEventCount: facts.events.filter(event => event.retention === 'excluded-content').length,
        delegationEntryCount: 0,
        attemptCount: facts.executionFacts.length,
        totalBytes: facts.events.reduce((sum, event) => sum + ('originalBytes' in event ? event.originalBytes ?? 0 : 0), 0),
      },
    }
  }
}
