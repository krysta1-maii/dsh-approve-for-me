import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createActionSnapshot, hashAction } from '../domain/protocol.js'
import { canonicalJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type { ApprovalSnapshotRecordV1, DelegationReceiptFactRecordV1, PrincipalDelegationReceiptV1, ToolExecutionFactRecordV1 } from '../domain/dossier.js'
import type { DshAlpha2EffectiveCatalog } from './effective-tool-catalog.js'
import type { ActionCapture, ActionProjector } from '../ports/action-projector.js'
import type { ApprovalSnapshotRepository, ExecutionFactRepository } from '../application/fact-repositories.js'

interface EventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  readonly sourceEventSeqs?: readonly number[]
}

interface SessionLike {
  readonly id: unknown
  readonly header: { readonly id: unknown; readonly version: unknown; readonly createdAt: unknown; readonly cwd?: unknown }
  readonly snapshotEvents?: () => readonly EventLike[]
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
  /** Exact live source identity; call IDs may be reused in later alpha.1 steps. */
  private readonly requestEventByToken = new Map<ToolExecution['token'], number>()

  constructor(
    private readonly projector: ActionProjector<ToolExecution>,
    private readonly catalogSource: (exec: ToolExecution) => DshAlpha2EffectiveCatalog | undefined,
    private readonly repository: ExecutionFactRepository,
    private readonly approvals?: ApprovalSnapshotRepository,
    /** Reuse the exact volatile projection when capture and fact bridging share one. */
    private readonly captures?: ActionCapture<Agent, string>,
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
    if (exec.signal?.aborted === true || exec.agent === undefined) return
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
      || typeof session.snapshotEvents !== 'function') return

    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return

    const callId = String(exec.callId)
    const effective = this.catalogSource(exec)
    if (effective === undefined) return
    const event = events[effective.execution.requestEventSeq]
    if (event === undefined || event.seq !== effective.execution.requestEventSeq
      || event.type !== effective.execution.requestEventType) return
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
    if (descriptor === undefined) return
    // When installed beside a capture bridge, only its frozen action is
    // authoritative. Re-projecting on a miss can create a different semantic
    // snapshot from mutable execution state after the approval ask began.
    let action = this.captures?.lookup(agent, callId, exec.name)
    if (this.captures !== undefined && action === undefined) return
    if (action === undefined) {
      try {
        action = createActionSnapshot(this.projector.project(exec))
      } catch {
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
    await this.repository.create(record)
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
    if (requestEventSeq === undefined || typeof session.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return undefined
    const source = events[requestEventSeq]
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
      write = attempt.then(attached => {
        if (!attached && this.resultWrites.get(key) === write) this.resultWrites.delete(key)
      }, error => {
        if (this.resultWrites.get(key) === write) this.resultWrites.delete(key)
        throw error
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
    const key = `${canonicalJson(lifecycle)}\0${event.seq}`
    const existing = this.approvalWrites.get(key)
    if (existing !== undefined) return existing
    const attempt = this.writeApprovalSnapshot(lifecycle, event.seq, requestId, callId, toolName)
    let write: Promise<void>
    write = attempt.then(persisted => {
      if (!persisted && this.approvalWrites.get(key) === write) this.approvalWrites.delete(key)
    }, error => {
      if (this.approvalWrites.get(key) === write) this.approvalWrites.delete(key)
      throw error
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
    if (typeof session.snapshotEvents !== 'function') return false
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return false
    const candidates = (await this.repository.list(lifecycle)).filter(record => {
      const call = events[record.request.eventSeq]
      const callData = call?.data as Record<string, unknown> | undefined
      return record.request.kind === 'model-tool-call' && record.request.callId === callId
        && record.request.eventSeq === requestEventSeq && record.request.eventSeq < event.seq && call?.type === 'tool/call'
        && callData?.turn === turn && callData?.step === step
    })
    if (candidates.length !== 1) return false
    const candidate = candidates[0]!
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
    if (outcome === 'updated' || outcome === 'identical') this.terminalOutcomes.delete(resultKey)
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
    if (outcome === 'updated' || outcome === 'identical') this.terminalOutcomes.delete(resultKey)
    return outcome === 'updated' || outcome === 'identical'
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
   * Closes the observer-policy race: a machine decision waits for the write
   * already scheduled by the same durable approval event (or schedules it from
   * canonical history itself). Missing/ambiguous history remains non-authorizing.
   */
  async awaitApprovalSnapshot(agent: Agent, requestId: string, callId: string, toolName: string): Promise<void> {
    const session = agent.session as unknown as SessionLike
    if (typeof session.snapshotEvents !== 'function') return
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return
    const event = events.filter(candidate => candidate.type === 'approval/asked'
      && (candidate.data as Record<string, unknown>)?.id === requestId
      && (candidate.data as Record<string, unknown>)?.callId === callId
      && (candidate.data as Record<string, unknown>)?.toolName === toolName)
    if (event.length !== 1 || event[0] === undefined) return
    await Promise.all(events
      .filter(candidate => (candidate.type === 'tool/result' || candidate.type === 'tool/code-dispatch')
        && candidate.seq < event[0]!.seq)
      .map(candidate => this.observeSessionEvent(agent, candidate)))
    await this.observeSessionEvent(agent, event[0])
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

  private async writeApprovalSnapshot(lifecycle: { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd?: string }, approvalAskedSeq: number, requestId: string, callId: string, toolName: string): Promise<boolean> {
    const matches = (await this.repository.list(lifecycle)).filter(record =>
      record.request.callId === callId && record.request.toolName === toolName && record.request.eventSeq < approvalAskedSeq)
      .sort((left, right) => right.request.eventSeq - left.request.eventSeq)
    if (matches.length === 0 || this.approvals === undefined) return false
    const execution = matches[0]!
    if (matches[1]?.request.eventSeq === execution.request.eventSeq) return false
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
