import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DshExecutionFactProjectionBridge } from '../../src/dsh/execution-projection-bridge.js'
import { createActionSnapshot } from '../../src/domain/protocol.js'
import { InMemoryApprovalSnapshotRepository, InMemoryExecutionFactRepository } from '../../src/application/fact-repositories.js'

const catalog = {
  version: 1 as const, eventProjectionPolicyId: 'dsh-session-facts-v1' as const,
  argumentSemanticsId: 'json-v1', fingerprint: 'catalog-1',
  descriptors: [{ classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-v1', classificationId: 'ordinary' }],
}

function agent(events: readonly unknown[], cwd?: string): Agent {
  return {
    id: 'session-1',
    session: {
      id: 'session-1',
      header: { id: 'session-1', version: 1, createdAt: 10, ...(cwd === undefined ? {} : { cwd }) },
      events,
    },
  } as unknown as Agent
}
function execution(owner: Agent): ToolExecution {
  return {
    callId: 'call-1' as ToolExecution['callId'], rootCallId: 'call-1' as ToolExecution['callId'],
    name: 'bash', arguments: { command: 'pwd' }, agent: owner,
    signal: new AbortController().signal, token: Symbol() as ToolExecution['token'],
  }
}

describe('DshExecutionFactProjectionBridge', () => {
  it('projects only one exact durable native call', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([{ seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } }], '/workspace')
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await bridge.project(execution(owner))
    const records = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10, cwd: '/workspace' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ session: { cwd: '/workspace' }, request: { eventSeq: 0, callId: 'call-1', toolName: 'bash' }, projection: { observedAt: 20 } })
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toHaveLength(0)
  })

  it('captures an immutable snapshot only for one prior canonical call', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'approval-1', callId: 'call-1', toolName: 'bash' } },
    ], '/workspace')
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository, approvals)
    await bridge.project(execution(owner))
    // The resolver-side barrier can reconstruct the observer write directly
    // from canonical history when the fire-and-forget listener has not settled.
    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')
    const snapshot = await approvals.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10, cwd: '/workspace' },
      approvalRequestId: 'approval-1', approvalAskedSeq: 1,
    })
    expect(snapshot).toMatchObject({ approvalAskedSeq: 1, environment: {} })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('attaches one matching native result without copying result content', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'private output' }] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await bridge.project(execution(owner))
    bridge.observeResult(execution(owner), { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).events[1]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.toMatchObject({ result: { eventSeq: 1, eventType: 'tool/result', outcome: { kind: 'completed' } } })
  })

  it('rejects a result whose durable source sequence differs from the call', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [99], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await bridge.project(execution(owner))
    bridge.observeResult(execution(owner), { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).events[1]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.not.toHaveProperty('result')
  })

  it('does not attach a denied or pre-dispatch failed result', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await bridge.project(execution(owner))
    bridge.observeResult(execution(owner), { isError: true, error: { message: 'the user rejected tool "bash"' }, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).events[1]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.not.toHaveProperty('result')
  })

  it('does not attach an ambiguous native result', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 2, time: 22, type: 'tool/result', data: { turn: 1, step: 0, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await repository.create({ version: 1, session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, request: { kind: 'model-tool-call', eventSeq: 0, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' }, toolClassification: { classificationCatalogFingerprint: 'catalog-1', descriptor: catalog.descriptors[0]! }, projection: { projectorId: 'test', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: 'irrelevant', observedAt: 20 } })
    await repository.create({ version: 1, session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, request: { kind: 'model-tool-call', eventSeq: 1, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' }, toolClassification: { classificationCatalogFingerprint: 'catalog-1', descriptor: catalog.descriptors[0]! }, projection: { projectorId: 'test', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: 'irrelevant', observedAt: 21 } })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown }[] }).events[2]!)
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toEqual(expect.not.arrayContaining([expect.objectContaining({ result: expect.anything() })]))
  })

  it('does not project missing or ambiguous canonical calls', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await bridge.project(execution(owner))
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toHaveLength(0)
  })
})
