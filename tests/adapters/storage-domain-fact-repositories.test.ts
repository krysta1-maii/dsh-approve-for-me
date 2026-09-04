import { describe, expect, it, vi } from 'vitest'
import {
  DshStorageDomainApprovalSnapshotRepository,
  DshStorageDomainExecutionFactRepository,
  DshStorageDomainFactRepositories,
  canonicalJson,
  createActionSnapshot,
  hashAction,
} from '../../src/index.js'
import type { ApprovalSnapshotRecordV1, SessionLifecycleIdentityV1, StorageDomainFacility, ToolExecutionFactRecordV1 } from '../../src/index.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'

const session: SessionLifecycleIdentityV1 = { sessionId: 'parent-1', sessionFormatVersion: 1, createdAt: 1_000, cwd: '/workspace' }
const schemas = [{ name: 'bash', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
const effective = createDshAlpha2EffectiveCatalog(schemas)
const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
const executionAction = createActionSnapshot({
  toolName: 'bash',
  arguments: { command: 'pwd' },
  projectorId: effective.approval.descriptors[0]!.actionProjectorId,
})
const executionActionHash = hashAction(executionAction)

function execution(callId = 'call-1', eventSeq = 5): ToolExecutionFactRecordV1 {
  return {
    version: 1, session, catalogCommitment: commitment,
    request: { kind: 'model-tool-call', eventSeq, eventType: 'tool/call', callId, toolName: 'bash' },
    toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0]! },
    projection: { projectorId: effective.approval.descriptors[0]!.actionProjectorId, action: executionAction, actionHash: executionActionHash, observedAt: 1 },
  }
}

function approval(): ApprovalSnapshotRecordV1 {
  return {
    version: 1, session, approvalRequestId: 'ask-1', approvalAskedSeq: 6,
    execution: { requestEventSeq: 5, callId: 'call-1', toolName: 'bash', actionHash: executionActionHash, classificationCatalogFingerprint: effective.dossier.fingerprint, projectorId: effective.approval.descriptors[0]!.actionProjectorId },
    environment: { version: 1, kind: 'native-header-only' },
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
  return { facility: { open } as StorageDomainFacility, open, close, tables }
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
      name: 'approve_for_me', version: 1, layout: 'per-record',
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

  it('rejects incomplete approval snapshots before durable admission', async () => {
    const fake = facility()
    const { shared, approvals } = repositories(fake.facility)
    await expect(approvals.create({ ...approval(), environment: null } as unknown as ApprovalSnapshotRecordV1)).resolves.toBe('conflict')
    await expect(approvals.create({ ...approval(), environment: { version: 1, kind: 'native-header-only', unsupported: true } } as unknown as ApprovalSnapshotRecordV1)).resolves.toBe('conflict')
    await expect(approvals.create({ ...approval(), environment: { version: 2, kind: 'native-header-only' } } as unknown as ApprovalSnapshotRecordV1)).resolves.toBe('conflict')
    await expect(approvals.create({ ...approval(), execution: { ...approval().execution, projectorId: '' } })).resolves.toBe('conflict')
    await expect(approvals.create({ ...approval(), approvalAskedSeq: 5 })).resolves.toBe('conflict')
    await expect(approvals.list(session)).resolves.toEqual([])
    await shared.drain()
  })

  it('rejects incomplete execution snapshots before durable admission', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    await expect(executions.create({ ...execution(), projection: { ...execution().projection, action: null } } as unknown as ToolExecutionFactRecordV1)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), projection: { ...execution().projection, actionHash: `sha256:${'b'.repeat(64)}` } })).resolves.toBe('conflict')
    await expect(executions.create({
      ...execution(),
      request: { kind: 'code-dispatch', eventSeq: 5, eventType: 'tool/code-dispatch-start', callId: 'call-1', toolName: 'bash' },
    } as unknown as ToolExecutionFactRecordV1)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), toolClassification: null } as unknown as ToolExecutionFactRecordV1)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'unknown' } } } as unknown as ToolExecutionFactRecordV1)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 5, eventType: 'tool/result', outcome: { kind: 'completed' } } })).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'sandbox-denied', mode: 'invalid' } } } as unknown as ToolExecutionFactRecordV1)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'sandbox-denied', mode: 'read-only', stderr: 'secret' } } } as unknown as ToolExecutionFactRecordV1)).resolves.toBe('conflict')
    await expect(executions.list(session)).resolves.toEqual([])
    await shared.drain()
  })

  it('isolates lifecycle identities and never overwrites contradictory rows', async () => {
    const fake = facility()
    const { shared, executions, approvals } = repositories(fake.facility)
    await executions.create(execution())
    await approvals.create(approval())
    await expect(executions.create({ ...execution(), projection: { ...execution().projection, observedAt: 2 } })).resolves.toBe('conflict')
    await expect(approvals.create({ ...approval(), execution: { ...approval().execution, projectorId: 'changed-v1' } })).resolves.toBe('conflict')
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

  it('persists only the bounded categorical sandbox-denial result', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    await executions.create(execution())
    const result = { eventSeq: 7, eventType: 'tool/result' as const, outcome: { kind: 'sandbox-denied' as const, mode: 'read-only' as const, enforcement: 'full' as const } }
    await expect(executions.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('updated')
    const persisted = await executions.get({ session, callId: 'call-1', requestEventSeq: 5 })
    expect(persisted).toMatchObject({ result })
    expect(Object.keys(persisted!.result!.outcome).sort()).toEqual(['enforcement', 'kind', 'mode'])
    await shared.drain()
  })

  it('durably stages one pre-commit terminal outcome across repository instances', async () => {
    const fake = facility()
    const first = repositories(fake.facility)
    await first.executions.create(execution())
    const terminalEvidence = { isError: false, outcome: { kind: 'completed' as const } }
    await expect(first.executions.stageTerminal({ session, callId: 'call-1', requestEventSeq: 5, terminalEvidence })).resolves.toBe('updated')
    await expect(first.executions.stageTerminal({ session, callId: 'call-1', requestEventSeq: 5, terminalEvidence })).resolves.toBe('identical')
    await expect(first.executions.stageTerminal({ session, callId: 'call-1', requestEventSeq: 5, terminalEvidence: { isError: true, outcome: { kind: 'tool-error' } } })).resolves.toBe('conflict')
    await first.shared.drain()

    const reopened = repositories(fake.facility)
    await expect(reopened.executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toMatchObject({ terminalEvidence })
    await expect(reopened.executions.attachResult({
      session,
      callId: 'call-1',
      requestEventSeq: 5,
      result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'tool-error' } },
    })).resolves.toBe('updated')
    await expect(reopened.executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toMatchObject({
      terminalEvidence,
      result: { eventSeq: 7, outcome: { kind: 'tool-error' } },
    })
    await reopened.shared.drain()
  })

  it('contains canonical poisoned nested records without rejecting callers', async () => {
    const fake = facility()
    const { shared, executions, approvals } = repositories(fake.facility)
    await executions.create(execution())
    await approvals.create(approval())
    const executionRows = fake.tables.get('executions')!
    const executionKey = [...executionRows.keys()].find(key => key.startsWith('e1_'))!
    const poisonedExecution = { ...execution(), request: null }
    executionRows.set(executionKey, { version: 1, canonical: canonicalJson(poisonedExecution), record: poisonedExecution })
    const approvalRows = fake.tables.get('approval_snapshots')!
    const approvalKey = [...approvalRows.keys()].find(key => key.startsWith('a1_'))!
    const poisonedApproval = { ...approval(), environment: { version: 1, kind: 'native-header-only', unsupported: true } }
    approvalRows.set(approvalKey, { version: 1, canonical: canonicalJson(poisonedApproval), record: poisonedApproval })
    await expect(executions.list(session)).resolves.toEqual([])
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toBeUndefined()
    const malformedCommitmentExecution = { ...execution(), catalogCommitment: {} }
    executionRows.set(executionKey, {
      version: 1,
      canonical: canonicalJson(malformedCommitmentExecution),
      record: malformedCommitmentExecution,
    })
    await expect(executions.list(session)).resolves.toEqual([])
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toBeUndefined()
    await expect(executions.create(execution())).resolves.toBe('conflict')
    await expect(approvals.list(session)).resolves.toEqual([])
    await expect(approvals.get({ session, approvalRequestId: 'ask-1', approvalAskedSeq: 6 })).resolves.toBeUndefined()
    await expect(approvals.create(approval())).resolves.toBe('conflict')
    await shared.drain()
  })

  it('yields large index reads to Host I/O and observes cancellation', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    for (let index = 0; index < 64; index += 1) {
      await executions.create(execution(`call-${index}`, index + 1))
    }
    const controller = new AbortController()
    let heartbeat = false
    setImmediate(() => {
      heartbeat = true
      controller.abort(new Error('stop'))
    })

    await expect(executions.list(session, controller.signal)).rejects.toMatchObject({ code: 'retryable-capability' })
    expect(heartbeat).toBe(true)
    await shared.drain()
  })

  it('surfaces missing read capability for the typed human fallback and keeps writes closed', async () => {
    const unavailable = repositories(undefined as unknown as StorageDomainFacility)
    await expect(unavailable.executions.create(execution())).resolves.toBe('conflict')
    await expect(unavailable.executions.list(session)).rejects.toMatchObject({ code: 'retryable-capability' })
    await unavailable.shared.drain()
    await expect(unavailable.approvals.create(approval())).resolves.toBe('conflict')
  })
})
