import { describe, expect, it } from 'vitest'
import { DshParentSessionFactSource, canonicalJson, createActionSnapshot, createActivityV1, createSealV1, fingerprintDelegationToolCatalogV1, genesisSealHash, readSealedParentSessionFacts } from '../../src/index.js'
import type { ActivityV1, SealV1 } from '../../src/index.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import type {
  ApprovalSnapshotRecordV1,
  DelegationToolClassificationCatalogV1,
  ToolExecutionFactRecordV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const schemas = [{ name: 'bash', description: 'bash schema', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
const effective = createDshAlpha2EffectiveCatalog(schemas)
const catalog: DelegationToolClassificationCatalogV1 = effective.dossier
const lifecycle = { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 100 }
const descriptor = catalog.descriptors[0]!
const execution: ToolExecutionFactRecordV1 = {
  version: 1,
  catalogCommitment: createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas),
  session: lifecycle,
  request: { kind: 'model-tool-call', eventSeq: 3, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
  toolClassification: { classificationCatalogFingerprint: catalog.fingerprint, descriptor },
  projection: { projectorId: 'default-v1', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: hash('a'), observedAt: 101 },
}
const approval: ApprovalSnapshotRecordV1 = {
  version: 1, session: lifecycle, approvalRequestId: 'ask-1', approvalAskedSeq: 4,
  execution: { requestEventSeq: 3, callId: 'call-1', toolName: 'bash', actionHash: hash('a'), classificationCatalogFingerprint: catalog.fingerprint, projectorId: 'default-v1' },
  environment: { version: 1, kind: 'native-header-only' },
}

function agent(overrides: object = {}) {
  const events = [
    { seq: 0, time: 100, type: 'request/header', data: { header: { tools: schemas } } },
    { seq: 1, time: 101, type: 'user/message', surfaceOp: 'append', data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'pwd' }] } },
    { seq: 2, time: 102, type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }] } } },
    { seq: 3, time: 103, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' } },
    { seq: 4, time: 104, type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } },
    { seq: 5, time: 105, type: 'tool/result', data: { turn: 1, step: 0, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'secret' }] } } },
  ]
  return {
    id: 'parent-1',
    options: {},
    session: {
      id: 'parent-1',
      header: { version: 0, id: 'parent-1', createdAt: 100 },
      snapshotEvents: () => events,
    },
    ...overrides,
  }
}

function input(overrides: object = {}) {
  return { agent: agent() as never, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash', classificationCatalog: catalog, executionFacts: [execution], approvalSnapshots: [approval], ...overrides }
}

// A legitimate mid-session catalog evolution: epoch A exposes only bash, then a
// dynamic mount adds read and the request/header at seq 5 starts epoch B.
const epochSchemasB = [...schemas, { name: 'read', description: 'read schema', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
const effectiveEpochB = createDshAlpha2EffectiveCatalog(epochSchemasB)
const epochCatalogB: DelegationToolClassificationCatalogV1 = effectiveEpochB.dossier
const epochCommitmentA = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
const epochCommitmentB = createDshAlpha2CatalogCommitment(effectiveEpochB, 'native', 5, epochSchemasB)
const epochEvents = [
  { seq: 0, time: 100, type: 'request/header', data: { header: { tools: schemas } } },
  { seq: 1, time: 101, type: 'user/message', surfaceOp: 'append', data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect' }] } },
  { seq: 2, time: 102, type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-old', name: 'bash', arguments: '{"command":"ls"}' }] } } },
  { seq: 3, time: 103, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-old', name: 'bash', arguments: '{"command":"ls"}' } },
  { seq: 4, time: 104, type: 'tool/result', sourceEventSeqs: [3], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-old' }, content: [{ type: 'tool-result', toolCallId: 'call-old', content: [{ type: 'text', text: 'out' }] }] } } },
  { seq: 5, time: 105, type: 'request/header', data: { header: { tools: epochSchemasB } } },
  { seq: 6, time: 106, type: 'assistant/message', data: { turn: 2, step: 0, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-new', name: 'bash', arguments: '{"command":"pwd"}' }] } } },
  { seq: 7, time: 107, type: 'tool/call', data: { turn: 2, step: 0, callId: 'call-new', name: 'bash', arguments: '{"command":"pwd"}' } },
  { seq: 8, time: 108, type: 'approval/asked', data: { id: 'ask-2', callId: 'call-new', toolName: 'bash', turn: 2, step: 0 } },
]
const epochOldExecution: ToolExecutionFactRecordV1 = {
  version: 1,
  catalogCommitment: epochCommitmentA,
  session: lifecycle,
  request: { kind: 'model-tool-call', eventSeq: 3, eventType: 'tool/call', callId: 'call-old', toolName: 'bash' },
  toolClassification: { classificationCatalogFingerprint: catalog.fingerprint, descriptor },
  projection: { projectorId: 'default-v1', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'ls' } }), actionHash: hash('b'), observedAt: 103 },
  result: { eventSeq: 4, eventType: 'tool/result', outcome: { kind: 'completed' } },
}
const epochNewExecution: ToolExecutionFactRecordV1 = {
  version: 1,
  catalogCommitment: epochCommitmentB,
  session: lifecycle,
  request: { kind: 'model-tool-call', eventSeq: 7, eventType: 'tool/call', callId: 'call-new', toolName: 'bash' },
  toolClassification: { classificationCatalogFingerprint: epochCatalogB.fingerprint, descriptor: epochCatalogB.descriptors.find(item => item.toolName === 'bash')! },
  projection: { projectorId: 'default-v1', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: hash('c'), observedAt: 107 },
}
const epochApproval: ApprovalSnapshotRecordV1 = {
  version: 1, session: lifecycle, approvalRequestId: 'ask-2', approvalAskedSeq: 8,
  execution: { requestEventSeq: 7, callId: 'call-new', toolName: 'bash', actionHash: hash('c'), classificationCatalogFingerprint: epochCatalogB.fingerprint, projectorId: 'default-v1' },
  environment: { version: 1, kind: 'native-header-only' },
}

function epochInput(overrides: object = {}) {
  return {
    agent: { ...agent(), session: { ...agent().session, snapshotEvents: () => epochEvents } } as never,
    approvalRequestId: 'ask-2',
    callId: 'call-new',
    toolName: 'bash',
    classificationCatalog: epochCatalogB,
    executionFacts: [epochOldExecution, epochNewExecution],
    approvalSnapshots: [epochApproval],
    ...overrides,
  }
}

describe('DshParentSessionFactSource', () => {
  it('binds the exact live session to its matching asked event and projections', () => {
    const requester = agent()
    const facts = new DshParentSessionFactSource({ get: id => id === 'parent-1' ? requester as never : undefined }).snapshot(input({ agent: requester as never }))
    expect(facts?.session.sessionId).toBe('parent-1')
    expect(facts?.approvalBinding.event.seq).toBe(4)
    expect(facts?.executionFacts).toEqual([execution])
    expect(facts?.approvalSnapshots).toEqual([approval])
    expect(facts?.events).toHaveLength(5)
    expect(facts?.events[1]).toMatchObject({ type: 'user/message', surfaceState: 'visible' })
    ;((requester.session.snapshotEvents()[1]!.data as { content: Array<{ text: string }> }).content[0]!).text = 'mutated after snapshot'
    expect(facts?.events[1]).toMatchObject({ data: { content: [{ text: 'pwd' }] } })
    const snapshotEvent = facts?.events[1]
    expect(snapshotEvent?.retention).toBe('included')
    if (snapshotEvent?.retention === 'included') expect(Object.isFrozen(snapshotEvent.data as object)).toBe(true)
  })

  it('marks a replaced direct user event superseded in the frozen source snapshot', () => {
    const requester = agent()
    ;(requester.session.snapshotEvents() as unknown as object[]).splice(2, 0, {
      seq: 2, time: 102, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [1],
      data: { id: 'user-2', source: { kind: 'user' }, content: [{ type: 'text', text: 'use ls instead' }] },
    })
    ;(requester.session.snapshotEvents() as unknown as Array<{ seq: number }>).forEach((event, sequence) => { event.seq = sequence })
    const shiftedExecution = { ...execution, request: { ...execution.request, eventSeq: 4 } }
    const shiftedApproval = {
      ...approval,
      approvalAskedSeq: 5,
      execution: { ...approval.execution, requestEventSeq: 4 },
    }
    const facts = new DshParentSessionFactSource({ get: () => requester as never }).snapshot(input({
      agent: requester as never,
      executionFacts: [shiftedExecution],
      approvalSnapshots: [shiftedApproval],
    }))
    expect(facts?.events[1]).toMatchObject({ type: 'user/message', surfaceState: 'superseded' })
    expect(facts?.events[2]).toMatchObject({ type: 'user/message', surfaceState: 'visible' })
  })

  it('detaches non-session facts from mutable repository and catalog inputs', () => {
    const requester = agent()
    const snapshotApproval = { ...approval, environment: { version: 1 as const, kind: 'native-header-only' as const } }
    const snapshotCatalog = { ...catalog, descriptors: [{ ...catalog.descriptors[0]! }] }
    const source = new DshParentSessionFactSource({ get: () => requester as never })
    const facts = source.snapshot(input({ agent: requester as never, approvalSnapshots: [snapshotApproval], classificationCatalog: snapshotCatalog }))
    ;(snapshotApproval.environment as { kind: string }).kind = 'after'
    ;(snapshotCatalog.descriptors[0] as { classificationId: string }).classificationId = 'after'
    expect(facts?.approvalSnapshots[0]).toMatchObject({ environment: { version: 1, kind: 'native-header-only' } })
    expect(facts?.eventProjection.classificationCatalog.descriptors[0]).toEqual(descriptor)
    expect(Object.isFrozen(facts?.approvalSnapshots[0]?.environment as object)).toBe(true)
  })

  it('preserves runtime delegation depth so a resumed child cannot appear root', () => {
    const requester = agent({ options: { subagentDepth: 1 } })
    const source = new DshParentSessionFactSource({ get: id => id === 'parent-1' ? requester as never : undefined })
    expect(source.snapshot(input({ agent: requester as never }))?.session).toMatchObject({
      runtimeSubagentDepth: 1,
      effectiveDelegationDepth: 1,
    })
    const invalid = agent({ options: { subagentDepth: -1 } })
    expect(new DshParentSessionFactSource({ get: () => invalid as never }).snapshot(input({ agent: invalid as never }))).toBeUndefined()
    const invalidHeader = agent()
    ;(invalidHeader.session.header as unknown as { delegationDepth?: unknown }).delegationDepth = -0
    expect(new DshParentSessionFactSource({ get: () => invalidHeader as never }).snapshot(input({ agent: invalidHeader as never }))).toBeUndefined()
  })

  it('refuses an ambiguous call or a projection bound to a different durable event', () => {
    const requester = agent()
    const source = new DshParentSessionFactSource({ get: id => id === 'parent-1' ? requester as never : undefined })
    const duplicate = agent()
    ;(duplicate.session.snapshotEvents() as unknown as object[]).splice(3, 0, {
      seq: 3, time: 103, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
    })
    ;(duplicate.session.snapshotEvents() as unknown as Array<{ seq: number }>).forEach((event, index) => { event.seq = index })
    expect(source.snapshot(input({ agent: duplicate as never }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, executionFacts: [{ ...execution, request: { ...execution.request, eventSeq: 1 } }] }))).toBeUndefined()
  })

  it('drops durable execution facts whose result event does not bind the request event', () => {
    const requester = agent()
    const source = new DshParentSessionFactSource({ get: id => id === 'parent-1' ? requester as never : undefined })
    // A poisoned sidecar claims seq 4 (approval/asked) is its tool/result.
    const poisoned = {
      ...execution,
      result: { eventSeq: 4, eventType: 'tool/result' as const, outcome: { kind: 'completed' as const } },
    }
    expect(source.snapshot(input({ agent: requester as never, executionFacts: [poisoned] }))).toBeUndefined()
  })

  it('refuses mismatched ids, missing asks, conflicting projections, and unknown agents', () => {
    const requester = agent()
    const source = new DshParentSessionFactSource({ get: id => id === 'parent-1' ? requester as never : undefined })
    expect(source.snapshot(input({ agent: agent({ session: { ...agent().session, id: 'other' } }) as never }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, approvalRequestId: 'other' }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, approvalSnapshots: [{ ...approval, approvalRequestId: 'other' }] }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, approvalSnapshots: [{ ...approval, execution: { ...approval.execution, actionHash: hash('b') } }] }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, approvalSnapshots: [{ ...approval, environment: { version: 1, kind: 'native-header-only', sandbox: { enabled: true } } }] as never }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, executionFacts: [{ ...execution, session: { ...lifecycle, cwd: '/other-project' } } as ToolExecutionFactRecordV1] }))).toBeUndefined()
    const regressive = agent()
    ;(regressive.session.snapshotEvents() as unknown as Array<{ time: number }>)[2]!.time = 99
    expect(source.snapshot(input({ agent: regressive as never }))).toBeUndefined()
    const negativeZeroSequence = agent()
    ;(negativeZeroSequence.session.snapshotEvents() as unknown as Array<{ seq: number }>)[0]!.seq = -0
    expect(source.snapshot(input({ agent: negativeZeroSequence as never }))).toBeUndefined()
    const invalidSourceSequence = agent()
    ;(invalidSourceSequence.session.snapshotEvents() as unknown as Array<{ sourceEventSeqs?: readonly number[] }>)[2]!.sourceEventSeqs = [-0]
    expect(source.snapshot(input({ agent: invalidSourceSequence as never }))).toBeUndefined()
    const emptyCwd = agent()
    ;(emptyCwd.session.header as unknown as { cwd?: unknown }).cwd = ''
    expect(new DshParentSessionFactSource({ get: () => emptyCwd as never }).snapshot(input({ agent: emptyCwd as never }))).toBeUndefined()
    expect(new DshParentSessionFactSource({ get: () => undefined }).snapshot(input({ agent: requester as never }))).toBeUndefined()
  })

  it('accepts a legitimate mid-session catalog epoch change', () => {
    const request = epochInput()
    const facts = new DshParentSessionFactSource({ get: () => request.agent as never }).snapshot(request)
    expect(facts?.session.sessionId).toBe('parent-1')
    expect(facts?.approvalBinding.event.seq).toBe(8)
    expect(facts?.executionFacts).toHaveLength(2)
    expect(facts?.eventProjection.classificationCatalog).toEqual(epochCatalogB)
  })

  it('refuses an execution that shops an obsolete catalog header', () => {
    // The pending call binds the retired epoch-A header even though epoch B
    // was already in force before its root call event.
    const staleExecution: ToolExecutionFactRecordV1 = {
      ...epochNewExecution,
      catalogCommitment: epochCommitmentA,
      toolClassification: { classificationCatalogFingerprint: catalog.fingerprint, descriptor },
    }
    const staleApproval: ApprovalSnapshotRecordV1 = {
      ...epochApproval,
      execution: { ...epochApproval.execution, classificationCatalogFingerprint: catalog.fingerprint },
    }
    const request = epochInput({ executionFacts: [epochOldExecution, staleExecution], approvalSnapshots: [staleApproval] })
    expect(new DshParentSessionFactSource({ get: () => request.agent as never })
      .snapshot(request))
      .toBeUndefined()
  })

  it('refuses split commitments within one header epoch', () => {
    // Same header seq, but one record's classification catalog was rewritten
    // (same schema fingerprints, different classificationId) and re-committed.
    const shiftedUnsealed = {
      version: 1 as const,
      eventProjectionPolicyId: 'dsh-session-facts-v1' as const,
      argumentSemanticsId: catalog.argumentSemanticsId,
      fingerprint: '',
      descriptors: catalog.descriptors.map(item => ({ ...item, classificationId: 'class-shifted' })),
    }
    const shiftedCatalog = { ...shiftedUnsealed, fingerprint: fingerprintDelegationToolCatalogV1(shiftedUnsealed)! }
    const shiftedCommitment = createDshAlpha2CatalogCommitment(
      { schemas, approval: effective.approval, dossier: shiftedCatalog },
      'native', 0, schemas,
    )
    const singleHeaderEvents = epochEvents.filter((_, index) => index !== 5)
      .map((event, seq) => ({ ...event, seq }))
    const splitExecution: ToolExecutionFactRecordV1 = {
      ...epochNewExecution,
      catalogCommitment: shiftedCommitment,
      toolClassification: { classificationCatalogFingerprint: shiftedCatalog.fingerprint, descriptor: shiftedCatalog.descriptors[0]! },
      request: { kind: 'model-tool-call', eventSeq: 6, eventType: 'tool/call', callId: 'call-new', toolName: 'bash' },
    }
    const splitApproval: ApprovalSnapshotRecordV1 = {
      ...epochApproval,
      approvalAskedSeq: 7,
      execution: { ...epochApproval.execution, requestEventSeq: 6, classificationCatalogFingerprint: shiftedCatalog.fingerprint },
    }
    const requester = { ...agent(), session: { ...agent().session, snapshotEvents: () => singleHeaderEvents } }
    const request = epochInput({
      agent: requester as never,
      executionFacts: [epochOldExecution, splitExecution],
      approvalSnapshots: [splitApproval],
    })
    expect(new DshParentSessionFactSource({ get: () => request.agent as never })
      .snapshot(request))
      .toBeUndefined()
  })

  it('fails closed when the ledger is absent, empty, polluted, or no longer matches live facts', async () => {
    const requester = agent()
    const base = { agent: requester as never, registry: { get: () => requester as never }, executionFacts: { async get() { return undefined } }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' }
    expect(await readSealedParentSessionFacts({ ...base, ledger: undefined })).toBeUndefined()
    expect(await readSealedParentSessionFacts({ ...base, ledger: { async append() { return 'unavailable' as const }, async read() { return [] } } })).toBeUndefined()
    expect(await readSealedParentSessionFacts({ ...base, ledger: { async append() { return 'unavailable' as const }, async read() { return undefined } } })).toBeUndefined()
  })

})

const sealedHash = (char: string) => 'sha256:' + char.repeat(64)
type SealedRow = { readonly seal: SealV1; readonly activity: ActivityV1 }
function sealedReaderFixture() {
  const events: any[] = [
    { seq: 0, time: 100, type: 'request/header', data: { header: { tools: schemas } } },
    { seq: 1, time: 101, type: 'tool/call', data: { callId: 'call-old', name: 'bash' } },
    { seq: 2, time: 102, type: 'approval/asked', data: { id: 'ask-old', callId: 'call-old', toolName: 'bash' } },
    { seq: 3, time: 103, type: 'tool/result', sourceEventSeqs: [1], data: { message: { source: { kind: 'tool', callId: 'call-old' }, content: [{ type: 'tool-result', toolCallId: 'call-old' }] } } },
    { seq: 4, time: 104, type: 'request/header', data: { header: { tools: schemas } } },
    { seq: 5, time: 105, type: 'tool/call', data: { callId: 'call-mid', name: 'bash' } },
    { seq: 6, time: 106, type: 'approval/asked', data: { id: 'ask-mid', callId: 'call-mid', toolName: 'bash' } },
    { seq: 7, time: 107, type: 'tool/result', sourceEventSeqs: [5], data: { message: { source: { kind: 'tool', callId: 'call-mid' }, content: [{ type: 'tool-result', toolCallId: 'call-mid' }] } } },
    { seq: 8, time: 108, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
    { seq: 9, time: 109, type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash' } },
    { seq: 10, time: 110, type: 'tool/result', sourceEventSeqs: [8], data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1' }] } } },
  ]
  const requester = { id: 'parent-1', options: {}, session: { id: 'parent-1', header: { version: 0, id: 'parent-1', createdAt: 100 }, snapshotEvents: () => events } }
  const fingerprint = canonicalJson(lifecycle)
  const commitments = new Map([
    [0, createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)],
    [4, createDshAlpha2CatalogCommitment(effective, 'native', 4, schemas)],
  ])
  const make = (sourceSeq: number, askedSeq: number, resultSeq: number, callId: string, requestId: string, previousSealHash: string, epoch: number, headerEventSeq: number): SealedRow => {
    const seal = createSealV1({ lifecycleFingerprint: fingerprint, sourceSeq, request: { eventSeq: sourceSeq, eventType: 'tool/call', callId, toolName: 'bash' }, approvalAsked: { eventSeq: askedSeq, requestId }, actionHash: sealedHash('a'), projectorId: 'default-v1', catalog: { epoch, headerEventSeq, commitment: commitments.get(headerEventSeq)!.fingerprint }, wireSchemaFingerprint: sealedHash('d'), result: { eventSeq: resultSeq, status: 'completed' }, epochBoundary: { previousEpoch: sourceSeq === 1 ? null : sourceSeq === 5 ? 0 : 1, changed: sourceSeq === 5 }, previousSealHash })
    return { seal, activity: createActivityV1({ lifecycleFingerprint: fingerprint, sourceSeq, occurredAt: events[resultSeq]!.time, classification: 'ordinary', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: seal.sealHash }) }
  }
  const first = make(1, 2, 3, 'call-old', 'ask-old', genesisSealHash(fingerprint), 0, 0)
  const second = make(5, 6, 7, 'call-mid', 'ask-mid', first.seal.sealHash, 1, 4)
  const third = make(8, 9, 10, 'call-1', 'ask-1', second.seal.sealHash, 1, 4)
  const rows = [first, second, third] as SealedRow[]
  const executionFacts = { async get(input: { callId: string; requestEventSeq: number }) {
    const row = rows.find(candidate => candidate.seal.request.callId === input.callId && candidate.seal.request.eventSeq === input.requestEventSeq)
    if (row === undefined) return undefined
    const seal = row.seal
    return { ...execution, session: lifecycle, request: { kind: 'model-tool-call', eventSeq: seal.request.eventSeq, eventType: seal.request.eventType, callId: seal.request.callId, toolName: seal.request.toolName }, catalogCommitment: commitments.get(seal.catalog.headerEventSeq)! } as ToolExecutionFactRecordV1
  } }
  const base = { agent: requester as never, registry: { get: (id: string) => id === 'parent-1' ? requester as never : undefined }, executionFacts, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' }
  return { events, rows, base }
}
function ledger(rows: readonly SealedRow[] | undefined) { return { async append() { return 'unavailable' as const }, async read() { return rows } } }
function reseal(seal: SealV1, changes: object): SealV1 { const { version: _version, sealHash: _sealHash, canonical: _canonical, ...input } = seal; return createSealV1({ ...input, ...changes }) }
function reactivate(seal: SealV1, activity: ActivityV1, changes: object = {}): ActivityV1 { const { version: _version, canonical: _canonical, ...input } = activity; return createActivityV1({ ...input, ...changes, sourceSealHash: seal.sealHash }) }

describe('readSealedParentSessionFacts', () => {
  it('returns a complete, live-rebound multi-seal fact chain', async () => {
    const fixture = sealedReaderFixture()
    const facts = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(facts).toMatchObject({ version: 1, lifecycleFingerprint: canonicalJson(lifecycle), current: { seal: { sourceSeq: 8 }, activity: { occurredAt: 110 } } })
    expect(facts?.seals).toHaveLength(3); expect(facts?.activities).toHaveLength(3)
    expect(facts?.catalogEpochs).toEqual([{ epoch: 0, headerEventSeq: 0, commitment: fixture.rows[0]!.seal.catalog.commitment }, { epoch: 1, headerEventSeq: 4, commitment: fixture.rows[1]!.seal.catalog.commitment }])
  })
  it('rebinds a complete code-dispatch sealed row', async () => {
    const fixture = sealedReaderFixture()
    fixture.events[8] = { ...fixture.events[8], type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'parent-1', subCallId: 'call-1', name: 'bash' } }
    fixture.events[10] = { ...fixture.events[10], type: 'tool/code-dispatch', data: { rootCallId: 'root-1', parentCallId: 'parent-1', subCallId: 'call-1', name: 'bash' } }
    const old = fixture.rows[2]!.seal
    const { version: _version, sealHash: _sealHash, canonical: _canonical, ...input } = old
    const seal = createSealV1({ ...input, request: { ...old.request, eventType: 'tool/code-dispatch-start' } })
    fixture.rows[2] = { seal, activity: createActivityV1({ lifecycleFingerprint: old.lifecycleFingerprint, sourceSeq: old.sourceSeq, occurredAt: 110, classification: 'ordinary', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: seal.sealHash }) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ current: { seal: { request: { eventType: 'tool/code-dispatch-start' } } } })
  })
  it('distinguishes missing, polluted, and empty ledger reads by failing closed', async () => {
    const fixture = sealedReaderFixture()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: undefined })).resolves.toBeUndefined()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(undefined) })).resolves.toBeUndefined()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger([]) })).resolves.toBeUndefined()
  })
  it('fails closed on a self-consistent disconnected seal chain', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[1]!
    const seal = reseal(old.seal, { previousSealHash: sealedHash('f') })
    fixture.rows[1] = { seal, activity: reactivate(seal, old.activity) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })
  it.each([
    ['first boundary', (f: ReturnType<typeof sealedReaderFixture>) => {
      const old = f.rows[0]!; const seal = reseal(old.seal, { epochBoundary: { previousEpoch: null, changed: true } })
      f.rows[0] = { seal, activity: reactivate(seal, old.activity) }
      const next = f.rows[1]!; const resealed = reseal(next.seal, { previousSealHash: seal.sealHash })
      f.rows[1] = { seal: resealed, activity: reactivate(resealed, next.activity) }
      const last = f.rows[2]!; const relinked = reseal(last.seal, { previousSealHash: resealed.sealHash })
      f.rows[2] = { seal: relinked, activity: reactivate(relinked, last.activity) }
    }],
    ['changed boundary', (f: ReturnType<typeof sealedReaderFixture>) => {
      const old = f.rows[1]!; const seal = reseal(old.seal, { epochBoundary: { previousEpoch: 0, changed: false } })
      f.rows[1] = { seal, activity: reactivate(seal, old.activity) }
      const last = f.rows[2]!; const relinked = reseal(last.seal, { previousSealHash: seal.sealHash })
      f.rows[2] = { seal: relinked, activity: reactivate(relinked, last.activity) }
    }],
    ['epoch rollback', (f: ReturnType<typeof sealedReaderFixture>) => {
      const old = f.rows[2]!; const seal = reseal(old.seal, { catalog: { epoch: 0, headerEventSeq: 0, commitment: sealedHash('b') }, epochBoundary: { previousEpoch: 1, changed: true } })
      f.rows[2] = { seal, activity: reactivate(seal, old.activity) }
    }],
  ] as const)('fails closed on rehashed forged epoch topology: %s', async (_name, mutate) => {
    const fixture = sealedReaderFixture(); mutate(fixture)
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })

  it('fails closed on a self-consistent inflated epoch transition', async () => {
    const fixture = sealedReaderFixture()
    const middle = fixture.rows[1]!, middleSeal = reseal(middle.seal, { catalog: { ...middle.seal.catalog, epoch: 5 }, epochBoundary: { previousEpoch: 0, changed: true } })
    fixture.rows[1] = { seal: middleSeal, activity: reactivate(middleSeal, middle.activity) }
    const last = fixture.rows[2]!, lastSeal = reseal(last.seal, { catalog: { ...last.seal.catalog, epoch: 5 }, epochBoundary: { previousEpoch: 5, changed: false }, previousSealHash: middleSeal.sealHash })
    fixture.rows[2] = { seal: lastSeal, activity: reactivate(lastSeal, last.activity) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })

  it.each([
    ['rehashed seal commitment detached from fact', async (f: ReturnType<typeof sealedReaderFixture>) => {
      const middle = f.rows[1]!, middleSeal = reseal(middle.seal, { catalog: { ...middle.seal.catalog, commitment: sealedHash('e') } })
      f.rows[1] = { seal: middleSeal, activity: reactivate(middleSeal, middle.activity) }
      const last = f.rows[2]!, lastSeal = reseal(last.seal, { catalog: { ...last.seal.catalog, commitment: sealedHash('e') }, previousSealHash: middleSeal.sealHash })
      f.rows[2] = { seal: lastSeal, activity: reactivate(lastSeal, last.activity) }
    }],
    ['rewritten live header tools', async (f: ReturnType<typeof sealedReaderFixture>) => {
      f.events[4] = { ...f.events[4], data: { header: { tools: [{ ...schemas[0], name: 'other' }] } } }
    }],
  ] as const)('fails closed on self-consistent live commitment forgery: %s', async (_name, mutate) => {
    const fixture = sealedReaderFixture(); await mutate(fixture)
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })

  it('fails closed when a durable commitment does not validate', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[2]!
    const invalidFingerprint = sealedHash('e')
    const seal = reseal(old.seal, { catalog: { ...old.seal.catalog, epoch: 2, commitment: invalidFingerprint }, epochBoundary: { previousEpoch: 1, changed: true } })
    fixture.rows[2] = { seal, activity: reactivate(seal, old.activity) }
    const executionFacts = { async get(input: { callId: string; requestEventSeq: number }) {
      const fact = await fixture.base.executionFacts.get(input)
      return fact === undefined ? undefined : { ...fact, catalogCommitment: { ...fact.catalogCommitment, fingerprint: invalidFingerprint } }
    } }
    await expect(readSealedParentSessionFacts({ ...fixture.base, executionFacts, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })

  it('fails closed rather than throwing for null live event data', async () => {
    const fixture = sealedReaderFixture(); fixture.events[8] = { ...fixture.events[8], data: null }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })

  it('fails closed on self-consistent non-monotonic source sequence', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[1]!
    const seal = reseal(old.seal, { sourceSeq: 1, request: { ...old.seal.request, eventSeq: 1 }, previousSealHash: fixture.rows[0]!.seal.sealHash })
    fixture.rows[1] = { seal, activity: reactivate(seal, old.activity, { sourceSeq: 1 }) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })
  it.each([
    ['activity source seal hash', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[2]!; const { version: _version, canonical: _canonical, ...input } = old.activity; f.rows[2] = { ...old, activity: createActivityV1({ ...input, sourceSealHash: sealedHash('f') }) } }],
    ['activity occurredAt', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[2]!; f.rows[2] = { ...old, activity: reactivate(old.seal, old.activity, { occurredAt: 999 }) } }],
    ['activity result category', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[2]!; f.rows[2] = { ...old, activity: reactivate(old.seal, old.activity, { resultCategory: 'tool-error' }) } }],
  ] as const)('fails closed when self-consistent activity rebinding rejects %s', async (_name, mutate) => {
    const fixture = sealedReaderFixture(); mutate(fixture)
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })
  it.each([
    ['request callId', (f: ReturnType<typeof sealedReaderFixture>) => { f.events[8].data.callId = 'other' }],
    ['request toolName', (f: ReturnType<typeof sealedReaderFixture>) => { f.events[8].data.name = 'other' }],
    ['asked requestId', (f: ReturnType<typeof sealedReaderFixture>) => { f.events[9].data.id = 'other' }],
    ['result source seq', (f: ReturnType<typeof sealedReaderFixture>) => { f.events[10].sourceEventSeqs[0] = 5 }],
    ['result status shape', (f: ReturnType<typeof sealedReaderFixture>) => { f.events[10].data.message.source.kind = 'other' }],
    ['header event type', (f: ReturnType<typeof sealedReaderFixture>) => { f.events[4].type = 'other/header' }],
    ['header epoch commitment', (f: ReturnType<typeof sealedReaderFixture>) => { (f.rows[2]!.seal.catalog as any).commitment = sealedHash('e') }],
    ['activity occurredAt', (f: ReturnType<typeof sealedReaderFixture>) => { f.rows[2] = { ...f.rows[2]!, activity: { ...f.rows[2]!.activity, occurredAt: 999 } as ActivityV1 } }],
    ['activity classification', (f: ReturnType<typeof sealedReaderFixture>) => { f.rows[2] = { ...f.rows[2]!, activity: { ...f.rows[2]!.activity, classification: 'other' } as ActivityV1 } }],
  ] as const)('fails closed when live rebinding rejects %s', async (_name, mutate) => {
    const fixture = sealedReaderFixture(); mutate(fixture)
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toBeUndefined()
  })
  it('fails closed when cancelled before or after ledger read', async () => {
    const fixture = sealedReaderFixture(); const before = new AbortController(); before.abort()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows), signal: before.signal })).resolves.toBeUndefined()
    const after = new AbortController()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: { async append() { return 'unavailable' as const }, async read() { after.abort(); return fixture.rows } }, signal: after.signal })).resolves.toBeUndefined()
  })
})
