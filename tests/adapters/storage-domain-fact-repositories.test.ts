import { describe, expect, it, vi } from 'vitest'
import {
  DshStorageDomainApprovalSnapshotRepository,
  DshStorageDomainExecutionFactRepository,
  DshStorageDomainFactRepositories,
  createActionSnapshot,
} from '../../src/index.js'
import type { ApprovalSnapshotRecordV1, SessionLifecycleIdentityV1, StorageDomainFacility, ToolExecutionFactRecordV1 } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const session: SessionLifecycleIdentityV1 = { sessionId: 'parent-1', sessionFormatVersion: 1, createdAt: 1_000, cwd: '/workspace' }

function execution(callId = 'call-1', eventSeq = 5): ToolExecutionFactRecordV1 {
  return {
    version: 1, session,
    request: { kind: 'model-tool-call', eventSeq, eventType: 'tool/call', callId, toolName: 'bash' },
    toolClassification: { classificationCatalogFingerprint: hash('c'), descriptor: { classification: 'ordinary', toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' } },
    projection: { projectorId: 'default-v1', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: hash('a'), observedAt: 1 },
  }
}

function approval(): ApprovalSnapshotRecordV1 {
  return {
    version: 1, session, approvalRequestId: 'ask-1', approvalAskedSeq: 6,
    execution: { requestEventSeq: 5, callId: 'call-1', toolName: 'bash', actionHash: hash('a'), classificationCatalogFingerprint: hash('c'), projectorId: 'default-v1' },
    environment: {},
  }
}

function facility() {
  const tables = new Map<string, Map<string, unknown>>()
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({
    table(name: string) {
      const rows = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, rows)
      return { get: (key: string) => rows.get(key), put: async (key: string, value: unknown) => { rows.set(key, value) } }
    },
    close,
  }))
  return { facility: { open } as StorageDomainFacility, open, close }
}

function repositories(storage: StorageDomainFacility) {
  const shared = new DshStorageDomainFactRepositories(storage)
  return { shared, executions: new DshStorageDomainExecutionFactRepository(shared), approvals: new DshStorageDomainApprovalSnapshotRepository(shared) }
}

describe('DshStorageDomainFactRepositories', () => {
  it('persists exact sidecars across reopened repository instances', async () => {
    const fake = facility()
    const first = repositories(fake.facility)
    await expect(first.executions.create(execution())).resolves.toBe('created')
    await expect(first.executions.create(execution())).resolves.toBe('identical')
    await expect(first.approvals.create(approval())).resolves.toBe('created')
    await first.shared.drain()
    expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({
      name: 'approve_for_me', version: 1,
      tables: expect.objectContaining({ executions: expect.anything(), approval_snapshots: expect.anything() }),
    }))

    const reopened = repositories(fake.facility)
    await expect(reopened.executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toEqual(execution())
    await expect(reopened.executions.list(session)).resolves.toEqual([execution()])
    await expect(reopened.approvals.get({ session, approvalRequestId: 'ask-1', approvalAskedSeq: 6 })).resolves.toEqual(approval())
    await expect(reopened.approvals.list(session)).resolves.toEqual([approval()])
    await reopened.shared.drain()
    expect(fake.open).toHaveBeenCalledTimes(2)
  })

  it('isolates lifecycle identities and never overwrites contradictory rows', async () => {
    const fake = facility()
    const { shared, executions, approvals } = repositories(fake.facility)
    await executions.create(execution())
    await approvals.create(approval())
    await expect(executions.create({ ...execution(), projection: { ...execution().projection, observedAt: 2 } })).resolves.toBe('conflict')
    await expect(approvals.create({ ...approval(), environment: { changed: true } })).resolves.toBe('conflict')
    const reused = { ...session, cwd: '/other' }
    await expect(executions.list(reused)).resolves.toEqual([])
    await expect(approvals.list(reused)).resolves.toEqual([])
    await shared.drain()
  })

  it('reconciles a single safe terminal result and preserves the immutable request', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    await executions.create(execution())
    const result = { eventSeq: 7, eventType: 'tool/result' as const, outcome: { kind: 'completed' as const } }
    await expect(executions.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('updated')
    await expect(executions.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('identical')
    await expect(executions.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result: { ...result, eventSeq: 8 } })).resolves.toBe('conflict')
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toMatchObject({ request: execution().request, result })
    await shared.drain()
  })

  it('fails closed when storage is missing or closed', async () => {
    const unavailable = repositories(undefined as unknown as StorageDomainFacility)
    await expect(unavailable.executions.create(execution())).resolves.toBe('conflict')
    await expect(unavailable.executions.list(session)).resolves.toEqual([])
    await unavailable.shared.drain()
    await expect(unavailable.approvals.create(approval())).resolves.toBe('conflict')
  })
})
