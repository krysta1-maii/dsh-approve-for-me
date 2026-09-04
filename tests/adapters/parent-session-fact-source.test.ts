import { describe, expect, it } from 'vitest'
import { DshParentSessionFactSource, createActionSnapshot, fingerprintDelegationToolCatalogV1, readSealedParentSessionFacts } from '../../src/index.js'
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
    const base = { agent: requester as never, registry: { get: () => requester as never }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' }
    expect(await readSealedParentSessionFacts({ ...base, ledger: undefined })).toBeUndefined()
    expect(await readSealedParentSessionFacts({ ...base, ledger: { async append() { return 'unavailable' as const }, async read() { return [] } } })).toBeUndefined()
    expect(await readSealedParentSessionFacts({ ...base, ledger: { async append() { return 'unavailable' as const }, async read() { return undefined } } })).toBeUndefined()
  })

})
