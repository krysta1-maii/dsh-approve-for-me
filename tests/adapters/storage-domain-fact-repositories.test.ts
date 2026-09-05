import { describe, expect, it, vi } from 'vitest'
import {
  canonicalJson,
  canonicalSha256,
  createActionSnapshot,
  createToolExecutionFactRecordV2,
  DshStorageDomainApprovalSnapshotRepository,
  DshStorageDomainExecutionFactRepository,
  DshStorageDomainFactRepositories,
  hashAction,
} from '../../src/index.js'
import type { ApprovalSnapshotRecordV1, JsonValue, PruneLifecycleOptions, SessionLifecycleIdentityV1, StorageDomainFacility, ToolExecutionFactRecordV2 } from '../../src/index.js'
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

function execution(callId = 'call-1', eventSeq = 5): ToolExecutionFactRecordV2 {
  return createToolExecutionFactRecordV2({
    session,
    catalogCommitment: commitment,
    request: { kind: 'model-tool-call', eventSeq, eventType: 'tool/call', callId, toolName: 'bash' },
    toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0]! },
    projection: { projectorId: effective.approval.descriptors[0]!.actionProjectorId, action: executionAction, observedAt: 1 },
  })
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
  const deleteCalls: { table: string; key: string }[] = []
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({
    table(name: string) {
      const rows = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, rows)
      return {
        get: (key: string) => rows.get(key),
        put: async (key: string, value: unknown) => { rows.set(key, value) },
        delete: async (key: string) => { deleteCalls.push({ table: name, key }); rows.delete(key) },
      }
    },
    close,
  }))
  return { facility: { open } as StorageDomainFacility, open, close, tables, deleteCalls }
}

function repositories(storage: StorageDomainFacility) {
  const shared = new DshStorageDomainFactRepositories(storage)
  return { shared, executions: new DshStorageDomainExecutionFactRepository(shared), approvals: new DshStorageDomainApprovalSnapshotRepository(shared) }
}

/** Wrap a record exactly as the WP9-a row format v2 does. */
function rowV2(record: unknown): unknown {
  return { version: 2, digest: canonicalSha256(record), record }
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
    await expect(executions.create({ ...execution(), projection: { ...execution().projection, action: null } } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), projection: { ...execution().projection, actionHash: `sha256:${'b'.repeat(64)}` } })).resolves.toBe('conflict')
    await expect(executions.create({
      ...execution(),
      request: { kind: 'code-dispatch', eventSeq: 5, eventType: 'tool/code-dispatch-start', callId: 'call-1', toolName: 'bash' },
    } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), toolClassification: null } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), catalogEvidence: {} } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'unknown' } } } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 5, eventType: 'tool/result', outcome: { kind: 'completed' } } })).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'sandbox-denied', mode: 'invalid' } } } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
    await expect(executions.create({ ...execution(), result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'sandbox-denied', mode: 'read-only', stderr: 'secret' } } } as unknown as ToolExecutionFactRecordV2)).resolves.toBe('conflict')
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
    executionRows.set(executionKey, rowV2(poisonedExecution))
    const approvalRows = fake.tables.get('approval_snapshots')!
    const approvalKey = [...approvalRows.keys()].find(key => key.startsWith('a1_'))!
    const poisonedApproval = { ...approval(), environment: { version: 1, kind: 'native-header-only', unsupported: true } }
    approvalRows.set(approvalKey, rowV2(poisonedApproval))
    await expect(executions.list(session)).resolves.toEqual([])
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toBeUndefined()
    const malformedEvidenceExecution = { ...execution(), catalogEvidence: {} }
    executionRows.set(executionKey, rowV2(malformedEvidenceExecution))
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

describe('WP9-a fact row v2 integrity', () => {
  it('reads any tampered record field as absent (digest mismatch)', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    await executions.create(execution())
    const rows = fake.tables.get('executions')!
    const key = [...rows.keys()].find(k => k.startsWith('e1_'))!
    const stored = rows.get(key) as { record: ToolExecutionFactRecordV2 }
    // actionHash is bound at rest whenever the arguments ref is inline (the
    // validator recomputes hashAction over the recovered full action), so a
    // rewritten actionHash with a recomputed row digest still reads absent.
    const tampered = {
      ...stored.record,
      projection: { ...stored.record.projection, actionHash: `sha256:${'d'.repeat(64)}` },
    }
    rows.set(key, rowV2(tampered))
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toBeUndefined()
    await expect(executions.list(session)).resolves.toEqual([])
    await shared.drain()
  })

  it('reads a row with a rewritten digest as absent (integrity failure)', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    await executions.create(execution())
    const rows = fake.tables.get('executions')!
    const key = [...rows.keys()].find(k => k.startsWith('e1_'))!
    const stored = rows.get(key) as { version: 2; digest: string; record: unknown }
    rows.set(key, { ...stored, digest: `sha256:${'c'.repeat(64)}` })
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).rejects.toMatchObject({ code: 'integrity' })
    await expect(executions.list(session)).rejects.toMatchObject({ code: 'integrity' })
    await shared.drain()
  })

  it('never accepts legacy v1 rows (foreign version reads as absent)', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    await executions.create(execution())
    const rows = fake.tables.get('executions')!
    const key = [...rows.keys()].find(k => k.startsWith('e1_'))!
    const v1Record = {
      version: 1,
      session,
      catalogCommitment: commitment,
      request: { kind: 'model-tool-call', eventSeq: 5, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0]! },
      projection: { projectorId: effective.approval.descriptors[0]!.actionProjectorId, action: executionAction, actionHash: executionActionHash, observedAt: 1 },
    }
    rows.set(key, { version: 1, canonical: canonicalJson(v1Record), record: v1Record })
    await expect(executions.get({ session, callId: 'call-1', requestEventSeq: 5 })).rejects.toMatchObject({ code: 'integrity' })
    await expect(executions.list(session)).rejects.toMatchObject({ code: 'integrity' })
    // admission over a foreign row never succeeds or silently replaces it
    await expect(executions.create(execution())).resolves.toBe('conflict')
    await shared.drain()
  })

  it('bounds one 5MB-arguments execution record to a small durable row (size regression)', async () => {
    const fake = facility()
    const { shared, executions } = repositories(fake.facility)
    const hugeArguments = { command: 'x'.repeat(5 * 1024 * 1024) } as JsonValue
    const hugeAction = createActionSnapshot({
      toolName: 'bash',
      arguments: hugeArguments,
      projectorId: effective.approval.descriptors[0]!.actionProjectorId,
      semantics: { family: 'shell-process-v1', value: { operation: 'bash' } },
    })
    const record = createToolExecutionFactRecordV2({
      session,
      catalogCommitment: commitment,
      request: {
        kind: 'code-dispatch', eventSeq: 5, eventType: 'tool/code-dispatch-start',
        rootCallId: 'root-1', rootRequestEventSeq: 1, parentCallId: 'root-1', parentRequestEventSeq: 2,
        callId: 'call-1', toolName: 'bash', arguments: hugeArguments,
      },
      toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0]! },
      projection: { projectorId: effective.approval.descriptors[0]!.actionProjectorId, action: hugeAction, observedAt: 1 },
    })
    await expect(executions.create(record)).resolves.toBe('created')
    const rows = fake.tables.get('executions')!
    const key = [...rows.keys()].find(k => k.startsWith('e1_'))!
    const storedRow = rows.get(key)!
    const storedBytes = Buffer.byteLength(JSON.stringify(storedRow), 'utf8')
    expect(storedBytes).toBeLessThan(16 * 1024)
    const persisted = await executions.get({ session, callId: 'call-1', requestEventSeq: 5 })
    expect(persisted).toEqual(record)
    expect(persisted!.request.kind).toBe('code-dispatch')
    if (persisted!.request.kind === 'code-dispatch') {
      expect(persisted!.request.arguments.kind).toBe('digest')
      if (persisted!.request.arguments.kind === 'digest') {
        expect(persisted!.request.arguments.bytes).toBeGreaterThan(5 * 1024 * 1024)
      }
    }
    expect(persisted!.projection.action.arguments.kind).toBe('digest')
    await shared.drain()
  })

  describe('WP9-b pruneLifecycle', () => {
    const pruneOptions = (overrides: Partial<PruneLifecycleOptions> = {}): PruneLifecycleOptions => ({
      graceMs: 60_000,
      now: 2_000_000,
      endedAt: 1_000_000,
      live: false,
      hasPendingApprovals: false,
      ...overrides,
    })

    /** Settle one execution (terminal evidence + result) so it is prunable. */
    async function settle(shared: DshStorageDomainFactRepositories, callId = 'call-1', requestEventSeq = 5) {
      await shared.stageTerminal({
        session,
        callId,
        requestEventSeq,
        terminalEvidence: { isError: false, outcome: { kind: 'completed' } },
      })
      await shared.attachResult({
        session,
        callId,
        requestEventSeq,
        result: { eventSeq: requestEventSeq + 2, eventType: 'tool/result', outcome: { kind: 'completed' } },
      })
    }

    const indexKeyOf = (rows: Map<string, unknown>) =>
      [...rows.entries()].find(([, value]) => (value as { version?: unknown }).version === 1)?.[0]

    it('skips a live lifecycle without touching storage', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      await executions.create(execution())
      await settle(shared)
      await expect(executions.pruneLifecycle(session, pruneOptions({ live: true }))).resolves.toBe('skipped-live')
      await expect(executions.pruneLifecycle(session, pruneOptions({ live: 'yes' as never }))).resolves.toBe('skipped-live')
      expect(fake.deleteCalls).toHaveLength(0)
      await expect(executions.list(session)).resolves.toHaveLength(1)
      await shared.drain()
    })

    it('skips when the lifecycle end is unknown or unproven', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      await executions.create(execution())
      await settle(shared)
      await expect(executions.pruneLifecycle(session, pruneOptions({ endedAt: undefined }))).resolves.toBe('skipped-live')
      await expect(executions.pruneLifecycle(session, pruneOptions({ endedAt: -1 }))).resolves.toBe('skipped-live')
      await expect(executions.pruneLifecycle(session, pruneOptions({ endedAt: 1.5 }))).resolves.toBe('skipped-live')
      expect(fake.deleteCalls).toHaveLength(0)
      await shared.drain()
    })

    it('skips within the grace window', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      await executions.create(execution())
      await settle(shared)
      await expect(executions.pruneLifecycle(session, pruneOptions({ now: 1_000_000 + 60_000 - 1 }))).resolves.toBe('skipped-recent')
      // Clock doubt (now precedes endedAt) is unavailable, not recent.
      await expect(executions.pruneLifecycle(session, pruneOptions({ now: 999_999 }))).resolves.toBe('unavailable')
      expect(fake.deleteCalls).toHaveLength(0)
      await expect(executions.list(session)).resolves.toHaveLength(1)
      await shared.drain()
    })

    it('skips on caller-evidenced pending approvals', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      await executions.create(execution())
      await settle(shared)
      await expect(executions.pruneLifecycle(session, pruneOptions({ hasPendingApprovals: true }))).resolves.toBe('skipped-uncommitted')
      expect(fake.deleteCalls).toHaveLength(0)
      await shared.drain()
    })

    it('skips a lifecycle whose executions are still in flight', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      // No terminal evidence/result: the execution has not durably settled.
      await executions.create(execution())
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('skipped-uncommitted')
      expect(fake.deleteCalls).toHaveLength(0)
      await expect(executions.list(session)).resolves.toHaveLength(1)
      // Settling it afterwards makes the lifecycle prunable.
      await settle(shared)
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('pruned')
      await shared.drain()
    })

    it('prunes records first and both index rows last, and replays idempotently', async () => {
      const fake = facility()
      const { shared, executions, approvals } = repositories(fake.facility)
      await executions.create(execution())
      await settle(shared)
      await approvals.create(approval())
      const executionIndexKey = indexKeyOf(fake.tables.get('executions')!)!
      const approvalIndexKey = indexKeyOf(fake.tables.get('approval_snapshots')!)!
      const recordDeletesBefore = fake.deleteCalls.length
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('pruned')
      expect(fake.tables.get('executions')!.size).toBe(0)
      expect(fake.tables.get('approval_snapshots')!.size).toBe(0)
      const calls = fake.deleteCalls.slice(recordDeletesBefore)
      expect(calls).toHaveLength(4)
      const executionCalls = calls.filter(call => call.table === 'executions').map(call => call.key)
      const approvalCalls = calls.filter(call => call.table === 'approval_snapshots').map(call => call.key)
      // Every record key is deleted before its table's index row.
      expect(executionCalls.at(-1)).toBe(executionIndexKey)
      expect(approvalCalls.at(-1)).toBe(approvalIndexKey)
      const lastTwo = calls.slice(-2).map(call => call.key)
      expect(lastTwo).toEqual(expect.arrayContaining([executionIndexKey, approvalIndexKey]))
      await expect(executions.list(session)).resolves.toEqual([])
      await expect(approvals.list(session)).resolves.toEqual([])
      // Identical replay: nothing left to delete, still 'pruned'.
      const callsAfterPrune = fake.deleteCalls.length
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('pruned')
      expect(fake.deleteCalls.length).toBe(callsAfterPrune)
      await shared.drain()
    })

    it('stops on a mid-prune delete failure, keeps the index, and resumes idempotently', async () => {
      // The failure injection must exist before the first open: the
      // repository caches its domain handle from the first use.
      const tables = new Map<string, Map<string, unknown>>()
      let approvalDeleteFailures = 1
      const failingFacility = {
        open: async () => ({
          table(name: string) {
            const rows = tables.get(name) ?? new Map<string, unknown>()
            tables.set(name, rows)
            return {
              get: (key: string) => rows.get(key),
              put: async (key: string, value: unknown) => { rows.set(key, value) },
              delete: async (key: string) => {
                if (name === 'approval_snapshots' && approvalDeleteFailures > 0) {
                  approvalDeleteFailures -= 1
                  throw new Error('storage down')
                }
                rows.delete(key)
              },
            }
          },
          close: async () => {},
        }),
      } as StorageDomainFacility
      const { shared, executions, approvals } = repositories(failingFacility)
      await executions.create(execution())
      await settle(shared)
      await approvals.create(approval())
      // The executions record is deleted, the approvals record delete throws,
      // both index rows survive for the replay.
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('unavailable')
      expect(tables.get('executions')!.size).toBe(1) // index row retained
      expect(tables.get('approval_snapshots')!.size).toBe(2) // record + index retained
      // Replay after the transient failure completes the prune.
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('pruned')
      expect(tables.get('executions')!.size).toBe(0)
      expect(tables.get('approval_snapshots')!.size).toBe(0)
      await shared.drain()
    })

    it('never deletes on a poisoned index row', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      await executions.create(execution())
      await settle(shared)
      const rows = fake.tables.get('executions')!
      const indexKey = indexKeyOf(rows)!
      const index = rows.get(indexKey) as { canonical: string }
      rows.set(indexKey, { ...index, canonical: 'tampered' })
      await expect(executions.pruneLifecycle(session, pruneOptions())).resolves.toBe('unavailable')
      expect(fake.deleteCalls).toHaveLength(0)
      await shared.drain()
    })

    it('treats an empty lifecycle as an already-pruned no-op', async () => {
      const fake = facility()
      const { shared, executions } = repositories(fake.facility)
      await expect(executions.pruneLifecycle({ sessionId: 'ghost', sessionFormatVersion: 1, createdAt: 2 }, pruneOptions())).resolves.toBe('pruned')
      expect(fake.deleteCalls).toHaveLength(0)
      await shared.drain()
    })
  })
})
