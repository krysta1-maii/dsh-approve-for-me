import { describe, expect, it } from 'vitest'
import { DshParentSessionFactSource, createActionSnapshot } from '../../src/index.js'
import type {
  ApprovalSnapshotRecordV1,
  DelegationToolClassificationCatalogV1,
  ToolExecutionFactRecordV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const catalog: DelegationToolClassificationCatalogV1 = {
  version: 1,
  eventProjectionPolicyId: 'dsh-session-facts-v1',
  argumentSemanticsId: 'default-v1',
  fingerprint: hash('c'),
  descriptors: [{ classification: 'ordinary', toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' }],
}
const lifecycle = { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 100 }
const descriptor = { classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' }
const execution: ToolExecutionFactRecordV1 = {
  version: 1,
  session: lifecycle,
  request: { kind: 'model-tool-call', eventSeq: 2, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
  toolClassification: { classificationCatalogFingerprint: hash('c'), descriptor },
  projection: { projectorId: 'default-v1', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: hash('a'), observedAt: 101 },
}
const approval: ApprovalSnapshotRecordV1 = {
  version: 1, session: lifecycle, approvalRequestId: 'ask-1', approvalAskedSeq: 3,
  environment: { version: 1, sessionId: 'parent-1' },
}

function agent(overrides: object = {}) {
  return {
    id: 'parent-1',
    session: {
      id: 'parent-1',
      header: { version: 0, id: 'parent-1', createdAt: 100 },
      events: [
        { seq: 0, time: 100, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, time: 101, type: 'user/message', surfaceOp: 'append', data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'pwd' }] } },
        { seq: 2, time: 102, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' } },
        { seq: 3, time: 103, type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } },
        { seq: 4, time: 104, type: 'tool/result', data: { turn: 1, step: 0, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'secret' }] } } },
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
    expect(facts?.approvalBinding.event.seq).toBe(3)
    expect(facts?.executionFacts).toEqual([execution])
    expect(facts?.approvalSnapshots).toEqual([approval])
    expect(facts?.events).toHaveLength(4)
    expect(facts?.events[1]).toMatchObject({ type: 'user/message', surfaceState: 'visible' })
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

  it('refuses mismatched ids, missing asks, conflicting projections, and unknown agents', () => {
    const requester = agent()
    const source = new DshParentSessionFactSource({ get: id => id === 'parent-1' ? requester as never : undefined })
    expect(source.snapshot(input({ agent: agent({ session: { ...agent().session, id: 'other' } }) as never }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, approvalRequestId: 'other' }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, approvalSnapshots: [{ ...approval, approvalRequestId: 'other' }] }))).toBeUndefined()
    expect(source.snapshot(input({ agent: requester as never, executionFacts: [{ ...execution, session: { ...lifecycle, cwd: '/other-project' } } as ToolExecutionFactRecordV1] }))).toBeUndefined()
    const regressive = agent()
    ;(regressive.session.events as unknown as Array<{ time: number }>)[2]!.time = 99
    expect(source.snapshot(input({ agent: regressive as never }))).toBeUndefined()
    const emptyCwd = agent()
    ;(emptyCwd.session.header as unknown as { cwd?: unknown }).cwd = ''
    expect(new DshParentSessionFactSource({ get: () => emptyCwd as never }).snapshot(input({ agent: emptyCwd as never }))).toBeUndefined()
    expect(new DshParentSessionFactSource({ get: () => undefined }).snapshot(input({ agent: requester as never }))).toBeUndefined()
  })

})
