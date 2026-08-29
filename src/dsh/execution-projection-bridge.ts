import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { createActionSnapshot, hashAction } from '../domain/protocol.js'
import type { ApprovalSnapshotRecordV1, DelegationToolClassificationCatalogV1, ToolExecutionFactRecordV1 } from '../domain/dossier.js'
import type { ActionProjector } from '../ports/action-projector.js'
import type { ApprovalSnapshotRepository, ExecutionFactRepository } from '../application/fact-repositories.js'

interface EventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

interface SessionLike {
  readonly id: unknown
  readonly header: { readonly id: unknown; readonly version: unknown; readonly createdAt: unknown }
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
  constructor(
    private readonly projector: ActionProjector<ToolExecution>,
    private readonly catalog: DelegationToolClassificationCatalogV1,
    private readonly repository: ExecutionFactRepository,
    private readonly approvals?: ApprovalSnapshotRepository,
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
    if (agentId === undefined || agentId !== sessionId || sessionId !== headerId
      || !Number.isSafeInteger(version) || !Number.isSafeInteger(createdAt)
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
    let action
    try {
      action = createActionSnapshot(this.projector.project(exec))
    } catch {
      return
    }
    const record: ToolExecutionFactRecordV1 = Object.freeze({
      version: 1,
      session: Object.freeze({ sessionId, sessionFormatVersion: version as number, createdAt: createdAt as number }),
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
        projectorId: 'dsh-execution-fact-projection-v1',
        action,
        actionHash: hashAction(action),
        observedAt: event.time,
      }),
    })
    await this.repository.create(record)
  }

  /** Records the bounded approval audit after DSH has committed it to history. */
  async observeSessionEvent(agent: Agent, event: EventLike): Promise<void> {
    if (this.approvals === undefined || event.type !== 'approval/asked') return
    const data = event.data as Record<string, unknown>
    const requestId = string(data.id)
    const callId = string(data.callId)
    const toolName = string(data.toolName)
    const session = agent.session as unknown as SessionLike
    const sessionId = string(session.id)
    const version = session.header?.version
    const createdAt = session.header?.createdAt
    if (requestId === undefined || callId === undefined || toolName === undefined || sessionId === undefined
      || !Number.isSafeInteger(version) || !Number.isSafeInteger(createdAt)) return
    const lifecycle = { sessionId, sessionFormatVersion: version as number, createdAt: createdAt as number }
    const matches = (await this.repository.list(lifecycle)).filter(record =>
      record.request.callId === callId && record.request.toolName === toolName && record.request.eventSeq < event.seq)
    if (matches.length !== 1) return
    const snapshot: ApprovalSnapshotRecordV1 = Object.freeze({
      version: 1,
      session: Object.freeze(lifecycle),
      approvalRequestId: requestId,
      approvalAskedSeq: event.seq,
      // Environment evidence is deliberately empty until a host-backed
      // projector is available; it is still an immutable, bounded record.
      environment: Object.freeze({}),
    })
    await this.approvals.create(snapshot)
  }
}
