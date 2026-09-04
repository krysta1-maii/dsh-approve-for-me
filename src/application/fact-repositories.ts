import { canonicalJson } from '../domain/json.js'
import type {
  ApprovalSnapshotRecordV1,
  ToolExecutionFactRecordV1,
} from '../domain/dossier.js'
import type { SessionLifecycleIdentityV1 } from '../domain/records.js'

export interface ExecutionFactRepository {
  /** List an exact immutable session lifecycle; never merge reused session IDs. */
  list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ToolExecutionFactRecordV1[]>
  /** Create once; a repeat must be byte-identical or report a conflict. */
  create(record: ToolExecutionFactRecordV1): Promise<'created' | 'identical' | 'conflict'>
  /**
   * Persist content-free terminal evidence before the Host can append its
   * canonical result event. This is not settlement and is never consumed
   * without independent Session-event corroboration.
   */
  stageTerminal(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly terminalEvidence: NonNullable<ToolExecutionFactRecordV1['terminalEvidence']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'>
  /** Attach the durable matching result event without replacing request facts. */
  attachResult(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly result: NonNullable<ToolExecutionFactRecordV1['result']>
    readonly delegationReceipt?: NonNullable<ToolExecutionFactRecordV1['delegationReceipt']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'>
  get(input: {
    session: SessionLifecycleIdentityV1
    callId: string
    requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV1 | undefined>
}

export interface ApprovalSnapshotRepository {
  /** List an exact immutable session lifecycle; never merge reused session IDs. */
  list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ApprovalSnapshotRecordV1[]>
  create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'>
  get(input: {
    session: SessionLifecycleIdentityV1
    approvalRequestId: string
    approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined>
}

export class InMemoryExecutionFactRepository implements ExecutionFactRepository {
  private readonly rows = new Map<string, ToolExecutionFactRecordV1>()

  async list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ToolExecutionFactRecordV1[]> {
    signal?.throwIfAborted()
    const prefix = `${this.lifecycleKey(session)}\0`
    return Object.freeze([...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record))
  }

  async create(record: ToolExecutionFactRecordV1): Promise<'created' | 'identical' | 'conflict'> {
    const key = this.key(record.session, record.request.callId, record.request.eventSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      this.rows.set(key, record)
      return 'created'
    }
    return canonicalJson(existing) === canonicalJson(record) ? 'identical' : 'conflict'
  }

  async stageTerminal(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly terminalEvidence: NonNullable<ToolExecutionFactRecordV1['terminalEvidence']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.key(input.session, input.callId, input.requestEventSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) return 'missing'
    const next: ToolExecutionFactRecordV1 = Object.freeze({
      ...existing,
      terminalEvidence: Object.freeze({
        isError: input.terminalEvidence.isError,
        outcome: Object.freeze({ ...input.terminalEvidence.outcome }),
        ...input.terminalEvidence.receipt === undefined
          ? {}
          : { receipt: Object.freeze({ ...input.terminalEvidence.receipt }) },
      }),
    })
    if (existing.terminalEvidence !== undefined) {
      return canonicalJson(existing) === canonicalJson(next) ? 'identical' : 'conflict'
    }
    this.rows.set(key, next)
    return 'updated'
  }

  async attachResult(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly result: NonNullable<ToolExecutionFactRecordV1['result']>
    readonly delegationReceipt?: NonNullable<ToolExecutionFactRecordV1['delegationReceipt']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.key(input.session, input.callId, input.requestEventSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) return 'missing'
    const next = Object.freeze({
      ...existing,
      result: Object.freeze({ ...input.result }),
      ...input.delegationReceipt === undefined ? {} : { delegationReceipt: Object.freeze({ ...input.delegationReceipt }) },
    })
    if (existing.result !== undefined || existing.delegationReceipt !== undefined) {
      return canonicalJson(existing) === canonicalJson(next) ? 'identical' : 'conflict'
    }
    this.rows.set(key, next)
    return 'updated'
  }

  async get(input: {
    session: SessionLifecycleIdentityV1
    callId: string
    requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV1 | undefined> {
    return this.rows.get(this.key(input.session, input.callId, input.requestEventSeq))
  }

  private lifecycleKey(session: SessionLifecycleIdentityV1): string {
    return canonicalJson(session)
  }

  private key(session: SessionLifecycleIdentityV1, callId: string, requestEventSeq: number): string {
    return `${this.lifecycleKey(session)}\0${callId}\0${requestEventSeq}`
  }
}

export class InMemoryApprovalSnapshotRepository implements ApprovalSnapshotRepository {
  private readonly rows = new Map<string, ApprovalSnapshotRecordV1>()

  async list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ApprovalSnapshotRecordV1[]> {
    signal?.throwIfAborted()
    const prefix = `${this.lifecycleKey(session)}\0`
    return Object.freeze([...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record))
  }

  async create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'> {
    const key = this.key(record.session, record.approvalRequestId, record.approvalAskedSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      this.rows.set(key, record)
      return 'created'
    }
    return canonicalJson(existing) === canonicalJson(record) ? 'identical' : 'conflict'
  }

  async get(input: {
    session: SessionLifecycleIdentityV1
    approvalRequestId: string
    approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined> {
    return this.rows.get(this.key(input.session, input.approvalRequestId, input.approvalAskedSeq))
  }

  private lifecycleKey(session: SessionLifecycleIdentityV1): string {
    return canonicalJson(session)
  }

  private key(session: SessionLifecycleIdentityV1, approvalRequestId: string, approvalAskedSeq: number): string {
    return `${this.lifecycleKey(session)}\0${approvalRequestId}\0${approvalAskedSeq}`
  }
}
