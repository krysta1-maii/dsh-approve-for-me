import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createActionSnapshot, hashAction } from '../domain/protocol.js'
import { canonicalJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type { ApprovalSnapshotRecordV1, DelegationReceiptFactRecordV1, PrincipalDelegationReceiptV1, ToolExecutionFactRecordV1 } from '../domain/dossier.js'
import type { DshAlpha2EffectiveCatalog } from './effective-tool-catalog.js'
import type { ActionCapture, ActionProjector } from '../ports/action-projector.js'
import type { ApprovalSnapshotRepository, ExecutionFactRepository } from '../application/fact-repositories.js'
import { DEFAULT_MAX_SEALED_HISTORY_WINDOW } from '../domain/sealed-facts.js'
import type { ActivityV1, SealV1 } from '../domain/sealed-facts.js'
import { projectSealForResultV1 } from '../application/seal-projection.js'

interface EventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  readonly sourceEventSeqs?: readonly number[]
}

/** Durable ledger dependency; undefined deliberately leaves legacy capture non-authorizing. */
export interface SealedFactsLedger {
  append(seal: SealV1, activity: ActivityV1): Promise<'created' | 'identical' | 'conflict' | 'unavailable'>
  read(lifecycleFingerprint: string): Promise<readonly { readonly seal: SealV1; readonly activity: ActivityV1 }[] | undefined>
}

interface SessionLike {
  readonly id: unknown
  readonly header: { readonly id: unknown; readonly version: unknown; readonly createdAt: unknown; readonly cwd?: unknown }
  readonly snapshotEvents?: () => readonly EventLike[]
  readonly seq?: number
  readonly eventAt?: (seq: number) => EventLike | undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue)
  } catch {
    return false
  }
}

function codeDispatchSignature(event: EventLike): string | undefined {
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined
  const data = event.data as Record<string, unknown>
  const rootCallId = string(data.rootCallId)
  const parentCallId = string(data.parentCallId)
  const callId = string(data.subCallId)
  const toolName = string(data.name)
  if (rootCallId === undefined || parentCallId === undefined || callId === undefined || toolName === undefined) return undefined
  try {
    return canonicalJson({ rootCallId, parentCallId, callId, toolName, arguments: data.arguments } as JsonValue)
  } catch {
    return undefined
  }
}

type SandboxDenialOutcome = Extract<NonNullable<ToolExecutionFactRecordV1['result']>['outcome'], { readonly kind: 'sandbox-denied' }>

function sandboxMode(value: unknown): SandboxDenialOutcome['mode'] | undefined {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access' ? value : undefined
}

function standingSandboxMode(agent: Agent | undefined, throughSeq: number | undefined): SandboxDenialOutcome['mode'] | undefined {
  const session = agent?.session as unknown as SessionLike | undefined
  if (typeof session?.snapshotEvents !== 'function') return undefined
  const events = session.snapshotEvents()
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'sandbox/mode' || throughSeq === undefined || event.seq > throughSeq
      || event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) continue
    const mode = sandboxMode((event.data as Record<string, unknown>).mode)
    if (mode !== undefined) return mode
  }
  return undefined
}

/** Consume only canonical execution-local sandbox facts; model-visible text is never evidence. */
function sandboxDenialOutcome(
  toolName: string,
  value: unknown,
  error: unknown,
  agent: Agent | undefined,
  requestEventSeq: number | undefined,
): SandboxDenialOutcome | undefined {
  if (toolName === 'bash' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sandbox = (value as Record<string, unknown>).sandbox
    if (sandbox !== null && typeof sandbox === 'object' && !Array.isArray(sandbox)) {
      const facts = sandbox as Record<string, unknown>
      const mode = sandboxMode(facts.mode)
      const enforcement = facts.enforcement === 'full' || facts.enforcement === 'partial' ? facts.enforcement : undefined
      if (facts.denied === true && mode !== undefined) {
        return Object.freeze({ kind: 'sandbox-denied' as const, mode, ...(enforcement === undefined ? {} : { enforcement }) })
      }
    }
  }
  if (['read', 'read_image', 'write', 'edit', 'glob', 'grep'].includes(toolName)
    && error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const info = (error as { readonly info?: unknown }).info
    if (info !== null && typeof info === 'object' && !Array.isArray(info)
      && (info as Record<string, unknown>).code === 'FS_SANDBOX_DENIED') {
      const mode = standingSandboxMode(agent, requestEventSeq)
      if (mode !== undefined) return Object.freeze({ kind: 'sandbox-denied' as const, mode })
    }
  }
  return undefined
}

interface TerminalEvidence {
  readonly isError: boolean
  readonly outcome: NonNullable<ToolExecutionFactRecordV1['result']>['outcome']
  readonly receipt?: PrincipalDelegationReceiptV1
}

function delegationReceipt(
  toolName: string,
  parentSessionId: string,
  result: Readonly<ToolExecutionResult>,
): PrincipalDelegationReceiptV1 | undefined {
  if (result.isError || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) return undefined
  const value = result.value as Record<string, unknown>
  if (toolName === 'subagent' || toolName === 'subagent_fork') {
    if (value.kind === 'continuable' && string(value.subagentId) !== undefined) {
      return Object.freeze({ kind: 'continuable-child-started', childSessionId: value.subagentId as string, directParentSessionId: parentSessionId })
    }
    if (value.kind === 'foreground' && string(value.runId) !== undefined) {
      return Object.freeze({ kind: 'foreground-run-settled', runId: value.runId as string })
    }
    if (value.kind === 'background' && string(value.jobId) !== undefined) {
      return Object.freeze({ kind: 'background-job-started', jobId: value.jobId as string })
    }
  }
  if (toolName === 'send_message' && string(value.messageId) !== undefined) {
    return Object.freeze({ kind: 'followup-delivered', messageId: value.messageId as string })
  }
  if (toolName === 'interrupt_agent' && value.accepted === true) {
    return Object.freeze({ kind: 'interrupt-accepted' })
  }
  return undefined
}

/**
 * Creates immutable execution projections only after their source call has
 * appeared in canonical Session history. Projection failures never block the
 * tool itself; a missing projection is later an authorization failure.
 */
export class DshExecutionFactProjectionBridge {
  private readonly approvalWrites = new Map<string, Promise<void>>()
  private readonly resultWrites = new Map<string, Promise<void>>()
  private readonly terminalOutcomes = new Map<string, TerminalEvidence>()
  private readonly cancelledResults = new Set<string>()
  /** Exact live source identity; call IDs may be reused in later alpha.1 steps. */
  private readonly requestEventByToken = new Map<ToolExecution['token'], number>()
  /** Volatile approval/asked index: lifecycle prefix + requestId → exact asked event, or null when the id is ambiguous (duplicate asked). */
  private readonly approvalAskedIndex = new Map<string, { readonly seq: number; readonly callId: string; readonly toolName: string } | null>()

  constructor(
    private readonly projector: ActionProjector<ToolExecution>,
    private readonly catalogSource: (exec: ToolExecution) => DshAlpha2EffectiveCatalog | undefined,
    private readonly repository: ExecutionFactRepository,
    private readonly approvals?: ApprovalSnapshotRepository,
    /** Reuse the exact volatile projection when capture and fact bridging share one. */
    private readonly captures?: ActionCapture<Agent, string>,
    private readonly ledger?: SealedFactsLedger,
    /** Bounded leading-tail window for approval hot-path fact resolution (default shared with the ledger gate; WP6-b4). */
    private readonly maxSealedTailEvents = DEFAULT_MAX_SEALED_HISTORY_WINDOW,
  ) {}

  async preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    await this.project(exec)
    return next()
  }

  /**
   * Persist a content-free terminal candidate before DSH can append the result
   * event. The event remains the sole settlement authority; this candidate only
   * preserves structured delegation receipts across process death/HMR.
   */
  async postExecute(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    const decision = await next()
    const terminal = this.terminalAfterPost(exec, result, decision)
    if (terminal !== undefined) await this.stageTerminal(exec, terminal)
    return decision
  }

  async project(exec: ToolExecution): Promise<void> {
    const dbg = (stage: string, detail?: unknown): void => {
      if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') console.error('[approve-for-me project]', stage, detail === undefined ? '' : JSON.stringify(detail))
    }
    if (exec.signal?.aborted === true || exec.agent === undefined) return dbg('no-agent-or-aborted')
    const agent = exec.agent
    const session = agent.session as unknown as SessionLike
    const agentId = string((agent as unknown as { id?: unknown }).id)
    const sessionId = string(session.id)
    const headerId = string(session.header?.id)
    const version = session.header?.version
    const createdAt = session.header?.createdAt
    const cwd = session.header?.cwd === undefined ? undefined : string(session.header.cwd)
    if (agentId === undefined || agentId !== sessionId || sessionId !== headerId
      || !Number.isSafeInteger(version) || (version as number) < 0
      || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0
      || (session.header?.cwd !== undefined && cwd === undefined)
      || typeof session.snapshotEvents !== 'function') return dbg('identity')

    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return

    const callId = String(exec.callId)
    const effective = this.catalogSource(exec)
    if (effective === undefined) return dbg('no-catalog', { name: exec.name, callId: String(exec.callId) })
    const event = events.find(candidate => candidate.seq === effective.execution.requestEventSeq)
    if (event === undefined || event.seq !== effective.execution.requestEventSeq
      || event.type !== effective.execution.requestEventType) return dbg('event-binding')
    const eventData = event.data as Record<string, unknown>
    const rootCallId = event.type === 'tool/code-dispatch-start' ? string(eventData.rootCallId) : undefined
    const parentCallId = event.type === 'tool/code-dispatch-start' ? string(eventData.parentCallId) : undefined
    if ((event.type === 'tool/call' && (eventData.callId !== callId || eventData.name !== exec.name))
      || (event.type === 'tool/code-dispatch-start'
        && (eventData.subCallId !== callId || eventData.name !== exec.name
          || rootCallId === undefined || rootCallId !== String(exec.rootCallId)
          || parentCallId === undefined || !sameJson(eventData.arguments, exec.arguments)))) return
    const catalog = effective.dossier
    const descriptor = catalog.descriptors.find(item => item.toolName === exec.name)
    if (descriptor === undefined) return dbg('no-descriptor', { name: exec.name })
    // When installed beside a capture bridge, only its frozen action is
    // authoritative. Re-projecting on a miss can create a different semantic
    // snapshot from mutable execution state after the approval ask began.
    let action = this.captures?.lookup(agent, callId, exec.name)
    if (this.captures !== undefined && action === undefined) return dbg('capture-miss', { callId, name: exec.name })
    if (action === undefined) {
      try {
        action = createActionSnapshot(this.projector.project(exec))
      } catch (error: unknown) {
        dbg('projector-throw', String(error))
        return
      }
    }
    const record: ToolExecutionFactRecordV1 = Object.freeze({
      version: 1,
      session: Object.freeze({
        sessionId,
        sessionFormatVersion: version as number,
        createdAt: createdAt as number,
        ...(cwd === undefined ? {} : { cwd }),
      }),
      request: event.type === 'tool/call'
        ? Object.freeze({
            kind: 'model-tool-call' as const,
            eventSeq: event.seq,
            eventType: 'tool/call' as const,
            callId,
            toolName: exec.name,
          })
        : Object.freeze({
            kind: 'code-dispatch' as const,
            eventSeq: event.seq,
            eventType: 'tool/code-dispatch-start' as const,
            rootCallId: rootCallId!,
            rootRequestEventSeq: effective.execution.rootRequestEventSeq,
            parentCallId: parentCallId!,
            parentRequestEventSeq: effective.execution.parentRequestEventSeq,
            callId,
            toolName: exec.name,
            arguments: eventData.arguments as JsonValue,
          }),
      catalogCommitment: effective.commitment,
      toolClassification: Object.freeze({
        classificationCatalogFingerprint: catalog.fingerprint,
        descriptor,
      }),
      projection: Object.freeze({
        projectorId: action.projectorId,
        action,
        actionHash: hashAction(action),
        observedAt: event.time,
      }),
    })
    const created = await this.repository.create(record)
    dbg('record-create', { outcome: created, callId, eventSeq: event.seq })
    this.requestEventByToken.set(exec.token, event.seq)
  }

  private terminalAfterPost(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    decision: PostToolDecision,
  ): TerminalEvidence | undefined {
    if (decision.kind === 'block'
      || (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value'))
      || (result.isError && Object.hasOwn(decision, 'value'))) {
      return Object.freeze({ isError: true, outcome: Object.freeze({ kind: 'tool-error' as const }) })
    }
    const value = Object.hasOwn(decision, 'value') ? decision.value : result.value
    const sandboxDenial = sandboxDenialOutcome(exec.name, value, result.isError ? result.error : undefined, exec.agent, this.requestEventByToken.get(exec.token))
    if (sandboxDenial !== undefined) return Object.freeze({ isError: result.isError, outcome: sandboxDenial })
    if (result.isError) return Object.freeze({ isError: true, outcome: Object.freeze({ kind: 'tool-error' as const }) })
    const receipt = delegationReceipt(exec.name, String(exec.agent?.session.id ?? ''), {
      ...result,
      isError: false,
      value,
    } as ToolExecutionResult)
    return Object.freeze({
      isError: false,
      outcome: Object.freeze({ kind: 'completed' as const }),
      ...receipt === undefined ? {} : { receipt },
    })
  }

  private async stageTerminal(exec: ToolExecution, terminalEvidence: TerminalEvidence): Promise<void> {
    if (exec.agent === undefined) return
    const lifecycle = this.lifecycle(exec.agent)
    const requestEventSeq = this.requestEventByToken.get(exec.token)
    if (lifecycle === undefined || requestEventSeq === undefined) return
    try {
      await this.repository.stageTerminal({
        session: lifecycle,
        callId: String(exec.callId),
        requestEventSeq,
        terminalEvidence,
      })
    } catch {
      // A missing durable candidate is non-authorizing; never alter tool output.
    }
  }

  /** Records the final content-free terminal marker before DSH appends its durable result event. */
  observeResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined {
    if (exec.agent === undefined) return undefined
    const outcome = sandboxDenialOutcome(exec.name, result.value, result.isError ? result.error : undefined, exec.agent, this.requestEventByToken.get(exec.token)) ?? (result.isError
      ? Object.freeze({ kind: 'tool-error' as const })
      : Object.freeze({ kind: 'completed' as const }))
    const lifecycle = this.lifecycle(exec.agent)
    const session = exec.agent.session as unknown as SessionLike
    const callId = String(exec.callId)
    if (lifecycle === undefined) return undefined
    const requestEventSeq = this.requestEventByToken.get(exec.token)
    this.requestEventByToken.delete(exec.token)
    if (requestEventSeq !== undefined && exec.signal?.aborted === true) this.cancelledResults.add(this.resultKey(lifecycle, callId, requestEventSeq))
    if (requestEventSeq === undefined || typeof session.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return undefined
    const source = events.find(candidate => candidate.seq === requestEventSeq)
    if (source === undefined || source.seq !== requestEventSeq) return undefined
    const sourceData = source.data as Record<string, unknown>
    const sourceMatches = (source.type === 'tool/call' && sourceData.callId === callId && sourceData.name === exec.name)
      || (source.type === 'tool/code-dispatch-start' && sourceData.subCallId === callId
        && sourceData.name === exec.name && sourceData.rootCallId === String(exec.rootCallId))
    if (!sourceMatches) return undefined
    const receipt = delegationReceipt(exec.name, lifecycle.sessionId, result)
    this.terminalOutcomes.set(this.resultKey(lifecycle, callId, requestEventSeq), Object.freeze({
      isError: result.isError,
      outcome,
      ...receipt === undefined ? {} : { receipt },
    }))
    return undefined
  }

  /** Records the bounded approval audit after DSH has committed it to history. */
  observeSessionEvent(agent: Agent, event: EventLike): Promise<void> {
    if (event.type === 'tool/result' || event.type === 'tool/code-dispatch') {
      const lifecycle = this.lifecycle(agent)
      if (lifecycle === undefined) return Promise.resolve()
      const key = `${canonicalJson(lifecycle)}\0${event.seq}`
      const existing = this.resultWrites.get(key)
      if (existing !== undefined) return existing
      const attempt = event.type === 'tool/result'
        ? this.attachResult(agent, event)
        : this.attachCodeDispatchResult(agent, event)
      let write: Promise<void>
      write = attempt.then(() => undefined).finally(() => {
        if (this.resultWrites.get(key) === write) this.resultWrites.delete(key)
      })
      this.resultWrites.set(key, write)
      return write
    }
    if (this.approvals === undefined || event.type !== 'approval/asked') return Promise.resolve()
    const data = event.data as Record<string, unknown>
    const requestId = string(data.id)
    const callId = string(data.callId)
    const toolName = string(data.toolName)
    const lifecycle = this.lifecycle(agent)
    if (requestId === undefined || callId === undefined || toolName === undefined || lifecycle === undefined) return Promise.resolve()
    // Populate the volatile asked-index so a later resolve hits in O(1), but keep
    // the plan's "ask is a unique preceding call" invariant. A duplicate
    // approval/asked for the same request id at a different seq is ambiguous, so
    // poison the key (null) and make any resolve for this id fail closed. A
    // same-seq re-observation is idempotent and keeps the existing entry.
    {
      const indexKey = `${canonicalJson(lifecycle)}\0${requestId}`
      const indexed = this.approvalAskedIndex.get(indexKey)
      if (indexed !== undefined && indexed !== null && indexed.seq !== event.seq) {
        this.approvalAskedIndex.set(indexKey, null)
      } else if (indexed === undefined) {
        this.approvalAskedIndex.set(indexKey, { seq: event.seq, callId, toolName })
      }
    }
    const key = `${canonicalJson(lifecycle)}\0${event.seq}`
    const existing = this.approvalWrites.get(key)
    if (existing !== undefined) return existing
    const attempt = this.writeApprovalSnapshot(agent, lifecycle, event.seq, requestId, callId, toolName)
    let write: Promise<void>
    write = attempt.then(() => undefined).finally(() => {
      if (this.approvalWrites.get(key) === write) this.approvalWrites.delete(key)
      // Deliberately NOT deleting the resolved asked-index entry here, even though
      // resultWrites self-deletes after settle. A duplicate approval/asked for the
      // same request id must always land on the existing entry so the
      // same-seq-idempotent / different-seq-poison decision is deterministic.
      // Cleaning a resolved key reintroduced a race: seq1 observed + settled deleted
      // the key, then a duplicate seq2 arrived as a fresh entry, and a resolve
      // racing before seq2's own write settled resolved to seq2 instead of failing
      // closed. The index therefore lives for the bridge instance (a few hundred
      // bytes per request id) and dies with the session.
    })
    this.approvalWrites.set(key, write)
    return write
  }

  /** Attaches only an unambiguous canonical native result correlation. */
  private async attachResult(agent: Agent, event: EventLike): Promise<boolean> {
    const lifecycle = this.lifecycle(agent)
    const data = event.data as Record<string, unknown>
    const message = data.message as { readonly source?: { readonly kind?: unknown; readonly callId?: unknown }; readonly content?: unknown } | undefined
    const blocks = message?.content
    const turn = data.turn
    const step = data.step
    if (lifecycle === undefined || !Array.isArray(blocks) || blocks.length !== 1
      || !Number.isSafeInteger(turn) || (turn as number) < 0
      || !Number.isSafeInteger(step) || (step as number) < 0) return false
    const block = blocks[0] as { readonly type?: unknown; readonly toolCallId?: unknown; readonly isError?: unknown } | undefined
    const callId = block?.type === 'tool-result' ? string(block.toolCallId) : undefined
    const isError = block?.isError
    if (callId === undefined || typeof isError !== 'boolean' || message?.source?.kind !== 'tool' || message.source.callId !== callId
      || event.sourceEventSeqs?.length !== 1 || !Number.isSafeInteger(event.sourceEventSeqs[0])) return false
    const requestEventSeq = event.sourceEventSeqs[0]!
    const resultKey = this.resultKey(lifecycle, callId, requestEventSeq)
    const volatileTerminal = this.terminalOutcomes.get(resultKey)
    const session = agent.session as unknown as SessionLike
    if (typeof session.eventAt !== 'function') return false
    const candidate = await this.repository.get({ session: lifecycle, callId, requestEventSeq })
    const call = session.eventAt(requestEventSeq)
    const callData = call?.data as Record<string, unknown> | undefined
    if (candidate?.request.kind !== 'model-tool-call' || candidate.request.callId !== callId
      || candidate.request.eventSeq !== requestEventSeq || candidate.request.eventSeq >= event.seq
      || call?.type !== 'tool/call' || callData?.callId !== callId || callData?.name !== candidate.request.toolName
      || callData.turn !== turn || callData.step !== step) return false
    const eventOutcome = Object.freeze(isError
      ? { kind: 'tool-error' as const }
      : { kind: 'completed' as const })
    const compatible = (terminal: TerminalEvidence): boolean => terminal.isError === isError
      && (terminal.outcome.kind === 'sandbox-denied' || isError === (terminal.outcome.kind === 'tool-error'))
    const terminal = volatileTerminal !== undefined
      ? (compatible(volatileTerminal) ? volatileTerminal : undefined)
      : (candidate.terminalEvidence !== undefined && compatible(candidate.terminalEvidence)
        ? candidate.terminalEvidence
        : undefined)
    const receipt = terminal === undefined ? undefined : this.receiptRecord(candidate, terminal, event)
    const outcome = await this.repository.attachResult({
      session: lifecycle, callId, requestEventSeq,
      result: { eventSeq: event.seq, eventType: 'tool/result', outcome: terminal?.outcome ?? eventOutcome },
      ...receipt === undefined ? {} : { delegationReceipt: receipt },
    })
    if (outcome === 'updated' || outcome === 'identical') {
      this.terminalOutcomes.delete(resultKey)
      await this.appendSealForResult(agent, event, callId, requestEventSeq)
    }
    return outcome === 'updated' || outcome === 'identical'
  }

  /** Attaches a bounded terminal outcome for one nested code dispatch. */
  private async attachCodeDispatchResult(agent: Agent, event: EventLike): Promise<boolean> {
    const lifecycle = this.lifecycle(agent)
    const data = event.data as Record<string, unknown>
    const rootCallId = string(data.rootCallId)
    const parentCallId = string(data.parentCallId)
    const callId = string(data.subCallId)
    const toolName = string(data.name)
    const isError = data.isError
    if (lifecycle === undefined || rootCallId === undefined || parentCallId === undefined
      || callId === undefined || toolName === undefined || typeof isError !== 'boolean') return false
    const session = agent.session as unknown as SessionLike
    if (typeof session.snapshotEvents !== 'function') return false
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return false
    const sameDispatch = (candidate: EventLike): boolean => {
      const item = candidate.data as Record<string, unknown>
      return item.rootCallId === rootCallId && item.parentCallId === parentCallId
        && item.subCallId === callId && item.name === toolName
        && sameJson(item.arguments, data.arguments)
    }
    const starts = events
      .filter(candidate => candidate.type === 'tool/code-dispatch-start' && candidate.seq < event.seq && sameDispatch(candidate))
      .sort((left, right) => left.seq - right.seq)
    const explicitSourceSeqs = event.sourceEventSeqs?.filter(seq => Number.isSafeInteger(seq))
    let start: EventLike | undefined
    if (explicitSourceSeqs !== undefined && explicitSourceSeqs.length > 0) {
      const sourced = starts.filter(candidate => explicitSourceSeqs.includes(candidate.seq))
      if (sourced.length !== 1) return false
      start = sourced[0]
    } else {
      // Without an exact source edge, accept only the sole matching start since
      // the preceding matching terminal. Two pending identical starts are
      // ambiguous when an earlier terminal event may be missing after a crash.
      const precedingResultSeq = events
        .filter(candidate => candidate.type === 'tool/code-dispatch' && candidate.seq < event.seq && sameDispatch(candidate))
        .reduce((latest, candidate) => Math.max(latest, candidate.seq), -1)
      const pending = starts.filter(candidate => candidate.seq > precedingResultSeq)
      if (pending.length !== 1) return false
      start = pending[0]
    }
    if (start === undefined) return false
    const candidate = await this.repository.get({ session: lifecycle, callId, requestEventSeq: start.seq })
    if (candidate?.request.kind !== 'code-dispatch' || candidate.request.toolName !== toolName) return false
    const resultKey = this.resultKey(lifecycle, callId, start.seq)
    const volatileTerminal = this.terminalOutcomes.get(resultKey)
    const compatible = (terminal: TerminalEvidence): boolean => terminal.isError === isError
      && (terminal.outcome.kind === 'sandbox-denied' || isError === (terminal.outcome.kind === 'tool-error'))
    const terminal = volatileTerminal !== undefined
      ? (compatible(volatileTerminal) ? volatileTerminal : undefined)
      : (candidate.terminalEvidence !== undefined && compatible(candidate.terminalEvidence)
        ? candidate.terminalEvidence
        : undefined)
    const eventOutcome = Object.freeze(isError
      ? { kind: 'tool-error' as const }
      : { kind: 'completed' as const })
    const receipt = terminal === undefined ? undefined : this.receiptRecord(candidate, terminal, event)
    const outcome = await this.repository.attachResult({
      session: lifecycle,
      callId,
      requestEventSeq: start.seq,
      result: { eventSeq: event.seq, eventType: 'tool/code-dispatch', outcome: terminal?.outcome ?? eventOutcome },
      ...receipt === undefined ? {} : { delegationReceipt: receipt },
    })
    if (outcome === 'updated' || outcome === 'identical') {
      this.terminalOutcomes.delete(resultKey)
      await this.appendSealForResult(agent, event, callId, start.seq)
    }
    return outcome === 'updated' || outcome === 'identical'
  }

  /** Attaches one already-correlated code result without rescanning Session history. */
  private async attachKnownCodeDispatchResult(
    agent: Agent,
    event: EventLike,
    start: EventLike,
    known: ToolExecutionFactRecordV1,
  ): Promise<boolean> {
    const lifecycle = this.lifecycle(agent)
    const data = event.data as Record<string, unknown>
    const isError = data.isError
    if (lifecycle === undefined || typeof isError !== 'boolean' || start.type !== 'tool/code-dispatch-start'
      || codeDispatchSignature(start) === undefined || codeDispatchSignature(start) !== codeDispatchSignature(event)
      || !sameJson(known.session, lifecycle) || known.request.kind !== 'code-dispatch'
      || known.request.eventSeq !== start.seq || known.request.eventType !== start.type
      || known.request.callId !== data.subCallId || known.request.toolName !== data.name
      || known.request.rootCallId !== data.rootCallId || known.request.parentCallId !== data.parentCallId) return false
    const candidate = await this.repository.get({
      session: lifecycle,
      callId: known.request.callId,
      requestEventSeq: known.request.eventSeq,
    })
    if (candidate?.request.kind !== 'code-dispatch' || candidate.request.eventSeq !== start.seq
      || candidate.request.callId !== known.request.callId || candidate.request.toolName !== known.request.toolName) return false
    const resultKey = this.resultKey(lifecycle, candidate.request.callId, candidate.request.eventSeq)
    const volatileTerminal = this.terminalOutcomes.get(resultKey)
    const compatible = (terminal: TerminalEvidence): boolean => terminal.isError === isError
      && (terminal.outcome.kind === 'sandbox-denied' || isError === (terminal.outcome.kind === 'tool-error'))
    const terminal = volatileTerminal !== undefined
      ? (compatible(volatileTerminal) ? volatileTerminal : undefined)
      : (candidate.terminalEvidence !== undefined && compatible(candidate.terminalEvidence)
        ? candidate.terminalEvidence
        : undefined)
    const eventOutcome = Object.freeze(isError
      ? { kind: 'tool-error' as const }
      : { kind: 'completed' as const })
    const receipt = terminal === undefined ? undefined : this.receiptRecord(candidate, terminal, event)
    const outcome = await this.repository.attachResult({
      session: lifecycle,
      callId: candidate.request.callId,
      requestEventSeq: candidate.request.eventSeq,
      result: { eventSeq: event.seq, eventType: 'tool/code-dispatch', outcome: terminal?.outcome ?? eventOutcome },
      ...receipt === undefined ? {} : { delegationReceipt: receipt },
    })
    if (outcome === 'updated' || outcome === 'identical') {
      this.terminalOutcomes.delete(resultKey)
      await this.appendSealForResult(agent, event, candidate.request.callId, candidate.request.eventSeq)
    }
    return outcome === 'updated' || outcome === 'identical'
  }

  /** Seal only an exact approval-bound result; all failures remain non-blocking. */
  private async appendSealForResult(agent: Agent, event: EventLike, callId: string, requestEventSeq: number): Promise<void> {
    if (this.ledger === undefined || this.approvals === undefined) return
    try {
      const lifecycle = this.lifecycle(agent)
      if (lifecycle === undefined) return
      if (this.cancelledResults.has(this.resultKey(lifecycle, callId, requestEventSeq))) return
      const record = await this.repository.get({ session: lifecycle, callId, requestEventSeq })
      if (record === undefined || record.result === undefined || record.result.eventSeq !== event.seq
        || record.request.callId !== callId || record.request.eventSeq !== requestEventSeq) return
      // WP8-c: the seal/activity construction formula lives in one shared pure
      // function (application/seal-projection.ts) so the background backfill
      // cannot drift from this live path. An approval snapshot is the only
      // binding authority: no ask, ambiguity, or capture/catalog mismatch can
      // be promoted into the execution ledger (the projection returns undefined
      // unless exactly one snapshot matches).
      const approvals = await this.approvals.list(lifecycle)
      const lifecycleFingerprint = canonicalJson(lifecycle)
      const previous = await this.ledger.read(lifecycleFingerprint)
      if (previous === undefined) {
        console.error('[approve-for-me ledger] seal-chain-unavailable')
        return
      }
      const projection = projectSealForResultV1({
        lifecycleFingerprint,
        record,
        approvals,
        prior: previous.at(-1)?.seal,
        occurredAt: event.time,
      })
      if (projection === undefined) return
      const appended = await this.ledger.append(projection.seal, projection.activity)
      if (appended === 'conflict' || appended === 'unavailable') console.error('[approve-for-me ledger] seal-append-failed')
    } catch {
      console.error('[approve-for-me ledger] seal-projection-failed')
    }
  }

  private receiptRecord(
    record: ToolExecutionFactRecordV1,
    terminal: TerminalEvidence,
    resultEvent: EventLike,
  ): DelegationReceiptFactRecordV1 | undefined {
    const descriptor = record.toolClassification.descriptor
    if (descriptor.classification !== 'delegation' || terminal.receipt === undefined) return undefined
    return Object.freeze({
      session: record.session,
      requestEventSeq: record.request.eventSeq,
      resultEvent: Object.freeze({ seq: resultEvent.seq, time: resultEvent.time, type: resultEvent.type }),
      callId: record.request.callId,
      classificationCatalogFingerprint: record.toolClassification.classificationCatalogFingerprint,
      projectorId: descriptor.projectorId,
      receipt: terminal.receipt,
    })
  }

  private resultKey(lifecycle: { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd?: string }, callId: string, requestEventSeq: number): string {
    return `${canonicalJson(lifecycle)}\0${callId}\0${requestEventSeq}`
  }

  /**
   * Closes only the exact observer-policy race for this approval event. Bounded
   * cold repair runs later from one validated fact snapshot; replaying every
   * prior result here made the first post-restart approval quadratic.
   */
  async awaitApprovalSnapshot(
    agent: Agent,
    requestId: string,
    callId: string,
    toolName: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    if (signal?.aborted) return
    const lifecycle = this.lifecycle(agent)
    if (lifecycle === undefined) return
    const prefix = `${canonicalJson(lifecycle)}\0`
    const pendingResults = [...this.resultWrites.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, write]) => write)
    if (!await this.settleUnlessAborted(Promise.all(pendingResults), signal) || signal?.aborted) return
    const session = agent.session as unknown as SessionLike
    const askedSeq = this.resolveApprovalAskedSeq(session, lifecycle, requestId, callId, toolName)
    if (askedSeq === undefined || signal?.aborted) return
    const event = session.eventAt?.(askedSeq)
    if (event === undefined || event.type !== 'approval/asked') return
    // Defend against an inconsistent eventAt: the resolved seq must re-read as the
    // exact ask for this request, not merely any approval/asked event.
    const eventData = event.data as Record<string, unknown>
    if (eventData.id !== requestId || eventData.callId !== callId || eventData.toolName !== toolName) return
    if (!await this.settleUnlessAborted(this.observeSessionEvent(agent, event), signal) || signal?.aborted) return
    return askedSeq
  }

  /**
   * Locates the unique approval/asked event for this request using only exact
   * eventAt reads: a volatile index hit is O(1), and a cold-start miss performs a
   * bounded tail-anchored back-scan (window = maxSealedTailEvents). It never
   * materializes the full session log, and returns undefined (fail closed) on
   * zero or ambiguous matches.
   */
  private resolveApprovalAskedSeq(
    session: SessionLike,
    lifecycle: { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd?: string },
    requestId: string,
    callId: string,
    toolName: string,
  ): number | undefined {
    const indexKey = `${canonicalJson(lifecycle)}\0${requestId}`
    const indexed = this.approvalAskedIndex.get(indexKey)
    if (indexed !== undefined) {
      // A poisoned (duplicate asked) or call/tool-mismatched entry is ambiguous:
      // fail closed rather than resolving to one of the competing asks.
      if (indexed === null) return undefined
      if (indexed.callId === callId && indexed.toolName === toolName) return indexed.seq
      return undefined
    }
    if (typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return undefined
    const tail = session.seq
    if (!Number.isSafeInteger(tail) || tail < 0) return undefined
    const lower = Math.max(0, tail - this.maxSealedTailEvents)
    let match: number | undefined
    for (let seq = tail - 1; seq >= lower; seq -= 1) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type !== 'approval/asked') continue
      const data = event.data as Record<string, unknown>
      if (data.id !== requestId || data.callId !== callId || data.toolName !== toolName) continue
      // Duplicate asked events for one request are ambiguous: fail closed.
      if (match !== undefined) return undefined
      match = seq
    }
    if (match !== undefined) this.approvalAskedIndex.set(indexKey, { seq: match, callId, toolName })
    return match
  }

  /**
   * Cold-repairs only execution rows already known to be missing a canonical
   * result. The caller supplies one validated repository snapshot, preventing
   * result-by-result full-table reads while preserving crash-tail recovery.
   */
  async repairHistoricalResults(
    agent: Agent,
    records: readonly ToolExecutionFactRecordV1[],
    throughSeq: number,
    signal?: AbortSignal,
    excludeRequestEventSeq?: number,
  ): Promise<number> {
    if (signal?.aborted || !Number.isSafeInteger(throughSeq) || throughSeq < 0) return 0
    const session = agent.session as unknown as SessionLike
    if (typeof session.eventAt !== 'function') return 0
    const missingBySeq = new Map<number, ToolExecutionFactRecordV1>()
    for (const record of records) {
      if (record.result === undefined && record.request.eventSeq < throughSeq
        && record.request.eventSeq !== excludeRequestEventSeq) {
        missingBySeq.set(record.request.eventSeq, record)
      }
    }
    if (missingBySeq.size === 0) return 0

    let repaired = 0
    const codeStartsBySeq = new Map<number, EventLike>()
    const pendingCodeStarts = new Map<string, EventLike[]>()
    const window = this.maxSealedTailEvents
    // Inclusive lower bound: an event at seq == throughSeq - window IS scanned, so
    // a result landing exactly on the boundary is repaired. Pinned explicitly
    // because the "bounded sealed tail" is a closed lower interval: an exclusive
    // bound would silently drop a repair whose result sits exactly at the edge.
    const lower = Math.max(0, throughSeq - window)
    let processed = 0
    for (let seq = lower; seq < throughSeq; seq += 1) {
      if (signal?.aborted || missingBySeq.size === 0) break
      const event = session.eventAt(seq)
      if (event === undefined) break
      if (event.seq >= throughSeq) break
      processed += 1
      // Yield to the macrotask queue so an already-signaled Stop can abort the
      // bounded cold repair before any historical write lands.
      if (processed % 256 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
        if (signal?.aborted || missingBySeq.size === 0) break
      }
      if (event.type === 'tool/result') {
        const sourceSeq = event.sourceEventSeqs?.length === 1 ? event.sourceEventSeqs[0] : undefined
        const missing = sourceSeq === undefined ? undefined : missingBySeq.get(sourceSeq)
        if (missing?.request.kind !== 'model-tool-call') continue
        if (await this.attachResult(agent, event)) {
          missingBySeq.delete(sourceSeq!)
          repaired += 1
        }
        continue
      }
      if (event.type === 'tool/code-dispatch-start') {
        const signature = codeDispatchSignature(event)
        if (signature !== undefined) {
          codeStartsBySeq.set(event.seq, event)
          const pending = pendingCodeStarts.get(signature) ?? []
          pending.push(event)
          pendingCodeStarts.set(signature, pending)
        }
        continue
      }
      if (event.type !== 'tool/code-dispatch') continue
      const signature = codeDispatchSignature(event)
      if (signature === undefined) continue
      const pending = pendingCodeStarts.get(signature) ?? []
      const explicitSourceSeqs: readonly number[] | undefined = event.sourceEventSeqs
        ?.filter((seq: number) => Number.isSafeInteger(seq))
      const candidates = explicitSourceSeqs !== undefined && explicitSourceSeqs.length > 0
        ? explicitSourceSeqs
          .map((seq: number) => codeStartsBySeq.get(seq))
          .filter((start: EventLike | undefined): start is EventLike => start !== undefined && codeDispatchSignature(start) === signature)
        : pending
      const start = candidates.length === 1 ? candidates[0] : undefined
      // Every terminal closes the pending window for this exact dispatch shape,
      // matching attachCodeDispatchResult's preceding-terminal ambiguity rule.
      pendingCodeStarts.set(signature, [])
      if (start === undefined) continue
      const missing = missingBySeq.get(start.seq)
      if (missing?.request.kind !== 'code-dispatch') continue
      if (await this.attachKnownCodeDispatchResult(agent, event, start, missing)) {
        missingBySeq.delete(start.seq)
        repaired += 1
      }
    }
    return repaired
  }

  private async settleUnlessAborted(work: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await work
      return true
    }
    if (signal.aborted) return false
    let onAbort!: () => void
    const aborted = new Promise<boolean>(resolve => {
      onAbort = () => resolve(false)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([work.then(() => true), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private lifecycle(agent: Agent): { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd?: string } | undefined {
    const session = agent.session as unknown as SessionLike
    const sessionId = string(session.id)
    const version = session.header?.version
    const createdAt = session.header?.createdAt
    const cwd = session.header?.cwd === undefined ? undefined : string(session.header.cwd)
    if (sessionId === undefined || !Number.isSafeInteger(version) || (version as number) < 0
      || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0
      || (session.header?.cwd !== undefined && cwd === undefined)) return undefined
    return { sessionId, sessionFormatVersion: version as number, createdAt: createdAt as number, ...(cwd === undefined ? {} : { cwd }) }
  }

  private async writeApprovalSnapshot(
    agent: Agent,
    lifecycle: { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd?: string },
    approvalAskedSeq: number,
    requestId: string,
    callId: string,
    toolName: string,
  ): Promise<boolean> {
    if (this.approvals === undefined) return false
    const session = agent.session as unknown as SessionLike
    if (typeof session.eventAt !== 'function') return false
    // Approval is requested synchronously from inside the current execution, so
    // its source is the latest exact canonical request before approval/asked. A
    // bounded tail-anchored back-scan (window = maxSealedTailEvents) never
    // materializes the full session log.
    let source: EventLike | undefined
    const window = this.maxSealedTailEvents
    const lower = Math.max(0, approvalAskedSeq - window)
    for (let seq = approvalAskedSeq - 1; seq >= lower; seq -= 1) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.seq >= approvalAskedSeq || event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) continue
      const data = event.data as Record<string, unknown>
      if ((event.type === 'tool/call' && data.callId === callId && data.name === toolName)
        || (event.type === 'tool/code-dispatch-start' && data.subCallId === callId && data.name === toolName)) {
        source = event
        break
      }
    }
    if (source === undefined) return false
    const execution = await this.repository.get({ session: lifecycle, callId, requestEventSeq: source.seq })
    const captured = this.captures?.lookup(agent, callId, toolName)
    if (execution === undefined || execution.request.callId !== callId || execution.request.toolName !== toolName
      || execution.request.eventSeq !== source.seq || execution.request.eventType !== source.type
      || (this.captures !== undefined && (captured === undefined || hashAction(captured) !== execution.projection.actionHash))) return false
    const snapshot: ApprovalSnapshotRecordV1 = Object.freeze({
      version: 1, session: Object.freeze(lifecycle), approvalRequestId: requestId, approvalAskedSeq,
      execution: Object.freeze({
        requestEventSeq: execution.request.eventSeq,
        callId: execution.request.callId,
        toolName: execution.request.toolName,
        actionHash: execution.projection.actionHash,
        classificationCatalogFingerprint: execution.toolClassification.classificationCatalogFingerprint,
        projectorId: execution.projection.projectorId,
      }),
      // No host-backed environment projector is wired in D1.1.
      environment: Object.freeze({ version: 1, kind: 'native-header-only' }),
    })
    const outcome = await this.approvals.create(snapshot)
    return outcome === 'created' || outcome === 'identical'
  }
}
