import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DshExecutionFactProjectionBridge } from '../../src/dsh/execution-projection-bridge.js'
import { createActionSnapshot } from '../../src/domain/protocol.js'
import { InMemoryApprovalSnapshotRepository, InMemoryExecutionFactRepository } from '../../src/application/fact-repositories.js'
import { DefaultActionCapture } from '../../src/ports/action-projector.js'
import { createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import { fingerprintDurableToolCatalogCommitmentV1 } from '../../src/domain/dossier.js'

const bashSchema = { name: 'bash', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
const runCodeSchema = { name: 'run_code', description: 'dispatch', parameters: { type: 'object', properties: { code: { type: 'string' } } } }
const baseCatalog = createDshAlpha2EffectiveCatalog([bashSchema, runCodeSchema])
const catalog = baseCatalog.dossier
function effectiveCatalog(exec: ToolExecution) {
  const nested = exec.parent !== undefined
  const wireSchemas = nested ? [runCodeSchema] : [bashSchema, runCodeSchema]
  const unsealed = {
    version: 1 as const,
    fingerprint: '',
    presentation: nested ? 'ptc' as const : 'native' as const,
    requestHeaderEventSeq: 0,
    wireSchemas,
    callableSchemas: baseCatalog.schemas,
    approvalCatalog: baseCatalog.approval,
    classificationCatalog: baseCatalog.dossier,
  }
  const commitment = Object.freeze({ ...unsealed, fingerprint: fingerprintDurableToolCatalogCommitmentV1(unsealed)! })
  const events = (exec.agent!.session as unknown as { events: readonly { seq: number; type: string; data: Record<string, unknown> }[] }).events
  const request = [...events].reverse().find(event => nested
    ? event.type === 'tool/code-dispatch-start' && event.data.subCallId === String(exec.callId)
    : event.type === 'tool/call' && event.data.callId === String(exec.callId))!
  const root = nested ? events.find(event => event.type === 'tool/call' && event.data.callId === String(exec.rootCallId))! : request
  return Object.freeze({
    ...baseCatalog,
    commitment,
    execution: Object.freeze({
      requestEventSeq: request.seq,
      requestEventType: request.type as 'tool/call' | 'tool/code-dispatch-start',
      rootRequestEventSeq: root.seq,
      parentRequestEventSeq: root.seq,
    }),
  })
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
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await bridge.project(execution(owner))
    const records = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10, cwd: '/workspace' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ session: { cwd: '/workspace' }, request: { eventSeq: 0, callId: 'call-1', toolName: 'bash' }, projection: { observedAt: 20 } })
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toHaveLength(0)
  })

  it('persists the capture projection without evaluating its projector again', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([{ seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } }])
    const captures = new DefaultActionCapture<Agent, string>()
    const captured = createActionSnapshot({ toolName: 'bash', arguments: { command: 'captured' } })
    captures.remember(owner, 'call-1', captured)
    const bridge = new DshExecutionFactProjectionBridge(
      { project: () => { throw new Error('must not re-project') } }, effectiveCatalog, repository, undefined, captures,
    )
    await bridge.project(execution(owner))
    const records = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]!.projection.action).toBe(captured)
  })

  it('does not re-project or persist when an authoritative capture is missing', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([{ seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } }])
    const captures = new DefaultActionCapture<Agent, string>()
    let calls = 0
    const bridge = new DshExecutionFactProjectionBridge({ project: () => { calls += 1; return { toolName: 'bash', arguments: {} } } }, effectiveCatalog, repository, undefined, captures)
    await bridge.project(execution(owner))
    expect(calls).toBe(0)
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toHaveLength(0)
  })

  it('captures an immutable snapshot only for one prior canonical call', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'approval-1', callId: 'call-1', toolName: 'bash' } },
    ], '/workspace')
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    await bridge.project(execution(owner))
    // The resolver-side barrier can reconstruct the observer write directly
    // from canonical history when the fire-and-forget listener has not settled.
    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')
    const snapshot = await approvals.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10, cwd: '/workspace' },
      approvalRequestId: 'approval-1', approvalAskedSeq: 1,
    })
    expect(snapshot).toMatchObject({
      approvalAskedSeq: 1,
      execution: { requestEventSeq: 0, callId: 'call-1', toolName: 'bash', classificationCatalogFingerprint: catalog.fingerprint, projectorId: 'dsh-approve-for-me/generic-raw-v1' },
      environment: { version: 1, kind: 'native-header-only' },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('attaches one matching native result without copying result content', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'private output' }] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).events[1]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.toMatchObject({ result: { eventSeq: 1, eventType: 'tool/result', outcome: { kind: 'completed' } } })
  })

  it('persists only a canonical categorical sandbox denial and discards result details', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, {
      isError: false,
      value: { sandbox: { denied: true, mode: 'read-only', enforcement: 'full' }, output: '/private/secret/path' },
      content: [{ type: 'text', text: 'stderr must not persist' }],
    })
    await bridge.observeSessionEvent(owner, events[1]!)
    const persisted = await repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      callId: 'call-1', requestEventSeq: 0,
    })
    expect(persisted).toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'sandbox-denied', mode: 'read-only', enforcement: 'full' } } })
    expect(JSON.stringify(persisted)).not.toContain('/private/secret/path')
    expect(JSON.stringify(persisted)).not.toContain('stderr must not persist')
  })

  it('does not treat a successful tool-controlled denial marker as sandbox evidence', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, {
      isError: false,
      value: '[sandbox: file access denied under read-only mode]',
      content: [{ type: 'text', text: '[sandbox: file access denied under danger-full-access mode]' }],
    })
    await bridge.observeSessionEvent(owner, events[1]!)
    await expect(repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      callId: 'call-1', requestEventSeq: 0,
    })).resolves.toMatchObject({ result: { outcome: { kind: 'completed' } } })
  })

  it('retries a result attachment after one transient repository miss', async () => {
    const repository = new InMemoryExecutionFactRepository()
    let attachAttempts = 0
    const flaky = {
      create: repository.create.bind(repository),
      list: repository.list.bind(repository),
      get: repository.get.bind(repository),
      stageTerminal: repository.stageTerminal.bind(repository),
      async attachResult(input: Parameters<typeof repository.attachResult>[0]) {
        attachAttempts += 1
        if (attachAttempts === 1) return 'missing' as const
        return repository.attachResult(input)
      },
    }
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, flaky)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, events[1]!)
    await bridge.observeSessionEvent(owner, events[1]!)
    expect(attachAttempts).toBe(2)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'completed' } } })
  })

  it('retries an approval snapshot after one transient repository conflict', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    let createAttempts = 0
    const flakyApprovals = {
      list: approvals.list.bind(approvals),
      get: approvals.get.bind(approvals),
      async create(input: Parameters<typeof approvals.create>[0]) {
        createAttempts += 1
        if (createAttempts === 1) return 'conflict' as const
        return approvals.create(input)
      },
    }
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'approval-1', callId: 'call-1', toolName: 'bash' } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, flakyApprovals)
    await bridge.project(execution(owner))
    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')
    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')
    expect(createAttempts).toBe(2)
    await expect(approvals.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toHaveLength(1)
  })

  it('cold-repairs a completed result from pre-commit terminal evidence and the canonical event', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const owner = agent(events)
    const live = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await live.project(exec)
    await live.postExecute(exec, { isError: false, value: null, content: [] }, async () => ({ kind: 'accept' }))
    await expect(repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      callId: 'call-1', requestEventSeq: 0,
    })).resolves.toMatchObject({ terminalEvidence: { outcome: { kind: 'completed' } } })

    // A fresh bridge has no volatile tools/result marker. Durable staging plus
    // the canonical Session event must still repair the sidecar.
    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await recovered.observeSessionEvent(owner, events[1]!)
    await expect(repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      callId: 'call-1', requestEventSeq: 0,
    })).resolves.toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'completed' } } })
  })

  it('cold-repairs a staged categorical sandbox denial', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const owner = agent(events)
    const live = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await live.project(exec)
    await live.postExecute(exec, {
      isError: false,
      value: { sandbox: { denied: true, mode: 'workspace-write' }, output: 'secret stderr' },
      content: [{ type: 'text', text: 'secret stderr' }],
    }, async () => ({ kind: 'accept' }))
    await expect(repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0,
    })).resolves.toMatchObject({ terminalEvidence: { outcome: { kind: 'sandbox-denied', mode: 'workspace-write' } } })

    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await recovered.observeSessionEvent(owner, events[1]!)
    const persisted = await repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0,
    })
    expect(persisted).toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'sandbox-denied', mode: 'workspace-write' } } })
    expect(JSON.stringify(persisted)).not.toContain('secret stderr')
  })

  it('uses the canonical result category when staged success becomes a final error', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }] } } },
    ]
    const owner = agent(events)
    const live = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await live.project(exec)
    await live.postExecute(exec, { isError: false, value: null, content: [] }, async () => ({ kind: 'accept' }))

    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await recovered.observeSessionEvent(owner, events[1]!)
    await expect(repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      callId: 'call-1', requestEventSeq: 0,
    })).resolves.toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'tool-error' } } })
  })

  it('drains prior durable result writes at the approval barrier', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-0', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-0' }, content: [{ type: 'tool-result', toolCallId: 'call-0', isError: false, content: [] }] } } },
      { seq: 2, time: 22, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 3, time: 23, type: 'approval/asked', data: { id: 'approval-1', callId: 'call-1', toolName: 'bash' } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    const first = { ...execution(owner), callId: 'call-0' as ToolExecution['callId'], rootCallId: 'call-0' as ToolExecution['callId'] }
    await bridge.project(first)
    bridge.observeResult(first, { isError: false, value: null, content: [] })
    const second = execution(owner)
    await bridge.project(second)
    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-0', requestEventSeq: 0 }))
      .resolves.toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'completed' } } })
  })

  it('rejects a result whose durable source sequence differs from the call', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [99], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).events[1]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.not.toHaveProperty('result')
  })

  it('attaches a content-free tool-error marker without copying failure text', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, { isError: true, error: { message: 'the user rejected tool "bash"' }, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).events[1]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.toMatchObject({ result: { eventSeq: 1, eventType: 'tool/result', outcome: { kind: 'tool-error' } } })
  })

  it('projects and settles one nested code dispatch without persisting its content', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'root-1', name: 'run_code', arguments: '{}' } },
      { seq: 1, time: 21, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } },
      { seq: 2, time: 22, type: 'tool/code-dispatch', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' }, isError: false, content: [{ type: 'text', text: 'private output' }] } },
    ])
    const nested = {
      ...execution(owner),
      callId: 'sub-1' as ToolExecution['callId'],
      rootCallId: 'root-1' as ToolExecution['callId'],
      parent: Symbol('root') as NonNullable<ToolExecution['parent']>,
    } as ToolExecution
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await bridge.project(nested)
    bridge.observeResult(nested, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown }[] }).events[2]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'sub-1', requestEventSeq: 1 }))
      .resolves.toMatchObject({
        request: { kind: 'code-dispatch', eventType: 'tool/code-dispatch-start' },
        result: { eventSeq: 2, eventType: 'tool/code-dispatch', outcome: { kind: 'completed' } },
      })
  })

  it('does not attach a code-dispatch result when an earlier identical start has no terminal', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'root-1', name: 'run_code', arguments: '{}' } },
      { seq: 1, time: 21, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } },
      { seq: 2, time: 22, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } },
      { seq: 3, time: 23, type: 'tool/code-dispatch', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' }, isError: false, content: [] } },
    ]
    const owner = agent(events)
    const nested = {
      ...execution(owner),
      callId: 'sub-1' as ToolExecution['callId'],
      rootCallId: 'root-1' as ToolExecution['callId'],
      parent: Symbol('root') as NonNullable<ToolExecution['parent']>,
    } as ToolExecution
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await bridge.project(nested)
    bridge.observeResult(nested, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, events[3]!)
    await expect(repository.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      callId: 'sub-1', requestEventSeq: 2,
    })).resolves.not.toHaveProperty('result')
  })

  it('does not attach an ambiguous native result', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 2, time: 22, type: 'tool/result', data: { turn: 1, step: 0, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await repository.create({ version: 1, catalogCommitment: effectiveCatalog(execution(owner)).commitment, session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, request: { kind: 'model-tool-call', eventSeq: 0, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' }, toolClassification: { classificationCatalogFingerprint: 'catalog-1', descriptor: catalog.descriptors[0]! }, projection: { projectorId: 'test', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: 'irrelevant', observedAt: 20 } })
    await repository.create({ version: 1, catalogCommitment: effectiveCatalog(execution(owner)).commitment, session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, request: { kind: 'model-tool-call', eventSeq: 1, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' }, toolClassification: { classificationCatalogFingerprint: 'catalog-1', descriptor: catalog.descriptors[0]! }, projection: { projectorId: 'test', action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), actionHash: 'irrelevant', observedAt: 21 } })
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { events: readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown }[] }).events[2]!)
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toEqual(expect.not.arrayContaining([expect.objectContaining({ result: expect.anything() })]))
  })

  it('binds a reused call id and its terminal event to the latest exact request event sequence', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 0, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
    ] as Array<{ seq: number; time: number; type: string; sourceEventSeqs?: number[]; data: Record<string, unknown> }>
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, { isError: false, value: null, content: [] })
    events.push({ seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [1], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } })
    await bridge.observeSessionEvent(owner, events[2]!)
    await expect(repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toEqual([
      expect.objectContaining({ request: expect.objectContaining({ callId: 'call-1', eventSeq: 1 }), result: expect.objectContaining({ eventSeq: 2 }) }),
    ])
  })
})
