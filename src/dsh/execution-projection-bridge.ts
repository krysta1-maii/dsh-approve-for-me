import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createActionSnapshot, hashAction } from '../domain/protocol.js'
import { canonicalJson } from '../domain/json.js'
import type { ApprovalSnapshotRecordV1, DelegationToolClassificationCatalogV1, ToolExecutionFactRecordV1 } from '../domain/dossier.js'
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
  readonly events: readonly EventLike[]
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Creates immutable execution projections only after their source call has
 * appeared in canonical Session history. Projection failures never block the
 * tool itself; a missing projection is later an authorization failure.
 */
export class DshExecutionFactProjectionBridge {
  private readonly approvalWrites = new Map<string, Promise<void>>()
  private readonly resultWrites = new Map<string, Promise<void>>()
  private readonly terminalOutcomes = new Map<string, Extract<ToolExecutionFactRecordV1['result'], { readonly outcome: unknown }>['outcome']>()

  constructor(
    private readonly projector: ActionProjector<ToolExecution>,
    private readonly catalog: DelegationToolClassificationCatalogV1,
    private readonly repository: ExecutionFactRepository,
    private readonly approvals?: ApprovalSnapshotRepository,
    /** Reuse the exact volatile projection when capture and fact bridging share one. */
    private readonly captures?: ActionCapture<Agent, string>,
  ) {}

  async preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    await this.project(exec)
    return next()
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
      || !Array.isArray(session.events)) return

    const callId = String(exec.callId)
    const candidates = session.events.filter(event => {
      const data = event.data as Record<string, unknown>
      return (event.type === 'tool/call' && data.callId === callId && data.name === exec.name)
        || (event.type === 'tool/code-dispatch-start' && data.subCallId === callId && data.name === exec.name)
    })
    if (candidates.length !== 1) return
    const event = candidates[0]!
    const descriptor = this.catalog.descriptors.find(item => item.toolName === exec.name)
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
      request: Object.freeze({
        kind: event.type === 'tool/call' ? 'model-tool-call' : 'code-dispatch',
        eventSeq: event.seq,
        eventType: event.type,
        callId,
        toolName: exec.name,
      }),
      toolClassification: Object.freeze({
        classificationCatalogFingerprint: this.catalog.fingerprint,
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
  }

  /** Records a success marker before the agent loop appends its durable result event. */
  observeResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined {
    if (result.isError || exec.agent === undefined) return undefined
    const outcome = Object.freeze({ kind: 'completed' as const })
    const lifecycle = this.lifecycle(exec.agent)
    const session = exec.agent.session as unknown as SessionLike
    const callId = String(exec.callId)
    if (lifecycle === undefined) return undefined
    const candidates = session.events.filter(event => {
      const data = event.data as Record<string, unknown>
      return event.type === 'tool/call' && data.callId === callId && data.name === exec.name
    })
    if (candidates.length === 1) this.terminalOutcomes.set(this.resultKey(lifecycle, callId, candidates[0]!.seq), outcome)
    return undefined
  }

  /** Records the bounded approval audit after DSH has committed it to history. */
  observeSessionEvent(agent: Agent, event: EventLike): Promise<void> {
    if (event.type === 'tool/result') {
      const lifecycle = this.lifecycle(agent)
      if (lifecycle === undefined) return Promise.resolve()
      const key = `${canonicalJson(lifecycle)}\0${event.seq}`
      const existing = this.resultWrites.get(key)
      if (existing !== undefined) return existing
      const write = this.attachResult(agent, event)
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
    const write = this.writeApprovalSnapshot(lifecycle, event.seq, requestId, callId, toolName)
    this.approvalWrites.set(key, write)
    return write
  }

  /** Attaches only an unambiguous canonical native result correlation. */
  private async attachResult(agent: Agent, event: EventLike): Promise<void> {
    const lifecycle = this.lifecycle(agent)
    const data = event.data as Record<string, unknown>
    const message = data.message as { readonly source?: { readonly kind?: unknown; readonly callId?: unknown }; readonly content?: unknown } | undefined
    const blocks = message?.content
    const turn = data.turn
    const step = data.step
    if (lifecycle === undefined || !Array.isArray(blocks) || blocks.length !== 1
      || !Number.isSafeInteger(turn) || (turn as number) < 0
      || !Number.isSafeInteger(step) || (step as number) < 0) return
    const block = blocks[0] as { readonly type?: unknown; readonly toolCallId?: unknown; readonly isError?: unknown } | undefined
    const callId = block?.type === 'tool-result' ? string(block.toolCallId) : undefined
    const isError = block?.isError
    if (callId === undefined || isError === true || message?.source?.kind !== 'tool' || message.source.callId !== callId
      || event.sourceEventSeqs?.length !== 1 || !Number.isSafeInteger(event.sourceEventSeqs[0])) return
    const requestEventSeq = event.sourceEventSeqs[0]!
    const terminalOutcome = this.terminalOutcomes.get(this.resultKey(lifecycle, callId, requestEventSeq))
    if (terminalOutcome === undefined) return
    const session = agent.session as unknown as SessionLike
    const candidates = (await this.repository.list(lifecycle)).filter(record => {
      const call = session.events[record.request.eventSeq]
      const callData = call?.data as Record<string, unknown> | undefined
      return record.request.kind === 'model-tool-call' && record.request.callId === callId
        && record.request.eventSeq === requestEventSeq && record.request.eventSeq < event.seq && call?.type === 'tool/call'
        && callData?.turn === turn && callData?.step === step
    })
    if (candidates.length !== 1) return
    const outcome = await this.repository.attachResult({
      session: lifecycle, callId, requestEventSeq,
      result: { eventSeq: event.seq, eventType: 'tool/result', outcome: terminalOutcome },
    })
    if (outcome === 'updated' || outcome === 'identical') this.terminalOutcomes.delete(this.resultKey(lifecycle, callId, requestEventSeq))
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
    const event = session.events?.filter(candidate => candidate.type === 'approval/asked'
      && (candidate.data as Record<string, unknown>)?.id === requestId
      && (candidate.data as Record<string, unknown>)?.callId === callId
      && (candidate.data as Record<string, unknown>)?.toolName === toolName)
    if (event?.length !== 1 || event[0] === undefined) return
    await Promise.all(session.events
      .filter(candidate => candidate.type === 'tool/result' && candidate.seq < event[0]!.seq)
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

  private async writeApprovalSnapshot(lifecycle: { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd?: string }, approvalAskedSeq: number, requestId: string, callId: string, toolName: string): Promise<void> {
    const matches = (await this.repository.list(lifecycle)).filter(record =>
      record.request.callId === callId && record.request.toolName === toolName && record.request.eventSeq < approvalAskedSeq)
    if (matches.length !== 1 || this.approvals === undefined) return
    const execution = matches[0]!
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
      // Environment evidence remains deliberately bounded until a host-backed projector exists.
      environment: Object.freeze({}),
    })
    await this.approvals.create(snapshot)
  }
}
