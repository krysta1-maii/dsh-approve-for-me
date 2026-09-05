import { describe, expect, it } from 'vitest'
import { deriveRequesterDepthV1, DshParentSessionFactSource, activityClassificationFromDescriptorV1, canonicalJson, createActionSnapshot, createActivityV1, createSealV1, fingerprintDelegationToolCatalogV1, genesisSealHash, readSealedParentSessionFacts } from '../../src/index.js'
import type { ActivityV1, SealV1, SealedFactsReadResult, SealedParentSessionFactsV1 } from '../../src/index.js'
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
      get seq() { return events.length - 1 },
      eventAt: (seq: number) => events[seq],
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
    await expect(readSealedParentSessionFacts({ ...base, ledger: undefined })).resolves.toMatchObject({ kind: 'unavailable' })
    await expect(readSealedParentSessionFacts({ ...base, ledger: { async append() { return 'unavailable' as const }, async read() { return [] } } })).resolves.toMatchObject({ kind: 'empty-ledger' })
    await expect(readSealedParentSessionFacts({ ...base, ledger: { async append() { return 'unavailable' as const }, async read() { return undefined } } })).resolves.toMatchObject({ kind: 'unavailable' })
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
  const requester = { id: 'parent-1', options: {}, session: { id: 'parent-1', header: { version: 0, id: 'parent-1', createdAt: 100 }, snapshotEvents: () => events, get seq() { return events.length - 1 }, eventAt: (seq: number) => events[seq] } }
  const fingerprint = canonicalJson(lifecycle)
  const commitments = new Map([
    [0, createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)],
    [4, createDshAlpha2CatalogCommitment(effective, 'native', 4, schemas)],
  ])
  const make = (sourceSeq: number, askedSeq: number, resultSeq: number, callId: string, requestId: string, previousSealHash: string, epoch: number, headerEventSeq: number): SealedRow => {
    const seal = createSealV1({ lifecycleFingerprint: fingerprint, sourceSeq, request: { eventSeq: sourceSeq, eventType: 'tool/call', callId, toolName: 'bash' }, approvalAsked: { eventSeq: askedSeq, requestId }, actionHash: sealedHash('a'), projectorId: 'default-v1', catalog: { epoch, headerEventSeq, commitment: commitments.get(headerEventSeq)!.fingerprint }, wireSchemaFingerprint: sealedHash('d'), result: { eventSeq: resultSeq, status: 'completed' }, epochBoundary: { previousEpoch: sourceSeq === 1 ? null : sourceSeq === 5 ? 0 : 1, changed: sourceSeq === 5 }, previousSealHash })
    return { seal, activity: createActivityV1({ lifecycleFingerprint: fingerprint, sourceSeq, occurredAt: events[resultSeq]!.time, classification: 'approval-class:body-escalation', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: seal.sealHash }) }
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


function buildSealedChain(count: number) {
  const events: any[] = [{ seq: 0, time: 100, type: 'request/header', data: { header: { tools: schemas } } }]
  const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
  const rows: SealedRow[] = []
  let previousSealHash = genesisSealHash(canonicalJson(lifecycle))
  for (let i = 1; i <= count; i += 1) {
    const requestSeq = 3 * i - 2
    const askedSeq = 3 * i - 1
    const resultSeq = 3 * i
    const callId = 'call-' + i
    const requestId = 'ask-' + i
    events.push({ seq: requestSeq, time: 100 + requestSeq, type: 'tool/call', data: { callId, name: 'bash' } })
    events.push({ seq: askedSeq, time: 100 + askedSeq, type: 'approval/asked', data: { id: requestId, callId, toolName: 'bash' } })
    events.push({ seq: resultSeq, time: 100 + resultSeq, type: 'tool/result', sourceEventSeqs: [requestSeq], data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId }] } } })
    const seal = createSealV1({
      lifecycleFingerprint: canonicalJson(lifecycle), sourceSeq: requestSeq,
      request: { eventSeq: requestSeq, eventType: 'tool/call', callId, toolName: 'bash' },
      approvalAsked: { eventSeq: askedSeq, requestId },
      actionHash: sealedHash('a'), projectorId: 'default-v1',
      catalog: { epoch: 0, headerEventSeq: 0, commitment: commitment.fingerprint },
      wireSchemaFingerprint: sealedHash('d'),
      result: { eventSeq: resultSeq, status: 'completed' },
      epochBoundary: { previousEpoch: i === 1 ? null : 0, changed: false },
      previousSealHash,
    })
    const activity = createActivityV1({ lifecycleFingerprint: canonicalJson(lifecycle), sourceSeq: requestSeq, occurredAt: 100 + resultSeq, classification: 'approval-class:body-escalation', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: seal.sealHash })
    rows.push({ seal, activity })
    previousSealHash = seal.sealHash
  }
  const requester = { id: 'parent-1', options: {}, session: { id: 'parent-1', header: { version: 0, id: 'parent-1', createdAt: 100 }, get seq() { return events.length - 1 }, eventAt: (seq: number) => events[seq] } }
  const executionFacts = { async get(input: { callId: string; requestEventSeq: number }) {
    const row = rows.find(candidate => candidate.seal.request.callId === input.callId && candidate.seal.request.eventSeq === input.requestEventSeq)
    if (row === undefined) return undefined
    const seal = row.seal
    return { ...execution, session: lifecycle, request: { kind: 'model-tool-call' as const, eventSeq: seal.request.eventSeq, eventType: seal.request.eventType, callId: seal.request.callId, toolName: seal.request.toolName }, catalogCommitment: commitment } as ToolExecutionFactRecordV1
  } }
  const last = rows[count - 1]!.seal
  const base = { agent: requester as never, registry: { get: (id: string) => id === 'parent-1' ? requester as never : undefined }, executionFacts, approvalRequestId: last.approvalAsked.requestId, callId: last.request.callId, toolName: last.request.toolName }
  return { events, rows, base }
}

function okFacts(result: SealedFactsReadResult): SealedParentSessionFactsV1 {
  if (result.kind !== 'ok') throw new Error('expected an ok sealed-facts result, got ' + result.kind)
  return result.facts
}

// Builds a disk-valid single/multi-epoch seal chain with a controlled live event
// array, so a rogue request/header can be dropped into a scan window that no
// seal references (the reviewer's differential probe for the intervening-header
// guard). Epoch/commitment are derived from headerEventSeq so the chain stays
// genesis->tip valid while the live events may diverge from the chain topology.
function buildSpoofChain(seals: Array<{ sourceSeq: number; askedSeq: number; resultSeq: number; headerEventSeq: number; callId: string; requestId: string }>, rogueHeaders: readonly number[] = []) {
  const events: any[] = []
  const commitmentByHeader = new Map<number, ReturnType<typeof createDshAlpha2CatalogCommitment>>()
  const commitmentFor = (headerEventSeq: number) => {
    let commitment = commitmentByHeader.get(headerEventSeq)
    if (commitment === undefined) {
      commitment = createDshAlpha2CatalogCommitment(effective, 'native', headerEventSeq, schemas)
      commitmentByHeader.set(headerEventSeq, commitment)
    }
    return commitment
  }
  events[0] = { seq: 0, time: 100, type: 'request/header', data: { header: { tools: schemas } } }
  const rows: SealedRow[] = []
  let previousSealHash = genesisSealHash(canonicalJson(lifecycle))
  let previousEpoch: number | undefined = undefined
  let previousCommitment: string | undefined = undefined
  let epoch = 0
  for (const seal of seals) {
    const commitment = commitmentFor(seal.headerEventSeq)
    const changed = previousCommitment !== undefined && commitment.fingerprint !== previousCommitment
    if (changed) epoch += 1
    const sealRow = createSealV1({
      lifecycleFingerprint: canonicalJson(lifecycle), sourceSeq: seal.sourceSeq,
      request: { eventSeq: seal.sourceSeq, eventType: 'tool/call', callId: seal.callId, toolName: 'bash' },
      approvalAsked: { eventSeq: seal.askedSeq, requestId: seal.requestId },
      actionHash: sealedHash('a'), projectorId: 'default-v1',
      catalog: { epoch, headerEventSeq: seal.headerEventSeq, commitment: commitment.fingerprint },
      wireSchemaFingerprint: sealedHash('d'),
      result: { eventSeq: seal.resultSeq, status: 'completed' },
      epochBoundary: { previousEpoch: previousEpoch === undefined ? null : previousEpoch, changed: previousEpoch === undefined ? false : changed },
      previousSealHash,
    })
    const activity = createActivityV1({ lifecycleFingerprint: canonicalJson(lifecycle), sourceSeq: seal.sourceSeq, occurredAt: 100 + seal.resultSeq, classification: 'approval-class:body-escalation', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: sealRow.sealHash })
    rows.push({ seal: sealRow, activity })
    events[seal.sourceSeq] = { seq: seal.sourceSeq, time: 100 + seal.sourceSeq, type: 'tool/call', data: { callId: seal.callId, name: 'bash' } }
    events[seal.askedSeq] = { seq: seal.askedSeq, time: 100 + seal.askedSeq, type: 'approval/asked', data: { id: seal.requestId, callId: seal.callId, toolName: 'bash' } }
    events[seal.resultSeq] = { seq: seal.resultSeq, time: 100 + seal.resultSeq, type: 'tool/result', sourceEventSeqs: [seal.sourceSeq], data: { message: { source: { kind: 'tool', callId: seal.callId }, content: [{ type: 'tool-result', toolCallId: seal.callId }] } } }
    previousSealHash = sealRow.sealHash
    previousEpoch = epoch
    previousCommitment = commitment.fingerprint
  }
  for (const headerSeq of commitmentByHeader.keys()) {
    if (headerSeq !== 0 && events[headerSeq] === undefined) events[headerSeq] = { seq: headerSeq, time: 100 + headerSeq, type: 'request/header', data: { header: { tools: schemas } } }
  }
  for (const seq of rogueHeaders) events[seq] = { seq, time: 100 + seq, type: 'request/header', data: { header: { tools: schemas } } }
  const requester = { id: 'parent-1', options: {}, session: { id: 'parent-1', header: { version: 0, id: 'parent-1', createdAt: 100 }, get seq() { return events.length - 1 }, eventAt: (seq: number) => events[seq] } }
  const executionFacts = { async get(input: { callId: string; requestEventSeq: number }) {
    const row = rows.find(candidate => candidate.seal.request.callId === input.callId && candidate.seal.request.eventSeq === input.requestEventSeq)
    if (row === undefined) return undefined
    const seal = row.seal
    return { ...execution, session: lifecycle, request: { kind: 'model-tool-call' as const, eventSeq: seal.request.eventSeq, eventType: seal.request.eventType, callId: seal.request.callId, toolName: seal.request.toolName }, catalogCommitment: commitmentFor(seal.catalog.headerEventSeq) } as ToolExecutionFactRecordV1
  } }
  const last = rows[rows.length - 1]!.seal
  const base = { agent: requester as never, registry: { get: (id: string) => id === 'parent-1' ? requester as never : undefined }, executionFacts, approvalRequestId: last.approvalAsked.requestId, callId: last.request.callId, toolName: last.request.toolName }
  return { events, rows, base }
}

describe('readSealedParentSessionFacts', () => {
  it('returns a complete, live-rebound multi-seal fact chain', async () => {
    const fixture = sealedReaderFixture()
    const facts = okFacts(await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) }))
    expect(facts).toMatchObject({ version: 1, lifecycleFingerprint: canonicalJson(lifecycle), current: { seal: { sourceSeq: 8 }, activity: { occurredAt: 110 } } })
    expect(facts.seals).toHaveLength(3); expect(facts.activities).toHaveLength(3)
    expect(facts.catalogEpochs).toEqual([{ epoch: 0, headerEventSeq: 0, commitment: fixture.rows[0]!.seal.catalog.commitment }, { epoch: 1, headerEventSeq: 4, commitment: fixture.rows[1]!.seal.catalog.commitment }])
  })
  it('rebinds a complete code-dispatch sealed row', async () => {
    const fixture = sealedReaderFixture()
    fixture.events[8] = { ...fixture.events[8], type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'parent-1', subCallId: 'call-1', name: 'bash' } }
    fixture.events[10] = { ...fixture.events[10], type: 'tool/code-dispatch', data: { rootCallId: 'root-1', parentCallId: 'parent-1', subCallId: 'call-1', name: 'bash' } }
    const old = fixture.rows[2]!.seal
    const { version: _version, sealHash: _sealHash, canonical: _canonical, ...input } = old
    const seal = createSealV1({ ...input, request: { ...old.request, eventType: 'tool/code-dispatch-start' } })
    fixture.rows[2] = { seal, activity: createActivityV1({ lifecycleFingerprint: old.lifecycleFingerprint, sourceSeq: old.sourceSeq, occurredAt: 110, classification: 'approval-class:body-escalation', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: seal.sealHash }) }
    expect(okFacts(await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) }))).toMatchObject({ current: { seal: { request: { eventType: 'tool/code-dispatch-start' } } } })
  })
  it('distinguishes missing, polluted, and empty ledger reads by failing closed', async () => {
    const fixture = sealedReaderFixture()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: undefined })).resolves.toMatchObject({ kind: 'unavailable' })
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(undefined) })).resolves.toMatchObject({ kind: 'unavailable' })
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger([]) })).resolves.toMatchObject({ kind: 'empty-ledger' })
  })
  it('fails closed on a self-consistent disconnected seal chain', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[1]!
    const seal = reseal(old.seal, { previousSealHash: sealedHash('f') })
    fixture.rows[1] = { seal, activity: reactivate(seal, old.activity) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
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
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed on a self-consistent inflated epoch transition', async () => {
    const fixture = sealedReaderFixture()
    const middle = fixture.rows[1]!, middleSeal = reseal(middle.seal, { catalog: { ...middle.seal.catalog, epoch: 5 }, epochBoundary: { previousEpoch: 0, changed: true } })
    fixture.rows[1] = { seal: middleSeal, activity: reactivate(middleSeal, middle.activity) }
    const last = fixture.rows[2]!, lastSeal = reseal(last.seal, { catalog: { ...last.seal.catalog, epoch: 5 }, epochBoundary: { previousEpoch: 5, changed: false }, previousSealHash: middleSeal.sealHash })
    fixture.rows[2] = { seal: lastSeal, activity: reactivate(lastSeal, last.activity) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
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
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
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
    await expect(readSealedParentSessionFacts({ ...fixture.base, executionFacts, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed rather than throwing for null live event data', async () => {
    const fixture = sealedReaderFixture(); fixture.events[8] = { ...fixture.events[8], data: null }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed on self-consistent non-monotonic source sequence', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[1]!
    const seal = reseal(old.seal, { sourceSeq: 1, request: { ...old.seal.request, eventSeq: 1 }, previousSealHash: fixture.rows[0]!.seal.sealHash })
    fixture.rows[1] = { seal, activity: reactivate(seal, old.activity, { sourceSeq: 1 }) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })
  it.each([
    ['activity source seal hash', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[2]!; const { version: _version, canonical: _canonical, ...input } = old.activity; f.rows[2] = { ...old, activity: createActivityV1({ ...input, sourceSealHash: sealedHash('f') }) } }],
    ['activity occurredAt', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[2]!; f.rows[2] = { ...old, activity: reactivate(old.seal, old.activity, { occurredAt: 999 }) } }],
    ['activity result category', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[2]!; f.rows[2] = { ...old, activity: reactivate(old.seal, old.activity, { resultCategory: 'tool-error' }) } }],
  ] as const)('fails closed when self-consistent activity rebinding rejects %s', async (_name, mutate) => {
    const fixture = sealedReaderFixture(); mutate(fixture)
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
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
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })
  it('fails closed when cancelled before or after ledger read', async () => {
    const fixture = sealedReaderFixture(); const before = new AbortController(); before.abort()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows), signal: before.signal })).resolves.toMatchObject({ kind: 'unavailable' })
    const after = new AbortController()
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: { async append() { return 'unavailable' as const }, async read() { after.abort(); return fixture.rows } }, signal: after.signal })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('returns facts with current absent when the current action has no seal yet', async () => {
    const fixture = sealedReaderFixture()
    // The pending action has a validated history but no seal yet: a normal
    // pre-result state, not a completeness failure.
    const facts = okFacts(await readSealedParentSessionFacts({ ...fixture.base, approvalRequestId: 'ask-missing', callId: 'call-missing', toolName: 'bash', ledger: ledger(fixture.rows) }))
    expect(facts.current).toBeUndefined()
    expect(facts.seals).toHaveLength(3)
    expect(facts.activities).toHaveLength(3)
    expect(facts.lifecycleFingerprint).toBe(canonicalJson(lifecycle))
  })

  it('fills current only for the validated seal that matches the pending action', async () => {
    const fixture = sealedReaderFixture()
    const facts = okFacts(await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) }))
    expect(facts.current?.seal.sourceSeq).toBe(8)
    expect(facts.current?.seal.request.callId).toBe('call-1')
    expect(facts.current?.seal.approvalAsked.requestId).toBe('ask-1')
    expect(facts.current?.activity.classification).toBe('approval-class:body-escalation')
  })

  it('fails closed when the current matching row itself is polluted', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[2]!
    const seal = reseal(old.seal, { previousSealHash: sealedHash('f') })
    fixture.rows[2] = { seal, activity: reactivate(seal, old.activity) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed on a self-consistent activity classification forgery', async () => {
    const fixture = sealedReaderFixture(), old = fixture.rows[2]!
    // Recompute canonical/sourceSealHash so parse succeeds: only the classifier
    // rule can see that the recorded classification no longer matches the
    // descriptor the capture side sealed with.
    fixture.rows[2] = { ...old, activity: reactivate(old.seal, old.activity, { classification: 'delegation:start' }) }
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed when the execution fact behind the current seal is missing', async () => {
    const fixture = sealedReaderFixture()
    const executionFacts = { async get(input: { callId: string; requestEventSeq: number }) {
      if (input.requestEventSeq === 8) return undefined // the current row's execution fact is missing
      return fixture.base.executionFacts.get(input)
    } }
    await expect(readSealedParentSessionFacts({ ...fixture.base, executionFacts, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed when the execution fact has no classification descriptor', async () => {
    const fixture = sealedReaderFixture()
    const executionFacts = { async get(input: { callId: string; requestEventSeq: number }) {
      const fact = await fixture.base.executionFacts.get(input)
      if (fact === undefined) return undefined
      return { ...fact, toolClassification: { classificationCatalogFingerprint: fact.toolClassification.classificationCatalogFingerprint, descriptor: undefined } } as never
    } }
    await expect(readSealedParentSessionFacts({ ...fixture.base, executionFacts, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fails closed when two validated rows claim the same current action', async () => {
    const fixture = sealedReaderFixture()
    // A fourth legitimate chain row reuses the current identity (call-1/ask-1) via a
    // fresh live call, so both the third and fourth rows validate to the same current
    // action. Only the >1 conflict guard can see the collision; it must fail closed
    // rather than pick one or degrade to an explainable 'missing current'.
    fixture.events.push({ seq: 11, time: 111, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } })
    fixture.events.push({ seq: 12, time: 112, type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash' } })
    fixture.events.push({ seq: 13, time: 113, type: 'tool/result', sourceEventSeqs: [11], data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1' }] } } })
    const third = fixture.rows[2]!.seal
    const duplicate = createSealV1({
      lifecycleFingerprint: canonicalJson(lifecycle), sourceSeq: 11,
      request: { eventSeq: 11, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      approvalAsked: { eventSeq: 12, requestId: 'ask-1' },
      actionHash: sealedHash('a'), projectorId: 'default-v1',
      catalog: { epoch: 1, headerEventSeq: 4, commitment: third.catalog.commitment },
      wireSchemaFingerprint: sealedHash('d'),
      result: { eventSeq: 13, status: 'completed' },
      epochBoundary: { previousEpoch: 1, changed: false },
      previousSealHash: third.sealHash,
    })
    fixture.rows.push({ seal: duplicate, activity: createActivityV1({ lifecycleFingerprint: canonicalJson(lifecycle), sourceSeq: 11, occurredAt: 113, classification: 'approval-class:body-escalation', targetSummary: 'tool:bash', resultCategory: 'completed', sourceSealHash: duplicate.sealHash }) })
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it.each([
    ['genesis (first) row', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[0]!; f.rows[0] = { ...old, activity: reactivate(old.seal, old.activity, { classification: 'delegation:start' }) } }],
    ['mid (second) row', (f: ReturnType<typeof sealedReaderFixture>) => { const old = f.rows[1]!; f.rows[1] = { ...old, activity: reactivate(old.seal, old.activity, { classification: 'delegation:start' }) } }],
  ] as const)('fails closed on a self-consistent classification forgery in the %s', async (_name, mutate) => {
    const fixture = sealedReaderFixture(); mutate(fixture)
    await expect(readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('fits exactly maxSealedTailEvents seals into the bounded packet', async () => {
    const fixture = buildSealedChain(512)
    const facts = okFacts(await readSealedParentSessionFacts({ ...fixture.base, maxSealedTailEvents: 512, ledger: ledger(fixture.rows) }))
    expect(facts.seals).toHaveLength(512)
    expect(facts.activities).toHaveLength(512)
    expect(facts.current?.seal.sourceSeq).toBe(512 * 3 - 2)
  })

  it('returns tail-budget-overflow when the sealed tail exceeds the budget', async () => {
    const fixture = buildSealedChain(513)
    const result = await readSealedParentSessionFacts({ ...fixture.base, maxSealedTailEvents: 512, ledger: ledger(fixture.rows) })
    expect(result).toEqual({ kind: 'tail-budget-overflow', sealedCount: 513, maxSealedTailEvents: 512 })
  })

  it('honours a caller-supplied smaller maxSealedTailEvents budget', async () => {
    const fixture = buildSealedChain(3)
    const result = await readSealedParentSessionFacts({ ...fixture.base, maxSealedTailEvents: 2, ledger: ledger(fixture.rows) })
    expect(result).toEqual({ kind: 'tail-budget-overflow', sealedCount: 3, maxSealedTailEvents: 2 })
  })

  it('prefers a tampering signal over tail-budget-overflow for a polluted chain', async () => {
    const fixture = buildSealedChain(513)
    // Break the disk chain before the over-budget check can fire.
    const old = fixture.rows[1]!
    const seal = reseal(old.seal, { previousSealHash: sealedHash('f') })
    fixture.rows[1] = { seal, activity: reactivate(seal, old.activity) }
    const result = await readSealedParentSessionFacts({ ...fixture.base, maxSealedTailEvents: 512, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable' })
  })

  it('pins the budget check before live re-binding (beyond-window rows stay disk-only)', async () => {
    const fixture = buildSealedChain(513)
    // Poison the live events behind an early (beyond-window) row: the reader
    // must fail on the budget before any live re-binding, so this is overflow,
    // not a tampering signal.
    fixture.events[1].data.callId = 'not-the-request'
    const result = await readSealedParentSessionFacts({ ...fixture.base, maxSealedTailEvents: 512, ledger: ledger(fixture.rows) })
    expect(result).toEqual({ kind: 'tail-budget-overflow', sealedCount: 513, maxSealedTailEvents: 512 })
  })

  it('fails closed when eventAt returns a malformed event for a referenced seq', async () => {
    const fixture = sealedReaderFixture()
    fixture.events[8] = { seq: 8, time: 108, type: 'user/message', data: { id: 'user-9' } }
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result.kind).toBe('unavailable')
  })

  it('fails closed when a referenced live event is absent from eventAt', async () => {
    const fixture = sealedReaderFixture()
    fixture.events[10] = undefined as never
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result.kind).toBe('unavailable')
  })

  it('keeps the current seal inside the bounded tail rather than consuming extra budget', async () => {
    const fixture = buildSealedChain(512)
    const current = fixture.rows[100]!.seal
    const facts = okFacts(await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows), maxSealedTailEvents: 512, approvalRequestId: current.approvalAsked.requestId, callId: current.request.callId, toolName: current.request.toolName }))
    expect(facts.seals).toHaveLength(512)
    expect(facts.current?.seal.sourceSeq).toBe(current.sourceSeq)
  })

  it('fails closed on an invalid maxSealedTailEvents budget', async () => {
    const fixture = sealedReaderFixture()
    const result = await readSealedParentSessionFacts({ ...fixture.base, maxSealedTailEvents: 0, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'max-sealed-tail-events-invalid' })
  })

  it('fails closed on a same-epoch rogue request/header inside the bound header window', async () => {
    const fixture = buildSpoofChain([
      { sourceSeq: 1, askedSeq: 2, resultSeq: 3, headerEventSeq: 0, callId: 'call-a', requestId: 'ask-a' },
      { sourceSeq: 5, askedSeq: 6, resultSeq: 7, headerEventSeq: 0, callId: 'call-b', requestId: 'ask-b' },
    ], [4])
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'intervening-header' })
  })

  it('fails closed on a rogue request/header inside the post-reset window after an epoch boundary', async () => {
    const fixture = buildSpoofChain([
      { sourceSeq: 1, askedSeq: 2, resultSeq: 3, headerEventSeq: 0, callId: 'call-a', requestId: 'ask-a' },
      { sourceSeq: 5, askedSeq: 6, resultSeq: 7, headerEventSeq: 4, callId: 'call-b', requestId: 'ask-b' },
      { sourceSeq: 9, askedSeq: 10, resultSeq: 11, headerEventSeq: 4, callId: 'call-c', requestId: 'ask-c' },
    ], [8])
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'intervening-header' })
  })

  it('resolves via exact live eventAt reads, never the full session snapshot', async () => {
    const fixture = sealedReaderFixture()
    // The reader must re-bind against exact eventAt reads (WP4-b2). A reader
    // that regressed to the full snapshot would read this emptied array and
    // fail, so this pins the bounded path.
    ;(fixture.base.agent as unknown as { session: { snapshotEvents: () => object[] } }).session.snapshotEvents = () => []
    const facts = okFacts(await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) }))
    expect(facts.seals).toHaveLength(3)
  })
})

describe('activityClassificationFromDescriptorV1', () => {
  const subagentSchemas = [...schemas, { name: 'subagent', description: 'subagent schema', parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' } }, required: ['description', 'prompt'] } }]
  it('maps an ordinary descriptor byte-for-byte to its classificationId', () => {
    const dossier = createDshAlpha2EffectiveCatalog(schemas).dossier
    const bash = dossier.descriptors.find(item => item.toolName === 'bash')
    if (bash === undefined || bash.classification !== 'ordinary') throw new Error('expected an ordinary bash descriptor')
    expect(activityClassificationFromDescriptorV1(bash)).toBe('approval-class:body-escalation')
    expect(activityClassificationFromDescriptorV1(bash)).toBe(bash.classificationId)
  })
  it('maps a delegation descriptor byte-for-byte to delegation:+operation', () => {
    const dossier = createDshAlpha2EffectiveCatalog(subagentSchemas).dossier
    const subagent = dossier.descriptors.find(item => item.toolName === 'subagent')
    if (subagent === undefined || subagent.classification !== 'delegation') throw new Error('expected a delegation subagent descriptor')
    expect(subagent.operation).toBe('start')
    expect(activityClassificationFromDescriptorV1(subagent)).toBe('delegation:start')
    expect(activityClassificationFromDescriptorV1(subagent)).toBe('delegation:' + subagent.operation)
  })
  it('fails closed on an unknown or malformed classification shape', () => {
    expect(() => activityClassificationFromDescriptorV1({ classification: 'bogus' })).toThrow()
    expect(() => activityClassificationFromDescriptorV1({})).toThrow()
    expect(() => activityClassificationFromDescriptorV1(undefined)).toThrow()
    expect(() => activityClassificationFromDescriptorV1(null)).toThrow()
    expect(() => activityClassificationFromDescriptorV1({ classification: 'ordinary' })).toThrow()
    expect(() => activityClassificationFromDescriptorV1({ classification: 'delegation' })).toThrow()
    expect(() => activityClassificationFromDescriptorV1({ classification: 'ordinary', classificationId: '' })).toThrow()
  })
})

describe('deriveRequesterDepthV1 (WP4-c S-5)', () => {
  it('derives the same effective depth as delegationDepthOf from header + runtime evidence', () => {
    // header absent, runtime absent -> top level 0.
    expect(deriveRequesterDepthV1({})).toBe(0)
    expect(deriveRequesterDepthV1({ headerDelegationDepth: undefined, runtimeSubagentDepth: undefined })).toBe(0)
    // header only -> header wins (runtime may only deepen, never lower).
    expect(deriveRequesterDepthV1({ headerDelegationDepth: 2 })).toBe(2)
    // runtime may deepen the header depth.
    expect(deriveRequesterDepthV1({ headerDelegationDepth: 2, runtimeSubagentDepth: 5 })).toBe(5)
    expect(deriveRequesterDepthV1({ headerDelegationDepth: 0, runtimeSubagentDepth: 3 })).toBe(3)
  })

  it('never lets a stale header mask a deeper runtime depth (resumed child cannot appear root)', () => {
    // A resumed child arrives with fresh runtime depth but a possibly-stale
    // header; the effective depth is the max of the two, never the header alone.
    expect(deriveRequesterDepthV1({ headerDelegationDepth: 1, runtimeSubagentDepth: 3 })).toBe(3)
    expect(deriveRequesterDepthV1({ headerDelegationDepth: 0, runtimeSubagentDepth: 1 })).toBe(1)
  })

  it('fails closed (undefined) instead of throwing on invalid depth evidence', () => {
    // delegationDepthOf throws on a negative runtime subagentDepth; the shared
    // derivation degrades to undefined so the hot path never crashes on a
    // malformed Agent depth.
    expect(deriveRequesterDepthV1({ runtimeSubagentDepth: -1 })).toBeUndefined()
    expect(deriveRequesterDepthV1({ headerDelegationDepth: -1 })).toBeUndefined()
    expect(deriveRequesterDepthV1({ headerDelegationDepth: Number.NaN })).toBeUndefined()
    expect(deriveRequesterDepthV1({ runtimeSubagentDepth: 1.5 })).toBeUndefined()
    const negativeZero = -0
    expect(deriveRequesterDepthV1({ runtimeSubagentDepth: negativeZero })).toBeUndefined()
    expect(deriveRequesterDepthV1({ headerDelegationDepth: negativeZero })).toBeUndefined()
  })

describe('readSealedParentSessionFacts WP5-a unavailable subcode', () => {
  function chain3() {
    return buildSpoofChain([
      { sourceSeq: 1, askedSeq: 2, resultSeq: 3, headerEventSeq: 0, callId: 'call-1', requestId: 'ask-1' },
      { sourceSeq: 4, askedSeq: 5, resultSeq: 6, headerEventSeq: 0, callId: 'call-2', requestId: 'ask-2' },
      { sourceSeq: 7, askedSeq: 8, resultSeq: 9, headerEventSeq: 0, callId: 'call-3', requestId: 'ask-3' },
    ])
  }

  it('classifies a disconnected seal chain as seal-chain-invalid', async () => {
    const fixture = chain3(), old = fixture.rows[1]!
    const seal = reseal(old.seal, { previousSealHash: sealedHash('f') })
    fixture.rows[1] = { seal, activity: reactivate(seal, old.activity) }
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', subcode: 'seal-chain-invalid' })
  })

  it('classifies a self-consistent activity rebind rejection as activity-projection-invalid', async () => {
    const fixture = chain3(), old = fixture.rows[2]!
    const { version: _v, canonical: _c, ...input } = old.activity
    fixture.rows[2] = { ...old, activity: createActivityV1({ ...input, sourceSealHash: sealedHash('f') }) }
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', subcode: 'activity-projection-invalid' })
  })

  it('classifies a live rebind rejection as seal-live-rebind-failed', async () => {
    const fixture = chain3()
    fixture.events[7].data.callId = 'other'
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', subcode: 'seal-live-rebind-failed' })
  })

  it('classifies an unreadable ledger as ledger-storage-unavailable', async () => {
    const fixture = chain3()
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(undefined) })
    expect(result).toMatchObject({ kind: 'unavailable', subcode: 'ledger-storage-unavailable' })
  })

  it('classifies a malformed disk row as ledger-conflict', async () => {
    const fixture = chain3()
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger([{ seal: 'x', activity: 'y' } as never]) })
    expect(result).toMatchObject({ kind: 'unavailable', subcode: 'ledger-conflict' })
  })

  it('classifies a duplicate current seal as sealed-current-conflict', async () => {
    const fixture = buildSpoofChain([
      { sourceSeq: 1, askedSeq: 2, resultSeq: 3, headerEventSeq: 0, callId: 'call-1', requestId: 'ask-1' },
      { sourceSeq: 4, askedSeq: 5, resultSeq: 6, headerEventSeq: 0, callId: 'call-1', requestId: 'ask-1' },
    ])
    const result = await readSealedParentSessionFacts({ ...fixture.base, ledger: ledger(fixture.rows) })
    expect(result).toMatchObject({ kind: 'unavailable', subcode: 'sealed-current-conflict' })
  })
})

})
