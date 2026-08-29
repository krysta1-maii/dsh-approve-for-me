import { canonicalJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type {
  DirectUserMessageV1,
  DossierCompilationResultV1,
  GuardianDossierCompiler,
  GuardianDossierCompilerDependencies,
  InteractionTurnV1,
  ParentSessionFactSnapshotV1,
  SessionFactEventV1,
} from '../domain/dossier.js'
import { sealSourceVerifiedDossier } from '../domain/dossier.js'

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function directUserMessage(event: SessionFactEventV1): DirectUserMessageV1 | undefined {
  if (event.retention !== 'included' || event.type !== 'user/message') return undefined
  const data = record(event.data)
  const source = data === undefined ? undefined : record(data.source as JsonValue)
  const messageId = data?.id
  const content = data?.content
  const turn = data?.turn
  if (source?.kind !== 'user' || typeof messageId !== 'string' || messageId.length === 0
    || !Array.isArray(content) || !Number.isSafeInteger(turn) || (turn as number) < 0) return undefined
  return Object.freeze({
    event: Object.freeze({ seq: event.seq, type: event.type, turn: turn as number }),
    messageId,
    content: Object.freeze([...content] as JsonValue[]),
    surfaceState: event.surfaceState ?? 'visible',
  })
}

function interactionFrom(facts: ParentSessionFactSnapshotV1): InteractionTurnV1[] | undefined {
  const byTurn = new Map<number, DirectUserMessageV1[]>()
  for (const event of facts.events) {
    if (event.type !== 'user/message') continue
    const message = directUserMessage(event)
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
    if (facts.version !== 1) return { kind: 'incomplete', reason: 'event-projection-policy-mismatch' }
    if (facts.session.effectiveDelegationDepth !== 0 || facts.session.parentSessionId !== undefined) {
      return { kind: 'incomplete', reason: 'unsupported-delegated-requester' }
    }
    if (facts.approvalBinding.callId.length === 0) return { kind: 'incomplete', reason: 'missing-call-id' }
    if (facts.throughSeq !== facts.approvalBinding.event.seq) {
      return { kind: 'incomplete', reason: 'missing-current-request-event' }
    }
    const execution = facts.executionFacts.find(item =>
      item.request.callId === facts.approvalBinding.callId
      && item.request.toolName === facts.approvalBinding.toolName)
    if (execution === undefined) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    const snapshot = facts.approvalSnapshots.find(item =>
      item.approvalRequestId === facts.approvalBinding.approvalRequestId)
    if (snapshot === undefined) return { kind: 'incomplete', reason: 'missing-required-projection' }
    // v1's first complete shape deliberately accepts only a single pending
    // execution. Any prior tool, assistant, instruction, or unknown history
    // waits for its dedicated projector rather than being silently omitted.
    if (facts.events.length !== facts.throughSeq + 1 || facts.events.some((event, index) => event.seq !== index)) {
      return { kind: 'incomplete', reason: 'non-contiguous-event-prefix' }
    }
    const askedEvent = facts.events[facts.throughSeq]
    const askedData = askedEvent?.retention === 'included' ? record(askedEvent.data) : undefined
    if (askedEvent?.type !== 'approval/asked' || askedData?.id !== facts.approvalBinding.approvalRequestId
      || askedData.callId !== facts.approvalBinding.callId || askedData.toolName !== facts.approvalBinding.toolName) {
      return { kind: 'incomplete', reason: 'missing-current-request-event' }
    }
    const callEvent = facts.events[execution.request.eventSeq]
    const callData = callEvent?.retention === 'included' ? record(callEvent.data) : undefined
    if (execution.request.eventSeq >= facts.throughSeq || callEvent?.type !== execution.request.eventType
      || callData?.callId !== execution.request.callId
      || callData.name !== execution.request.toolName) {
      return { kind: 'incomplete', reason: 'missing-required-execution-event' }
    }
    const allowed = new Set(['turn/start', 'turn/end', 'user/message', 'tool/call', 'approval/asked'])
    if (facts.events.some(event => !allowed.has(event.type)) || facts.executionFacts.length !== 1 || facts.delegationReceipts.length !== 0) {
      return { kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' }
    }
    const interaction = interactionFrom(facts)
    if (interaction === undefined || interaction.length === 0) return { kind: 'incomplete', reason: 'missing-direct-user-evidence' }

    const turn = facts.approvalBinding.event.turn ?? 0
    const step = facts.approvalBinding.event.step ?? 0
    const dossier = Object.freeze({
      version: 1 as const,
      kind: 'guardian-dossier' as const,
      freeze: {
        parent: {
          sessionId: facts.session.sessionId,
          sessionFormatVersion: facts.session.sessionFormatVersion,
          createdAt: facts.session.createdAt,
        },
        throughSeq: facts.throughSeq,
        currentTurn: turn,
        currentStep: step,
        // Deterministic placeholder until the source-backed compiler accepts an
        // explicit capture timestamp; using Date.now() here would make the same
        // facts produce different dossier hashes on every compile.
        frozenAt: 0,
      },
      environment: snapshot.environment,
      instructions: Object.freeze({ messages: [] }),
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
          requestEventSeq: facts.approvalBinding.event.seq,
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
      completeness: Object.freeze({ ready: true, sourceThroughSeq: facts.throughSeq, omissions: [] }),
    })
    // A dossier that advertises missing evidence must never be branded
    // source-verified. Callers may only send a complete dossier to Guardian.
    if ((dossier.completeness as { readonly ready?: unknown }).ready !== true) {
      return { kind: 'incomplete', reason: 'dossier-completeness-not-ready' }
    }
    return {
      kind: 'ready',
      verified: sealSourceVerifiedDossier(dossier as never),
      metrics: {
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
