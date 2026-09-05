import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  createActionSnapshot,
  DSH_ALPHA2_SHELL_FAMILY,
  DSH_ALPHA2_SHELL_PROJECTOR_ID,
  createToolExecutionFactRecordV2,
  DshStorageDomainFactRepositories,
  DshStorageDomainSealedFacts,
  hashAction,
  projectSealForResultV1,
  SealBackfillRunner,
} from '../../src/index.js'
import type {
  ApprovalSnapshotRecordV1,
  SealBackfillDependencies,
  SealBackfillLiveEventView,
  ToolExecutionFactRecordV2,
} from '../../src/index.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import type { StorageDomainFacility } from '../../src/dsh/storage-domain-decision-record.js'
import { approvalE2ESchemas } from '../helpers/approval-e2e.js'

/*
 * WP8-c: the background-once backfill runner. The happy path runs against the
 * REAL DshStorageDomainSealedFacts chain validator so "chain continuous +
 * read-back verified" is the actual ledger invariant, not a stub.
 */

const schemas = [approvalE2ESchemas]

function memoryStorageDomain(): StorageDomainFacility {
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let current = tables.get(name)
    if (current === undefined) {
      current = new Map<string, unknown>()
      tables.set(name, current)
    }
    return {
      get: (key: string) => current!.get(key),
      put: async (key: string, value: unknown) => { current!.set(key, value) },
  delete: async (key: string) => { current!.delete(key) },
    }
  }
  return { open: async () => ({ table, close: async () => {} }) }
}

interface FixtureRecord {
  readonly record: ToolExecutionFactRecordV2
  readonly approval: ApprovalSnapshotRecordV1
  readonly live: ReadonlyMap<number, SealBackfillLiveEventView>
}

function buildScenario() {
  const effective = createDshAlpha2EffectiveCatalog(schemas)
  const dossier = effective.dossier
  const lifecycle = Object.freeze({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
  const lifecycleFingerprint = canonicalJson(lifecycle)
  const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
  const descriptor = dossier.descriptors.find(item => item.toolName === 'bash')!
  const wire = descriptor.toolSchemaFingerprint
  const fingerprint = dossier.fingerprint
  let callCounter = 0
  const makeRecord = (command: string): FixtureRecord => {
    callCounter += 1
    const callId = 'call-' + callCounter
    const requestEventSeq = callCounter * 10
    const approvalAskedSeq = requestEventSeq + 1
    const resultEventSeq = requestEventSeq + 2
    const action = createActionSnapshot({
      toolName: 'bash',
      arguments: { command },
      projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
      semantics: {
        family: DSH_ALPHA2_SHELL_FAMILY,
        value: { operation: 'bash', command, description: 'run ' + command, cwd: '/workspace', runInBackground: false },
      },
      requestedPermissions: [],
    })
    const record: ToolExecutionFactRecordV2 = createToolExecutionFactRecordV2({
      catalogCommitment: commitment,
      session: lifecycle,
      request: Object.freeze({ kind: 'model-tool-call', eventSeq: requestEventSeq, eventType: 'tool/call', callId, toolName: 'bash' }),
      toolClassification: Object.freeze({ classificationCatalogFingerprint: fingerprint, descriptor }),
      projection: Object.freeze({ projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID, action, observedAt: 100 + requestEventSeq }),
      result: Object.freeze({ eventSeq: resultEventSeq, eventType: 'tool/result', outcome: Object.freeze({ kind: 'completed' }) }),
    })
    const approval: ApprovalSnapshotRecordV1 = Object.freeze({
      version: 1,
      session: lifecycle,
      approvalRequestId: 'ask-' + callCounter,
      approvalAskedSeq,
      execution: Object.freeze({
        requestEventSeq,
        callId,
        toolName: 'bash',
        actionHash: hashAction(action),
        classificationCatalogFingerprint: fingerprint,
        projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
      }),
      environment: Object.freeze({ version: 1, kind: 'native-header-only' }),
    })
    const live = new Map<number, SealBackfillLiveEventView>([
      [requestEventSeq, Object.freeze({ seq: requestEventSeq, type: 'tool/call', time: 100 + requestEventSeq, data: {} })],
      [approvalAskedSeq, Object.freeze({ seq: approvalAskedSeq, type: 'approval/asked', time: 100 + approvalAskedSeq, data: {} })],
      [resultEventSeq, Object.freeze({ seq: resultEventSeq, type: 'tool/result', time: 100 + resultEventSeq, data: {} })],
    ])
    return { record, approval, live }
  }
  return { lifecycle, lifecycleFingerprint, commitment, makeRecord, descriptor }
}

interface DepHarness {
  readonly deps: SealBackfillDependencies
  readonly ledger: DshStorageDomainSealedFacts
  readonly calls: { executions: number; approvals: number; appends: number }
  setExecutions(value: readonly unknown[] | undefined): void
  setApprovals(value: readonly unknown[] | undefined): void
  setAppend(result: 'created' | 'identical' | 'conflict' | 'unavailable' | undefined): void
  onAppend?: () => void
}

function makeDeps(): DepHarness {
  const facility = memoryStorageDomain()
  const ledger = new DshStorageDomainSealedFacts(facility)
  const calls = { executions: 0, approvals: 0, appends: 0 }
  let executions: readonly unknown[] | undefined = []
  let approvals: readonly unknown[] | undefined = []
  let appendResult: 'created' | 'identical' | 'conflict' | 'unavailable' | undefined = undefined
  const harness: DepHarness = {
    ledger,
    calls,
    setExecutions: value => { executions = value },
    setApprovals: value => { approvals = value },
    setAppend: result => { appendResult = result },
    deps: {
      listExecutions: async () => { calls.executions += 1; return executions },
      listApprovals: async () => { calls.approvals += 1; return approvals },
      readSealed: fp => ledger.read(fp),
      appendSealed: async (seal, activity) => {
        calls.appends += 1
        harness.onAppend?.()
        return appendResult ?? ledger.append(seal, activity)
      },
      projectorResolvable: (toolName, projectorId) => toolName === 'bash' && projectorId === DSH_ALPHA2_SHELL_PROJECTOR_ID,
      now: () => Date.now(),
      log: () => {},
    },
  }
  return harness
}

describe('SealBackfillRunner (WP8-c)', () => {
  it('backfills multiple unsealed records into a continuous, read-verified chain with live occurredAt and epoch progression', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const second = scenario.makeRecord('pwd')
    const third = scenario.makeRecord('whoami')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live, ...second.live, ...third.live])
    h.setExecutions([first.record, third.record, second.record]) // unordered on purpose
    h.setApprovals([first.approval, second.approval, third.approval])
    const runner = new SealBackfillRunner(h.deps)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'settled', sealed: 3, skippedAlreadySealed: 0 })
    // Read-back is the real chain validator: undefined would mean a break.
    const chain = await h.ledger.read(scenario.lifecycleFingerprint)
    expect(chain).toBeDefined()
    expect(chain!.map(row => row.seal.sourceSeq)).toEqual([first.record.request.eventSeq, second.record.request.eventSeq, third.record.request.eventSeq])
    for (let index = 0; index < chain!.length; index += 1) {
      const row = chain![index]!
      expect(row.seal.catalog.epoch).toBe(0)
      if (index === 0) continue
      expect(row.seal.previousSealHash).toBe(chain![index - 1]!.seal.sealHash)
    }
    // occurredAt comes from the LIVE result event, not from the record or a wall clock.
    expect(chain![0]!.activity.occurredAt).toBe(100 + first.record.result!.eventSeq)
    expect(chain![2]!.activity.occurredAt).toBe(100 + third.record.result!.eventSeq)
    await runner.dispose()
  })

  it('skips already-sealed records and continues the chain from the validated tip', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const second = scenario.makeRecord('pwd')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live, ...second.live])
    h.setExecutions([first.record, second.record])
    h.setApprovals([first.approval, second.approval])
    // Pre-seal the first record through the same shared formula.
    const projection = projectSealForResultV1({
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      record: first.record,
      approvals: [first.approval],
      prior: undefined,
      occurredAt: 100 + first.record.result!.eventSeq,
    })!
    expect(await h.ledger.append(projection.seal, projection.activity)).toBe('created')
    const runner = new SealBackfillRunner(h.deps)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'settled', sealed: 1, skippedAlreadySealed: 1 })
    const chain = await h.ledger.read(scenario.lifecycleFingerprint)
    expect(chain).toBeDefined()
    expect(chain!.map(row => row.seal.sourceSeq)).toEqual([first.record.request.eventSeq, second.record.request.eventSeq])
    expect(chain![1]!.seal.previousSealHash).toBe(chain![0]!.seal.sealHash)
    await runner.dispose()
  })

  it('stops when the approval snapshot is missing or ambiguous, writing nothing', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const second = scenario.makeRecord('pwd')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live, ...second.live])
    h.setExecutions([first.record, second.record])
    h.setApprovals([second.approval]) // first has no binding -> stop before anything is written
    const runner = new SealBackfillRunner(h.deps)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'approval-ambiguous', sealed: 0 })
    expect(await h.ledger.read(scenario.lifecycleFingerprint)).toEqual([])
    expect(h.calls.appends).toBe(0)
    await runner.dispose()
  })

  it('stops when two approval snapshots bind the same execution', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])
    h.setExecutions([first.record])
    h.setApprovals([first.approval, Object.freeze({ ...first.approval, approvalRequestId: 'ask-duplicate', approvalAskedSeq: first.approval.approvalAskedSeq + 10 })])
    const runner = new SealBackfillRunner(h.deps)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'approval-ambiguous' })
    expect(h.calls.appends).toBe(0)
    await runner.dispose()
  })

  it.each([
    ['request event type mismatch', (live: Map<number, SealBackfillLiveEventView>, record: ToolExecutionFactRecordV2) => {
      live.set(record.request.eventSeq, Object.freeze({ seq: record.request.eventSeq, type: 'user/message', time: 1, data: {} }))
    }],
    ['result event absent', (live: Map<number, SealBackfillLiveEventView>, record: ToolExecutionFactRecordV2) => {
      live.delete(record.result!.eventSeq)
    }],
    ['result event type mismatch', (live: Map<number, SealBackfillLiveEventView>, record: ToolExecutionFactRecordV2) => {
      live.set(record.result!.eventSeq, Object.freeze({ seq: record.result!.eventSeq, type: 'tool/call', time: 1, data: {} }))
    }],
    ['result event time invalid', (live: Map<number, SealBackfillLiveEventView>, record: ToolExecutionFactRecordV2) => {
      live.set(record.result!.eventSeq, Object.freeze({ seq: record.result!.eventSeq, type: 'tool/result', time: -5, data: {} }))
    }],
  ] as const)('stops on live re-bind failure: %s', async (_name, breakLive) => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])
    breakLive(live, first.record)
    h.setExecutions([first.record])
    h.setApprovals([first.approval])
    const runner = new SealBackfillRunner(h.deps)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'live-rebind-failed' })
    expect(h.calls.appends).toBe(0)
    await runner.dispose()
  })

  it('stops when the projector no longer resolves, and on an append conflict', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])
    h.setExecutions([first.record])
    h.setApprovals([first.approval])
    const runner = new SealBackfillRunner({
      ...h.deps,
      projectorResolvable: () => false,
    })
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'projector-unresolvable' })
    expect(h.calls.appends).toBe(0)
    await runner.dispose()

    // Append conflict stops the run and writes nothing further.
    const h2 = makeDeps()
    h2.setExecutions([first.record])
    h2.setApprovals([first.approval])
    h2.setAppend('conflict')
    const runner2 = new SealBackfillRunner(h2.deps)
    const conflict = await runner2.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(conflict).toMatchObject({ kind: 'stopped', reason: 'append-conflict' })
    await runner2.dispose()
  })

  it('stops on a record without a durable result and on a strict-parse failure', async () => {
    const scenario = buildScenario()
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])

    const h = makeDeps()
    h.setExecutions([Object.freeze({ ...first.record, result: undefined })])
    h.setApprovals([first.approval])
    const runner = new SealBackfillRunner(h.deps)
    await expect(runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })).resolves.toMatchObject({ kind: 'stopped', reason: 'record-not-resulted' })
    await runner.dispose()

    const h2 = makeDeps()
    h2.setExecutions([{ garbage: true }])
    h2.setApprovals([first.approval])
    const runner2 = new SealBackfillRunner(h2.deps)
    await expect(runner2.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })).resolves.toMatchObject({ kind: 'stopped', reason: 'record-invalid' })
    await runner2.dispose()
  })

  it('aborts mid-run and keeps the partial appends safe (append-only/create-once)', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const second = scenario.makeRecord('pwd')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live, ...second.live])
    h.setExecutions([first.record, second.record])
    h.setApprovals([first.approval, second.approval])
    const runner = new SealBackfillRunner(h.deps)
    // Abort after the first append lands; the next per-step signal check stops
    // the run before the second record is promoted.
    h.onAppend = () => runner.abort(scenario.lifecycleFingerprint)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'aborted', sealed: 1 })
    const chain = await h.ledger.read(scenario.lifecycleFingerprint)
    expect(chain).toBeDefined()
    expect(chain!.map(row => row.seal.sourceSeq)).toEqual([first.record.request.eventSeq])
    await runner.dispose()
  })

  it.each([
    ['executions list unavailable', (h: DepHarness) => h.setExecutions(undefined), 'executions-unavailable'],
    ['sealed ledger unavailable', undefined, 'sealed-unavailable'],
    ['approvals list unavailable', (h: DepHarness) => h.setApprovals(undefined), 'approvals-unavailable'],
    ['poisoned approval row', (h: DepHarness) => h.setApprovals([{ garbage: true }]), 'approvals-unavailable'],
  ] as const)('gives up on unavailable storage: %s', async (_name, configure, reason) => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])
    h.setExecutions([first.record])
    h.setApprovals([first.approval])
    if (reason === 'sealed-unavailable') {
      h.deps.readSealed = async () => undefined
    } else {
      configure!(h)
    }
    const runner = new SealBackfillRunner(h.deps)
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'stopped', reason })
    expect(h.calls.appends).toBe(0)
    await runner.dispose()
  })

  it('attempts each lifecycle at most once per process', async () => {
    const scenario = buildScenario()
    const h = makeDeps()
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])
    h.setExecutions([first.record])
    h.setApprovals([first.approval])
    const runner = new SealBackfillRunner(h.deps)
    const input = {
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: (seq: number) => live.get(seq),
    }
    const firstOutcome = await runner.attempt(input)
    expect(firstOutcome).toMatchObject({ kind: 'settled', sealed: 1 })
    expect(runner.hasAttempted(scenario.lifecycleFingerprint)).toBe(true)
    expect(runner.attempt(input)).toBe('already-attempted')
    expect(h.calls.executions).toBe(1)
    expect(h.calls.approvals).toBe(1)
    expect(h.calls.appends).toBe(1)
    await runner.dispose()
    // Dispose poisons further attempts.
    expect(runner.attempt(input)).toBe('already-attempted')
  })

  it('reports the outcome through the bounded log sink and tolerates a throwing dependency', async () => {
    const scenario = buildScenario()
    const lines: string[] = []
    const h = makeDeps()
    h.deps.log = line => lines.push(line)
    const first = scenario.makeRecord('ls')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live])
    h.setExecutions([first.record])
    h.setApprovals([first.approval])
    const runner = new SealBackfillRunner(h.deps)
    await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(lines.some(line => line.includes('seal-backfill') && line.includes('settled'))).toBe(true)
    await runner.dispose()

    // A dependency that throws degrades to a bounded stopped outcome and the
    // runner never rejects.
    const h2 = makeDeps()
    h2.deps.listExecutions = async () => { throw new Error('storage exploded') }
    const lines2: string[] = []
    h2.deps.log = line => lines2.push(line)
    const runner2 = new SealBackfillRunner(h2.deps)
    await expect(runner2.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })).resolves.toMatchObject({ kind: 'stopped', reason: 'dependency-failed' })
    expect(lines2.some(line => line.includes('dependency-failed'))).toBe(true)
    await runner2.dispose()
  })

  it('end-to-end through the real fact repositories: unsealed sidecar rows become a verified chain', async () => {
    const scenario = buildScenario()
    const facility = memoryStorageDomain()
    const facts = new DshStorageDomainFactRepositories(facility)
    const first = scenario.makeRecord('ls')
    const second = scenario.makeRecord('pwd')
    const live = new Map<number, SealBackfillLiveEventView>([...first.live, ...second.live])
    expect(await facts.create(first.record)).toBe('created')
    expect(await facts.create(second.record)).toBe('created')
    expect(await facts.createApproval(first.approval)).toBe('created')
    expect(await facts.createApproval(second.approval)).toBe('created')
    const ledger = new DshStorageDomainSealedFacts(facility)
    const runner = new SealBackfillRunner({
      listExecutions: async session => facts.list(session).catch(() => undefined),
      listApprovals: async session => facts.listApprovals(session).catch(() => undefined),
      readSealed: fp => ledger.read(fp),
      appendSealed: (seal, activity) => ledger.append(seal, activity),
      projectorResolvable: (toolName, projectorId) => toolName === 'bash' && projectorId === DSH_ALPHA2_SHELL_PROJECTOR_ID,
      now: () => Date.now(),
      log: () => {},
    })
    const outcome = await runner.attempt({
      lifecycle: scenario.lifecycle,
      lifecycleFingerprint: scenario.lifecycleFingerprint,
      eventAt: seq => live.get(seq),
    })
    expect(outcome).toMatchObject({ kind: 'settled', sealed: 2 })
    const chain = await ledger.read(scenario.lifecycleFingerprint)
    expect(chain).toBeDefined()
    expect(chain!.map(row => row.seal.sourceSeq)).toEqual([first.record.request.eventSeq, second.record.request.eventSeq])
    await runner.dispose()
    await ledger.drain()
    await facts.drain()
  })
})