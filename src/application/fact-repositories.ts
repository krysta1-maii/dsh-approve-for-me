import { canonicalJson } from '../domain/json.js'
import type {
  ApprovalSnapshotRecordV1,
  ToolExecutionFactRecordV1,
} from '../domain/dossier.js'
import type { SessionLifecycleIdentityV1 } from '../domain/records.js'

export interface ExecutionFactRepository {
  put(record: ToolExecutionFactRecordV1): Promise<void>
  get(input: {
    session: SessionLifecycleIdentityV1
    callId: string
    requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV1 | undefined>
}

export interface ApprovalSnapshotRepository {
  create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical'>
  get(input: {
    session: SessionLifecycleIdentityV1
    approvalRequestId: string
    approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined>
}

export class InMemoryExecutionFactRepository implements ExecutionFactRepository {
  private readonly rows = new Map<string, ToolExecutionFactRecordV1>()

  async put(record: ToolExecutionFactRecordV1): Promise<void> {
    this.rows.set(this.key(record.session, record.request.callId, record.request.eventSeq), record)
  }

  async get(input: {
    session: SessionLifecycleIdentityV1
    callId: string
    requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV1 | undefined> {
    return this.rows.get(this.key(input.session, input.callId, input.requestEventSeq))
  }

  private key(session: SessionLifecycleIdentityV1, callId: string, requestEventSeq: number): string {
    return `${session.sessionId}\0${callId}\0${requestEventSeq}`
  }
}

export class InMemoryApprovalSnapshotRepository implements ApprovalSnapshotRepository {
  private readonly rows = new Map<string, ApprovalSnapshotRecordV1>()

  async create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical'> {
    const key = this.key(record.session, record.approvalRequestId, record.approvalAskedSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      this.rows.set(key, record)
      return 'created'
    }
    return canonicalJson(existing) === canonicalJson(record) ? 'identical' : 'created'
  }

  async get(input: {
    session: SessionLifecycleIdentityV1
    approvalRequestId: string
    approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined> {
    return this.rows.get(this.key(input.session, input.approvalRequestId, input.approvalAskedSeq))
  }

  private key(session: SessionLifecycleIdentityV1, approvalRequestId: string, approvalAskedSeq: number): string {
    return `${session.sessionId}\0${approvalRequestId}\0${approvalAskedSeq}`
  }
}
