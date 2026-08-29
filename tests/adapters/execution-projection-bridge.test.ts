import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DshExecutionFactProjectionBridge } from '../../src/dsh/execution-projection-bridge.js'
import { InMemoryApprovalSnapshotRepository, InMemoryExecutionFactRepository } from '../../src/application/fact-repositories.js'

const catalog = {
  version: 1 as const, eventProjectionPolicyId: 'dsh-session-facts-v1' as const,
  argumentSemanticsId: 'json-v1', fingerprint: 'catalog-1',
  descriptors: [{ classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-v1', classificationId: 'ordinary' }],
}

function agent(events: readonly unknown[]): Agent {
  return {
    id: 'session-1',
    session: { id: 'session-1', header: { id: 'session-1', version: 1, createdAt: 10 }, events },
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
    const owner = agent([{ seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } }])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository)
    await bridge.project(execution(owner))
    const records = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ request: { eventSeq: 0, callId: 'call-1', toolName: 'bash' }, projection: { observedAt: 20 } })
  })

  it('captures an immutable snapshot only for one prior canonical call', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'approval-1', callId: 'call-1', toolName: 'bash' } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, catalog, repository, approvals)
    await bridge.project(execution(owner))
    // The resolver-side barrier can reconstruct the observer write directly
    // from canonical history when the fire-and-forget listener has not settled.
    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')
    const snapshot = await approvals.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      approvalRequestId: 'approval-1', approvalAskedSeq: 1,
    })
    expect(snapshot).toMatchObject({ approvalAskedSeq: 1, environment: {} })
    expect(Object.isFrozen(snapshot)).toBe(true)
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
