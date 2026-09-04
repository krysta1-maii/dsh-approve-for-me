import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DshExecutionFactProjectionBridge } from '../../src/dsh/execution-projection-bridge.js'
import type { SealedFactsLedger } from '../../src/dsh/execution-projection-bridge.js'
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
  const events = (exec.agent!.session as unknown as { snapshotEvents: () => readonly { seq: number; type: string; data: Record<string, unknown> }[] }).snapshotEvents()
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
      snapshotEvents: () => events,
      get seq () { return events.length },
      eventAt: (seq: number) => events[seq],
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

  it('attaches one matching native result by exact source without listing history', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'private output' }] }] } } },
    ])
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const exec = execution(owner)
    await bridge.project(exec)
    bridge.observeResult(exec, { isError: false, value: null, content: [] })
    const list = vi.spyOn(repository, 'list')
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { snapshotEvents: () => readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).snapshotEvents()[1]!)
    expect(list).not.toHaveBeenCalled()
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

  it('avoids barrier replay and cold-repairs only missing rows from one validated snapshot', async () => {
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
    await bridge.project(execution(owner))
    const list = vi.spyOn(repository, 'list')

    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')

    expect(list).not.toHaveBeenCalled()
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-0', requestEventSeq: 0 }))
      .resolves.not.toHaveProperty('result')
    const snapshot = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    await expect(bridge.repairHistoricalResults(owner, snapshot, 3)).resolves.toBe(1)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-0', requestEventSeq: 0 }))
      .resolves.toMatchObject({ result: { eventSeq: 1, outcome: { kind: 'completed' } } })
    await expect(approvals.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, approvalRequestId: 'approval-1', approvalAskedSeq: 3 }))
      .resolves.toMatchObject({ execution: { requestEventSeq: 2, callId: 'call-1' } })
  })

  it('yields cold repair scans so Stop can abort before a historical write', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 1, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      ...Array.from({ length: 511 }, (_value, index) => ({ seq: index + 1, time: index + 2, type: 'assistant/chunk', data: {} })),
      { seq: 512, time: 513, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await bridge.project(execution(owner))
    const snapshot = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    const abort = new AbortController()
    setImmediate(() => abort.abort({ kind: 'user' }))

    await expect(bridge.repairHistoricalResults(owner, snapshot, 513, abort.signal)).resolves.toBe(0)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 }))
      .resolves.not.toHaveProperty('result')
  })

  it('keeps a 10k-result cold history to one exact fact lookup per approval', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events = Array.from({ length: 10_000 }, (_value, seq) => ({
      seq,
      time: seq + 1,
      type: 'tool/result',
      data: {},
    }))
    events.push(
      { seq: 10_000, time: 10_001, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 10_001, time: 10_002, type: 'approval/asked', data: { id: 'approval-1', callId: 'call-1', toolName: 'bash' } },
    )
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    await bridge.project(execution(owner))
    const get = vi.spyOn(repository, 'get')
    const list = vi.spyOn(repository, 'list')

    await bridge.awaitApprovalSnapshot(owner, 'approval-1', 'call-1', 'bash')

    expect(list).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(1)
    await expect(approvals.get({
      session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 },
      approvalRequestId: 'approval-1',
      approvalAskedSeq: 10_001,
    })).resolves.toMatchObject({ execution: { requestEventSeq: 10_000 } })
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
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { snapshotEvents: () => readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).snapshotEvents()[1]!)
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
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { snapshotEvents: () => readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown; readonly sourceEventSeqs?: readonly number[] }[] }).snapshotEvents()[1]!)
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
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { snapshotEvents: () => readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown }[] }).snapshotEvents()[2]!)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'sub-1', requestEventSeq: 1 }))
      .resolves.toMatchObject({
        request: { kind: 'code-dispatch', eventType: 'tool/code-dispatch-start' },
        result: { eventSeq: 2, eventType: 'tool/code-dispatch', outcome: { kind: 'completed' } },
      })
  })

  it('cold-repairs one unambiguous source-less code dispatch in one history pass', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const owner = agent([
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'root-1', name: 'run_code', arguments: '{}' } },
      { seq: 1, time: 21, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } },
      { seq: 2, time: 22, type: 'tool/code-dispatch', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' }, isError: false, content: [] } },
    ])
    const nested = {
      ...execution(owner),
      callId: 'sub-1' as ToolExecution['callId'],
      rootCallId: 'root-1' as ToolExecution['callId'],
      parent: Symbol('root') as NonNullable<ToolExecution['parent']>,
    } as ToolExecution
    const live = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await live.project(nested)
    const snapshot = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)

    await expect(recovered.repairHistoricalResults(owner, snapshot, 3)).resolves.toBe(1)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'sub-1', requestEventSeq: 1 }))
      .resolves.toMatchObject({ result: { eventSeq: 2, eventType: 'tool/code-dispatch', outcome: { kind: 'completed' } } })
  })

  it('cold-repairs concurrent identical code dispatches with explicit source edges', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events: Array<{ seq: number; time: number; type: string; data: Record<string, unknown>; sourceEventSeqs?: readonly number[] }> = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'root-1', name: 'run_code', arguments: '{}' } },
      { seq: 1, time: 21, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    const first = {
      ...execution(owner), callId: 'sub-1' as ToolExecution['callId'], rootCallId: 'root-1' as ToolExecution['callId'],
      parent: Symbol('root-a') as NonNullable<ToolExecution['parent']>,
    } as ToolExecution
    await bridge.project(first)
    events.push({ seq: 2, time: 22, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } })
    const second = {
      ...execution(owner), callId: 'sub-1' as ToolExecution['callId'], rootCallId: 'root-1' as ToolExecution['callId'],
      parent: Symbol('root-b') as NonNullable<ToolExecution['parent']>,
    } as ToolExecution
    await bridge.project(second)
    events.push(
      { seq: 3, time: 23, type: 'tool/code-dispatch', sourceEventSeqs: [1], data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' }, isError: false, content: [] } },
      { seq: 4, time: 24, type: 'tool/code-dispatch', sourceEventSeqs: [2], data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' }, isError: false, content: [] } },
    )
    const snapshot = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)

    await expect(recovered.repairHistoricalResults(owner, snapshot, 5)).resolves.toBe(2)
    const repaired = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    expect(repaired).toEqual(expect.arrayContaining([
      expect.objectContaining({ request: expect.objectContaining({ eventSeq: 1 }), result: expect.objectContaining({ eventSeq: 3 }) }),
      expect.objectContaining({ request: expect.objectContaining({ eventSeq: 2 }), result: expect.objectContaining({ eventSeq: 4 }) }),
    ]))
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
    await bridge.observeSessionEvent(owner, (owner.session as unknown as { snapshotEvents: () => readonly { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown }[] }).snapshotEvents()[2]!)
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

  it('writes one safe approval-bound ledger row and ignores duplicate delivery', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const rows: any[] = []
    const ledger: SealedFactsLedger = { async read () { return rows }, async append (seal, activity) { if (rows.some(row => row.seal.sourceSeq === seal.sourceSeq)) return 'identical'; rows.push({ seal, activity }); return 'created' } }
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      { seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ text: 'secret' }] }] } } },
    ]
    const owner = agent(events); const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, ledger)
    const exec = execution(owner); await bridge.project(exec); await bridge.observeSessionEvent(owner, events[1]!); bridge.observeResult(exec, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, events[2]!); await bridge.observeSessionEvent(owner, events[2]!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ seal: { sourceSeq: 0, approvalAsked: { eventSeq: 1 }, result: { status: 'completed' } }, activity: { occurredAt: 22, targetSummary: 'tool:bash' } })
    expect(JSON.stringify(rows)).not.toContain('secret')
  })

  it('seals an approval-bound code-dispatch result by subCallId', async () => {
    const repository = new InMemoryExecutionFactRepository(), approvals = new InMemoryApprovalSnapshotRepository(), rows: any[] = []
    const ledger: SealedFactsLedger = { async read () { return rows }, async append (seal, activity) { rows.push({ seal, activity }); return 'created' } }
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'root-1', name: 'run_code' } },
      { seq: 1, time: 21, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } },
      { seq: 2, time: 22, type: 'approval/asked', data: { id: 'a1', callId: 'sub-1', toolName: 'bash' } },
      { seq: 3, time: 23, type: 'tool/code-dispatch', sourceEventSeqs: [1], data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' }, isError: false, content: [] } },
    ]
    const owner = agent(events), exec = { ...execution(owner), callId: 'sub-1', rootCallId: 'root-1', parent: {} as ToolExecution } as unknown as ToolExecution
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, ledger)
    await bridge.project(exec); await bridge.observeSessionEvent(owner, events[2]!); bridge.observeResult(exec, { isError: false, value: null, content: [] })
    await bridge.observeSessionEvent(owner, events[3]!);
    expect(rows).toHaveLength(1); expect(rows[0].seal).toMatchObject({ sourceSeq: 1, request: { eventType: 'tool/code-dispatch-start', callId: 'sub-1' } })
  })

  it('does not seal an aborted execution when its result arrives afterward', async () => {
    const repository = new InMemoryExecutionFactRepository(), approvals = new InMemoryApprovalSnapshotRepository(), rows: any[] = []
    const ledger: SealedFactsLedger = { async read () { return rows }, async append (seal, activity) { rows.push({ seal, activity }); return 'created' } }
    const events = [{ seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } }, { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } }, { seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } }]
    const owner = agent(events), abort = new AbortController(), exec = { ...execution(owner), signal: abort.signal } as ToolExecution
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, ledger)
    await bridge.project(exec); await bridge.observeSessionEvent(owner, events[1]!); abort.abort(); bridge.observeResult(exec, { isError: false, value: null, content: [] }); await bridge.observeSessionEvent(owner, events[2]!)
    expect(rows).toEqual([]); await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 })).resolves.toMatchObject({ result: { eventSeq: 2 } })
  })

  it('leaves the host result attached when the ledger read is unavailable', async () => {
    const repository = new InMemoryExecutionFactRepository(), approvals = new InMemoryApprovalSnapshotRepository(), append = vi.fn()
    const ledger: SealedFactsLedger = { async read () { return undefined }, append }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const events = [{ seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } }, { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } }, { seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } }]
    const owner = agent(events), bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, ledger), exec = execution(owner)
    await bridge.project(exec); await bridge.observeSessionEvent(owner, events[1]!); bridge.observeResult(exec, { isError: false, value: null, content: [] }); await expect(bridge.observeSessionEvent(owner, events[2]!)).resolves.toBeUndefined()
    expect(append).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith('[approve-for-me ledger] seal-chain-unavailable'); await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 })).resolves.toMatchObject({ result: { eventSeq: 2 } }); error.mockRestore()
  })

  it('links a new catalog epoch to the preceding seal', async () => {
    const repository = new InMemoryExecutionFactRepository(), approvals = new InMemoryApprovalSnapshotRepository(), rows: any[] = []
    const ledger: SealedFactsLedger = { async read () { return rows }, async append (seal, activity) { rows.push({ seal, activity }); return 'created' } }
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } }, { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } }, { seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
      { seq: 3, time: 23, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'bash' } }, { seq: 4, time: 24, type: 'approval/asked', data: { id: 'a2', callId: 'call-2', toolName: 'bash' } }, { seq: 5, time: 25, type: 'tool/result', sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'tool-result', toolCallId: 'call-2', isError: false, content: [] }] } } },
    ]
    const owner = agent(events); const source = (exec: ToolExecution) => ({ ...effectiveCatalog(exec), commitment: { ...effectiveCatalog(exec).commitment, fingerprint: exec.callId === 'call-2' ? 'sha256:' + 'c'.repeat(64) : effectiveCatalog(exec).commitment.fingerprint } })
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, source, repository, approvals, undefined, ledger)
    for (const [ask, result, callId] of [[1, 2, 'call-1'], [4, 5, 'call-2']] as const) { const exec = { ...execution(owner), callId, rootCallId: callId } as ToolExecution; await bridge.project(exec); await bridge.observeSessionEvent(owner, events[ask]!); bridge.observeResult(exec, { isError: false, value: null, content: [] }); await bridge.observeSessionEvent(owner, events[result]!) }
    expect(rows[1].seal).toMatchObject({ catalog: { epoch: 1 }, epochBoundary: { previousEpoch: 0, changed: true }, previousSealHash: rows[0].seal.sealHash })
  })

  it.each([['completed', false, undefined], ['tool-error', true, undefined], ['sandbox-denied', false, { sandbox: { denied: true, mode: 'read-only' } }]])('seals %s result category', async (category, isError, value) => {
    const repository = new InMemoryExecutionFactRepository(), approvals = new InMemoryApprovalSnapshotRepository(), rows: any[] = []
    const ledger: SealedFactsLedger = { async read () { return rows }, async append (seal, activity) { rows.push({ seal, activity }); return 'created' } }
    const events = [{ seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } }, { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } }, { seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError, content: [] }] } } }]
    const owner = agent(events), bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, ledger), exec = execution(owner)
    await bridge.project(exec); await bridge.observeSessionEvent(owner, events[1]!); const observed = isError ? { isError: true as const, error: new Error('private'), content: [] } : { isError: false as const, value: value ?? null, content: [] }; bridge.observeResult(exec, observed); await bridge.observeSessionEvent(owner, events[2]!); expect(rows[0]).toMatchObject({ seal: { result: { status: category } }, activity: { resultCategory: category } })
  })

  it('does not write a ledger row without a matching approval ask', async () => {
    const repository = new InMemoryExecutionFactRepository(), rows: any[] = [], append = vi.fn(async () => 'created' as const)
    const ledger: SealedFactsLedger = { async read () { return rows }, append }
    const events = [{ seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } }, { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } }]
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const owner = agent(events), bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, new InMemoryApprovalSnapshotRepository(), undefined, ledger), exec = execution(owner)
    await bridge.project(exec); bridge.observeResult(exec, { isError: false, value: null, content: [] }); await bridge.observeSessionEvent(owner, events[1]!); expect(append).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); error.mockRestore()
  })

  it('resolves awaitApprovalSnapshot, repairHistoricalResults and attachResult with zero full snapshotEvents calls', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events: Array<{ seq: number; time: number; type: string; data: Record<string, unknown>; sourceEventSeqs?: readonly number[] }> = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      { seq: 2, time: 22, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
    ]
    const session = {
      id: 'session-1',
      header: { id: 'session-1', version: 1, createdAt: 10 },
      snapshotEvents: () => events,
      get seq () { return events.length },
      eventAt: (seq: number) => events[seq],
    }
    const owner = { id: 'session-1', session } as unknown as Agent
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    // The capture path is a legacy full scan; it is not part of the approval hot path.
    await bridge.project(execution(owner))
    const spy = vi.fn(() => events)
    session.snapshotEvents = spy

    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBe(1)
    expect(spy).not.toHaveBeenCalled()

    const records = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    expect(await bridge.repairHistoricalResults(owner, records, 3)).toBe(1)
    expect(spy).not.toHaveBeenCalled()

    await bridge.observeSessionEvent(owner, events[2]!)
    expect(spy).not.toHaveBeenCalled()
  })

  it('fails closed when the volatile asked index contradicts the requested tool identity', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    await bridge.project(execution(owner))
    await bridge.observeSessionEvent(owner, events[1]!)
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-other', 'bash')).toBeUndefined()
  })

  it('fails closed on duplicate approval/asked events for one request id', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      { seq: 2, time: 22, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBeUndefined()
  })

  it('fails closed when the approval ask is older than the sealed tail window', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events: Array<{ seq: number; time: number; type: string; data: Record<string, unknown> }> = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      ...Array.from({ length: 5 }, (_value, index) => ({ seq: index + 1, time: index + 21, type: 'tool/result', data: {} })),
      { seq: 6, time: 26, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      ...Array.from({ length: 5 }, (_value, index) => ({ seq: index + 7, time: index + 27, type: 'tool/result', data: {} })),
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, undefined, 2)
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBeUndefined()
  })

  it('does not cold-repair a row whose result is older than the sealed tail window', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
      { seq: 2, time: 22, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-2', name: 'bash' } },
    ]
    const owner = agent(events)
    const live = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await live.project(execution(owner))
    const snapshot = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, undefined, undefined, undefined, 1)
    expect(await recovered.repairHistoricalResults(owner, snapshot, 3)).toBe(0)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 })).resolves.not.toHaveProperty('result')
  })

  it('does not write an approval snapshot when its source request is older than the sealed tail window', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events: Array<{ seq: number; time: number; type: string; data: Record<string, unknown> }> = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      ...Array.from({ length: 10 }, (_value, index) => ({ seq: index + 1, time: index + 21, type: 'tool/result', data: {} })),
      { seq: 11, time: 31, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, undefined, 2)
    await bridge.project(execution(owner))
    await bridge.observeSessionEvent(owner, events[11]!)
    await expect(approvals.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })).resolves.toHaveLength(0)
  })

  it('fails closed when a live duplicate approval/asked reuses the request id at a different seq', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      { seq: 2, time: 22, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    // Inject each ask through the live observer. After each write settles the
    // resolved index entry is cleaned; the second ask then resolves via a re-scan
    // whose duplicate guard must fail closed.
    await bridge.observeSessionEvent(owner, events[1]!)
    await bridge.observeSessionEvent(owner, events[2]!)
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBeUndefined()
  })

  it('poisons the volatile asked index on a live duplicate ask so a racing resolve fails closed', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      { seq: 2, time: 22, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    // Fire-and-forget: the second observer runs before either write settles, so the
    // same key with a different seq must poison the index immediately.
    void bridge.observeSessionEvent(owner, events[1]!)
    void bridge.observeSessionEvent(owner, events[2]!)
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBeUndefined()
  })

  it('fails closed when the re-read eventAt diverges from the resolved asked identity', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals)
    // Populate the index without letting its settle cleanup run (fire-and-forget).
    void bridge.observeSessionEvent(owner, events[1]!)
    // Re-read seq 1 as a different request: the resolved identity must be rechecked,
    // not merely that the event is some approval/asked.
    const session = (owner as unknown as { session: { eventAt: (seq: number) => unknown } }).session
    session.eventAt = () => ({ seq: 1, time: 21, type: 'approval/asked', data: { id: 'a2', callId: 'call-2', toolName: 'bash' } })
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBeUndefined()
  })

  it('pins the cold-repair lower bound as inclusive so a result exactly at the edge is repaired', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const events = [
      { seq: 0, time: 20, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'tool/result', sourceEventSeqs: [0], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [] }] } } },
      { seq: 2, time: 22, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-2', name: 'bash' } },
    ]
    const owner = agent(events)
    const live = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository)
    await live.project(execution(owner))
    const snapshot = await repository.list({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
    // window=2, throughSeq=3 → inclusive lower=1; the result at seq1 is exactly at the
    // edge and must be repaired. An exclusive lower=2 would drop it.
    const recovered = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, undefined, undefined, undefined, 2)
    expect(await recovered.repairHistoricalResults(owner, snapshot, 3)).toBe(1)
    await expect(repository.get({ session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 }, callId: 'call-1', requestEventSeq: 0 })).resolves.toMatchObject({ result: { eventSeq: 1 } })
  })

  it('keeps the poison permanent even when the first ask is beyond the sealed tail window', async () => {
    const repository = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    // window=2: the scan covers only seq10..seq11. The duplicate at seq11 is in the
    // window, but the first ask at seq1 is not. Only the persistent poisoned index
    // (not the bounded scan) can fail this closed, proving index poison-permanence.
    const events: Array<{ seq: number; time: number; type: string; data: Record<string, unknown> }> = [
      { seq: 0, time: 20, type: 'tool/call', data: { callId: 'call-1', name: 'bash' } },
      { seq: 1, time: 21, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
      ...Array.from({ length: 9 }, (_value, index) => ({ seq: index + 2, time: index + 22, type: 'tool/result', data: {} })),
      { seq: 11, time: 31, type: 'approval/asked', data: { id: 'a1', callId: 'call-1', toolName: 'bash' } },
    ]
    const owner = agent(events)
    const bridge = new DshExecutionFactProjectionBridge({ project: e => ({ toolName: e.name, arguments: e.arguments }) }, effectiveCatalog, repository, approvals, undefined, undefined, 2)
    // First ask (beyond window) observed and settled; entry persists (方案 a).
    await bridge.observeSessionEvent(owner, events[1]!)
    // Duplicate near window observed → same key, different seq → must poison.
    await bridge.observeSessionEvent(owner, events[11]!)
    expect(await bridge.awaitApprovalSnapshot(owner, 'a1', 'call-1', 'bash')).toBeUndefined()
  })
})
