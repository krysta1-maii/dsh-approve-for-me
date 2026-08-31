import { describe, expect, it } from 'vitest'
import { DshParentSessionFactSource, createActionSnapshot } from '../../src/index.js'
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
  return {
    id: 'parent-1',
    options: {},
    session: {
      id: 'parent-1',
      header: { version: 0, id: 'parent-1', createdAt: 100 },
      events: [
        { seq: 0, time: 100, type: 'request/header', data: { header: { tools: schemas } } },
        { seq: 1, time: 101, type: 'user/message', surfaceOp: 'append', data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'pwd' }] } },
        { seq: 2, time: 102, type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }] } } },
        { seq: 3, time: 103, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' } },
        { seq: 4, time: 104, type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } },
        { seq: 5, time: 105, type: 'tool/result', data: { turn: 1, step: 0, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'secret' }] } } },
      ],
    },
    ...overrides,
  }
}

function input(overrides: object = {}) {
  return { agent: agent() as never, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash', classificationCatalog: catalog, executionFacts: [execution], approvalSnapshots: [approval], ...overrides }
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
    ;((requester.session.events[1]!.data as { content: Array<{ text: string }> }).content[0]!).text = 'mutated after snapshot'
    expect(facts?.events[1]).toMatchObject({ data: { content: [{ text: 'pwd' }] } })
    const snapshotEvent = facts?.events[1]
    expect(snapshotEvent?.retention).toBe('included')
    if (snapshotEvent?.retention === 'included') expect(Object.isFrozen(snapshotEvent.data as object)).toBe(true)
  })

  it('marks a replaced direct user event superseded in the frozen source snapshot', () => {
    const requester = agent()
    ;(requester.session.events as unknown as object[]).splice(2, 0, {
      seq: 2, time: 102, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [1],
      data: { id: 'user-2', source: { kind: 'user' }, content: [{ type: 'text', text: 'use ls instead' }] },
    })
    ;(requester.session.events as unknown as Array<{ seq: number }>).forEach((event, sequence) => { event.seq = sequence })
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
    ;(duplicate.session.events as unknown as object[]).splice(3, 0, {
      seq: 3, time: 103, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
    })
    ;(duplicate.session.events as unknown as Array<{ seq: number }>).forEach((event, index) => { event.seq = index })
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
    ;(regressive.session.events as unknown as Array<{ time: number }>)[2]!.time = 99
    expect(source.snapshot(input({ agent: regressive as never }))).toBeUndefined()
    const negativeZeroSequence = agent()
    ;(negativeZeroSequence.session.events as unknown as Array<{ seq: number }>)[0]!.seq = -0
    expect(source.snapshot(input({ agent: negativeZeroSequence as never }))).toBeUndefined()
    const invalidSourceSequence = agent()
    ;(invalidSourceSequence.session.events as unknown as Array<{ sourceEventSeqs?: readonly number[] }>)[2]!.sourceEventSeqs = [-0]
    expect(source.snapshot(input({ agent: invalidSourceSequence as never }))).toBeUndefined()
    const emptyCwd = agent()
    ;(emptyCwd.session.header as unknown as { cwd?: unknown }).cwd = ''
    expect(new DshParentSessionFactSource({ get: () => emptyCwd as never }).snapshot(input({ agent: emptyCwd as never }))).toBeUndefined()
    expect(new DshParentSessionFactSource({ get: () => undefined }).snapshot(input({ agent: requester as never }))).toBeUndefined()
  })

})
