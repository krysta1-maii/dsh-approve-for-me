import { canonicalJson } from '../domain/json.js'
import type { ApprovalSnapshotRecordV1, ToolExecutionFactRecordV1 } from '../domain/dossier.js'
import type { SessionLifecycleIdentityV1 } from '../domain/records.js'
import type { ApprovalSnapshotRepository, ExecutionFactRepository } from '../application/fact-repositories.js'
import type { StorageDomainFacility, StorageDomainHandle, StorageDomainTable } from './storage-domain-decision-record.js'

type StoredRow = { readonly version: 1; readonly canonical: string; readonly record: unknown }
type StoredIndex = { readonly version: 1; readonly canonical: string; readonly session: SessionLifecycleIdentityV1; readonly keys: readonly string[] }

const factDomainSpec = Object.freeze({
  // The single host-private domain is the contract boundary. Per-lifecycle
  // index rows share their fact table because the host only offers get/put.
  name: 'approve_for_me', version: 1, layout: 'per-record',
  tables: Object.freeze({
    executions: Object.freeze({ valueSchema: Object.freeze({ parse: (value: unknown) => parseFactValue(value) }) }),
    approval_snapshots: Object.freeze({ valueSchema: Object.freeze({ parse: (value: unknown) => parseFactValue(value) }) }),
  }),
})

function storageKey(prefix: string, value: unknown): string {
  // Canonical tuple encoding is collision-free without leaking separators into
  // a backend key layout or relying on a hash collision assumption.
  return `${prefix}${Buffer.from(canonicalJson(value), 'utf8').toString('base64url')}`
}

function lifecycleIdentity(session: SessionLifecycleIdentityV1): readonly [string, number, number, string | null] {
  return [session.sessionId, session.sessionFormatVersion, session.createdAt, session.cwd ?? null]
}

function sameLifecycle(left: SessionLifecycleIdentityV1, right: SessionLifecycleIdentityV1): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function validSession(value: unknown): value is SessionLifecycleIdentityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Record<string, unknown>
  return typeof session.sessionId === 'string' && session.sessionId.length > 0
    && Number.isSafeInteger(session.sessionFormatVersion) && (session.sessionFormatVersion as number) >= 0
    && Number.isSafeInteger(session.createdAt) && (session.createdAt as number) >= 0
    && (session.cwd === undefined || (typeof session.cwd === 'string' && session.cwd.length > 0))
}

function parseRow(value: unknown): StoredRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid dossier fact row')
  const row = value as Partial<StoredRow>
  if (row.version !== 1 || typeof row.canonical !== 'string' || row.record === undefined || row.canonical !== canonicalJson(row.record)) {
    throw new TypeError('invalid dossier fact row')
  }
  return Object.freeze({ version: 1, canonical: row.canonical, record: row.record })
}

function parseFactValue(value: unknown): StoredRow | StoredIndex {
  try { return parseRow(value) } catch { return parseIndex(value) }
}

function parseIndex(value: unknown): StoredIndex {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid dossier fact index')
  const index = value as Partial<StoredIndex>
  if (index.version !== 1 || typeof index.canonical !== 'string' || !validSession(index.session)
    || !Array.isArray(index.keys) || index.keys.some(key => typeof key !== 'string' || key.length === 0)
    || new Set(index.keys).size !== index.keys.length) throw new TypeError('invalid dossier fact index')
  const canonical = canonicalJson({ session: index.session, keys: index.keys })
  if (index.canonical !== canonical) throw new TypeError('invalid dossier fact index')
  return Object.freeze({ version: 1, canonical, session: Object.freeze({ ...index.session }), keys: Object.freeze([...index.keys]) })
}

/**
 * Host-private, create-once Storage Domain sidecars. Every read validates the
 * canonical envelope and exact lifecycle; unavailable or poisoned storage is
 * represented as an empty lookup, which remains non-authorizing upstream.
 */
export class DshStorageDomainFactRepositories {
  private readonly tails = new Map<string, Promise<void>>()
  private admissionOpen = true
  private readonly ready: Promise<StorageDomainHandle | undefined>

  constructor(facility: StorageDomainFacility | undefined) {
    this.ready = facility === undefined ? Promise.resolve(undefined) : facility.open(factDomainSpec).catch(() => undefined)
  }

  async drain(): Promise<void> {
    this.admissionOpen = false
    await Promise.all(this.tails.values())
    const domain = await this.ready
    if (domain !== undefined) await domain.close()
  }

  async create(record: ToolExecutionFactRecordV1): Promise<'created' | 'identical' | 'conflict'> {
    if (!this.validExecution(record)) return 'conflict'
    return this.createOnce('executions', 'executions', record.session, this.executionKey(record.session, record.request.callId, record.request.eventSeq), record)
  }

  async list(session: SessionLifecycleIdentityV1): Promise<readonly ToolExecutionFactRecordV1[]> {
    const rows = await this.listRows('executions', 'executions', session)
    if (rows === undefined || rows.some(row => !this.validExecution(row) || !sameLifecycle((row as ToolExecutionFactRecordV1).session, session))) return Object.freeze([])
    return Object.freeze(rows as ToolExecutionFactRecordV1[])
  }

  async get(input: { session: SessionLifecycleIdentityV1; callId: string; requestEventSeq: number }): Promise<ToolExecutionFactRecordV1 | undefined> {
    const row = await this.readRow('executions', this.executionKey(input.session, input.callId, input.requestEventSeq))
    if (!this.validExecution(row) || !sameLifecycle(row.session, input.session)
      || row.request.callId !== input.callId || row.request.eventSeq !== input.requestEventSeq) return undefined
    return row
  }

  async attachResult(input: { readonly session: SessionLifecycleIdentityV1; readonly callId: string; readonly requestEventSeq: number; readonly result: NonNullable<ToolExecutionFactRecordV1['result']> }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.executionKey(input.session, input.callId, input.requestEventSeq)
    return this.serial(input.session, async () => {
      const existing = await this.readRow('executions', key)
      if (!this.validExecution(existing) || !sameLifecycle(existing.session, input.session)
        || existing.request.callId !== input.callId || existing.request.eventSeq !== input.requestEventSeq) return 'missing'
      if (existing.result !== undefined) return canonicalJson(existing.result) === canonicalJson(input.result) ? 'identical' : 'conflict'
      const updated: ToolExecutionFactRecordV1 = Object.freeze({ ...existing, result: Object.freeze({ ...input.result }) })
      return await this.replaceExact('executions', key, updated) ? 'updated' : 'conflict'
    })
  }

  async createApproval(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'> {
    if (!this.validApproval(record)) return 'conflict'
    return this.createOnce('approval_snapshots', 'approval_snapshots', record.session, this.approvalKey(record.session, record.approvalRequestId, record.approvalAskedSeq), record)
  }

  async listApprovals(session: SessionLifecycleIdentityV1): Promise<readonly ApprovalSnapshotRecordV1[]> {
    const rows = await this.listRows('approval_snapshots', 'approval_snapshots', session)
    if (rows === undefined || rows.some(row => !this.validApproval(row) || !sameLifecycle((row as ApprovalSnapshotRecordV1).session, session))) return Object.freeze([])
    return Object.freeze(rows as ApprovalSnapshotRecordV1[])
  }

  async getApproval(input: { session: SessionLifecycleIdentityV1; approvalRequestId: string; approvalAskedSeq: number }): Promise<ApprovalSnapshotRecordV1 | undefined> {
    const row = await this.readRow('approval_snapshots', this.approvalKey(input.session, input.approvalRequestId, input.approvalAskedSeq))
    if (!this.validApproval(row) || !sameLifecycle(row.session, input.session)
      || row.approvalRequestId !== input.approvalRequestId || row.approvalAskedSeq !== input.approvalAskedSeq) return undefined
    return row
  }

  // Interface method names overlap only at create/list/get, so route based on
  // the discriminating record/input fields without exposing a second facade.
  async createSnapshot(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'> { return this.createApproval(record) }
  async listSnapshot(session: SessionLifecycleIdentityV1): Promise<readonly ApprovalSnapshotRecordV1[]> { return this.listApprovals(session) }
  async getSnapshot(input: { session: SessionLifecycleIdentityV1; approvalRequestId: string; approvalAskedSeq: number }): Promise<ApprovalSnapshotRecordV1 | undefined> { return this.getApproval(input) }

  private async createOnce(tableName: string, indexName: string, session: SessionLifecycleIdentityV1, key: string, record: unknown): Promise<'created' | 'identical' | 'conflict'> {
    return this.serial(session, async () => {
      if (!this.admissionOpen) return 'conflict'
      const domain = await this.ready
      if (domain === undefined) return 'conflict'
      try {
        const table = domain.table(tableName)
        const canonical = canonicalJson(record)
        const existing = table.get(key)
        if (existing !== undefined) {
          const row = parseRow(existing)
          if (row.canonical !== canonical) return 'conflict'
          return await this.index(indexName, session, key) ? 'identical' : 'conflict'
        }
        await table.put(key, Object.freeze({ version: 1, canonical, record: Object.freeze({ ...(record as object) }) }))
        const confirmed = await this.readRow(tableName, key)
        if (confirmed === undefined || canonicalJson(confirmed) !== canonical) return 'conflict'
        if (!await this.index(indexName, session, key)) return 'conflict'
        return 'created'
      } catch { return 'conflict' }
    })
  }

  private async replaceExact(tableName: string, key: string, record: unknown): Promise<boolean> {
    if (!this.admissionOpen) return false
    const domain = await this.ready
    if (domain === undefined) return false
    try {
      const canonical = canonicalJson(record)
      await domain.table(tableName).put(key, Object.freeze({ version: 1, canonical, record: Object.freeze({ ...(record as object) }) }))
      const confirmed = await this.readRow(tableName, key)
      return confirmed !== undefined && canonicalJson(confirmed) === canonical
    } catch { return false }
  }

  private async index(indexName: string, session: SessionLifecycleIdentityV1, key: string): Promise<boolean> {
    const domain = await this.ready
    if (domain === undefined) return false
    const indexKey = this.lifecycleKey(session)
    const table = domain.table(indexName)
    const existing = table.get(indexKey)
    let keys: readonly string[]
    if (existing === undefined) keys = [key]
    else {
      const parsed = parseIndex(existing)
      if (!sameLifecycle(parsed.session, session)) return false
      if (parsed.keys.includes(key)) return true
      keys = [...parsed.keys, key]
    }
    const canonical = canonicalJson({ session, keys })
    await table.put(indexKey, Object.freeze({ version: 1, canonical, session: Object.freeze({ ...session }), keys: Object.freeze([...keys]) }))
    const confirmed = parseIndex(table.get(indexKey))
    return confirmed.canonical === canonical
  }

  private async listRows(tableName: string, indexName: string, session: SessionLifecycleIdentityV1): Promise<readonly unknown[] | undefined> {
    if (!this.admissionOpen) return undefined
    try {
      const domain = await this.ready
      if (domain === undefined) return undefined
      const index = domain.table(indexName).get(this.lifecycleKey(session))
      if (index === undefined) return Object.freeze([])
      const parsed = parseIndex(index)
      if (!sameLifecycle(parsed.session, session)) return undefined
      const rows: unknown[] = []
      for (const key of parsed.keys) {
        const row = await this.readRow(tableName, key)
        if (row === undefined) return undefined
        rows.push(row)
      }
      return Object.freeze(rows)
    } catch { return undefined }
  }

  private async readRow(tableName: string, key: string): Promise<unknown | undefined> {
    try {
      const domain = await this.ready
      if (domain === undefined) return undefined
      return parseRow(domain.table(tableName).get(key)).record
    } catch { return undefined }
  }

  private serial<T>(session: SessionLifecycleIdentityV1, operation: () => Promise<T>): Promise<T> {
    const key = this.lifecycleKey(session)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    return result.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
  }

  private lifecycleKey(session: SessionLifecycleIdentityV1): string { return storageKey('i1_', lifecycleIdentity(session)) }
  private executionKey(session: SessionLifecycleIdentityV1, callId: string, seq: number): string { return storageKey('e1_', [...lifecycleIdentity(session), callId, seq]) }
  private approvalKey(session: SessionLifecycleIdentityV1, requestId: string, seq: number): string { return storageKey('a1_', [...lifecycleIdentity(session), requestId, seq]) }

  private validExecution(value: unknown): value is ToolExecutionFactRecordV1 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Partial<ToolExecutionFactRecordV1>
    return record.version === 1 && validSession(record.session)
      && record.request !== null && typeof record.request === 'object' && !Array.isArray(record.request)
      && record.projection !== null && typeof record.projection === 'object' && !Array.isArray(record.projection)
      && typeof record.request.callId === 'string' && record.request.callId.length > 0
      && Number.isSafeInteger(record.request.eventSeq) && (record.request.eventSeq as number) >= 0
      && typeof record.projection.actionHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.projection.actionHash)
  }

  private validApproval(value: unknown): value is ApprovalSnapshotRecordV1 {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Partial<ApprovalSnapshotRecordV1>
    return record.version === 1 && validSession(record.session) && typeof record.approvalRequestId === 'string' && record.approvalRequestId.length > 0
      && Number.isSafeInteger(record.approvalAskedSeq) && (record.approvalAskedSeq as number) >= 0
      && record.execution !== null && typeof record.execution === 'object' && !Array.isArray(record.execution)
      && typeof record.execution.callId === 'string' && record.execution.callId.length > 0
  }
}

/** Facades retain the existing distinct application repository ports. */
export class DshStorageDomainExecutionFactRepository implements ExecutionFactRepository {
  constructor(private readonly shared: DshStorageDomainFactRepositories) {}
  list(session: SessionLifecycleIdentityV1) { return this.shared.list(session) }
  create(record: ToolExecutionFactRecordV1) { return this.shared.create(record) }
  attachResult(input: Parameters<ExecutionFactRepository['attachResult']>[0]) { return this.shared.attachResult(input) }
  get(input: Parameters<ExecutionFactRepository['get']>[0]) { return this.shared.get(input) }
}

export class DshStorageDomainApprovalSnapshotRepository implements ApprovalSnapshotRepository {
  constructor(private readonly shared: DshStorageDomainFactRepositories) {}
  list(session: SessionLifecycleIdentityV1) { return this.shared.listApprovals(session) }
  create(record: ApprovalSnapshotRecordV1) { return this.shared.createApproval(record) }
  get(input: Parameters<ApprovalSnapshotRepository['get']>[0]) { return this.shared.getApproval(input) }
}
