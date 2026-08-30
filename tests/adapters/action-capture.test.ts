import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DefaultActionCapture,
  createCaptureBridge,
  createDefaultActionProjector,
  createFilesystemActionProjector,
  createNetworkActionProjector,
  createShellProcessActionProjector,
  createActionSnapshot,
  ToolFamilyActionProjectorRegistry,
} from '../../src/index.js'
import type { ActionProjector } from '../../src/index.js'

function fakeAgent(id: string): Agent {
  return { id: SessionId(id), session: { id: SessionId(id), header: { cwd: '/workspace' } } } as unknown as Agent
}

function fakeExecution(agent: Agent, overrides: {
  callId?: string
  name?: string
  arguments?: unknown
} = {}): ToolExecution {
  return {
    callId: (overrides.callId ?? 'call-1') as ToolExecution['callId'],
    rootCallId: (overrides.callId ?? 'call-1') as ToolExecution['callId'],
    name: overrides.name ?? 'bash',
    arguments: overrides.arguments ?? { command: 'pwd' },
    agent,
    signal: new AbortController().signal,
    token: Symbol('token') as ToolExecution['token'],
  }
}

const allow = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

describe('DefaultActionCapture', () => {
  it('captures, looks up by exact owner identity, and releases', () => {
    const store = new DefaultActionCapture<Agent, string>()
    const owner = fakeAgent('parent-1')
    const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'ls' } })
    store.remember(owner, 'call-1', action)
    expect(store.lookup(owner, 'call-1', 'bash')).toBe(action)
    expect(store.lookup(owner, 'call-1', 'read')).toBeUndefined()
    expect(store.lookup(fakeAgent('parent-other'), 'call-1', 'bash')).toBeUndefined()
    expect(store.release(owner, 'call-1')).toBe(true)
    expect(store.release(owner, 'call-1')).toBe(false)
  })

  it('rejects duplicate call ids for one owner', () => {
    const store = new DefaultActionCapture<Agent, string>()
    const owner = fakeAgent('parent-1')
    const action = createActionSnapshot({ toolName: 'bash', arguments: {} })
    store.remember(owner, 'call-1', action)
    expect(() => store.remember(owner, 'call-1', action)).toThrow(/already captured/)
  })
})

describe('shell/process semantic projection', () => {
  it('captures command, argv, cwd and environment under a stable semantic identity', () => {
    const projector = new ToolFamilyActionProjectorRegistry([
      createShellProcessActionProjector(['bash']),
    ])
    const action = createActionSnapshot(projector.project(fakeExecution(fakeAgent('parent-1'), {
      arguments: { command: 'git status', argv: ['git', 'status'], env: { LANG: 'C' } },
    })))
    expect(action).toMatchObject({
      projectorId: 'dsh-approve-for-me/shell-process-v1',
      semantics: { family: 'shell-process-v1', value: { command: 'git status', argv: ['git', 'status'], cwd: '/workspace', environment: { LANG: 'C' } } },
    })
  })

  it.each([
    [{}, /non-empty command/],
    [{ command: 'pwd', argv: [1] }, /argv/],
    [{ command: 'pwd', env: { HOME: 1 } }, /env/],
    [{ command: 'x'.repeat(32_769) }, /command/],
  ])('fails closed for incomplete or ambiguous shell arguments', (rawArguments, message) => {
    const projector = createShellProcessActionProjector()
    expect(() => projector.project(fakeExecution(fakeAgent('parent-1'), { arguments: rawArguments }))).toThrow(message)
  })
})

describe('filesystem semantic projection', () => {
  it.each([
    ['read', { path: 'src/index.ts' }, { operation: 'read', targets: [{ path: 'src/index.ts', role: 'target' }], recursive: false, reversible: true }],
    ['write', { path: 'notes/a.txt', recursive: true }, { operation: 'write', targets: [{ path: 'notes/a.txt', role: 'target' }], recursive: true, reversible: false }],
    ['move', { source: 'old.txt', destination: 'new.txt' }, { operation: 'move', targets: [{ path: 'old.txt', role: 'source' }, { path: 'new.txt', role: 'destination' }], recursive: false, reversible: false }],
    ['list', { root: 'src' }, { operation: 'list', targets: [{ path: 'src', role: 'root' }], recursive: false, reversible: true }],
  ] as const)('projects bounded %s semantics', (name, arguments_, expected) => {
    const projector = new ToolFamilyActionProjectorRegistry([createFilesystemActionProjector()])
    const action = createActionSnapshot(projector.project(fakeExecution(fakeAgent('parent-1'), { name, arguments: arguments_ })))
    expect(action).toMatchObject({ projectorId: 'dsh-approve-for-me/filesystem-v1', semantics: { family: 'filesystem-v1', value: expected } })
    expect(Object.isFrozen(action.semantics.value)).toBe(true)
  })

  it.each([
    ['read', {}, /workspace-relative path/],
    ['write', { path: '/outside' }, /workspace-relative path/],
    ['move', { source: 'same', destination: 'same' }, /duplicate targets/],
    ['glob', { root: 'src', recursive: true }, /does not accept recursive/],
    ['delete', { path: 'src/../secret' }, /workspace-relative path/],
    ['mkdir', { path: 'dir', recursive: 'yes' }, /recursive/],
  ] as const)('fails closed for incomplete or ambiguous %s semantics', (name, arguments_, message) => {
    const projector = createFilesystemActionProjector()
    expect(() => projector.project(fakeExecution(fakeAgent('parent-1'), { name, arguments: arguments_ }))).toThrow(message)
  })

  it('rejects oversized filesystem payloads and duplicate tool registrations', () => {
    const projector = createFilesystemActionProjector()
    expect(() => projector.project(fakeExecution(fakeAgent('parent-1'), { name: 'write', arguments: { path: 'x', content: 'x'.repeat(65_536) } }))).toThrow(/budget/)
    expect(() => createFilesystemActionProjector({ read: 'same', write: 'same' })).toThrow(/unique/)
    expect(() => createFilesystemActionProjector({ unknown: 'mystery' } as never)).toThrow(/unknown operation/)
  })
})

describe('network semantic projection', () => {
  it('projects an exact HTTP target and content-free payload commitments', () => {
    const projector = new ToolFamilyActionProjectorRegistry([createNetworkActionProjector({ httpRequest: 'fetch' })])
    const action = createActionSnapshot(projector.project(fakeExecution(fakeAgent('parent-1'), {
      name: 'fetch', arguments: { url: 'https://EXAMPLE.test:443/a?q=1', method: 'post', headers: { Authorization: 'secret', Accept: 'text/plain' }, body: 'hello', redirect: 'manual' },
    })))
    expect(action).toMatchObject({
      projectorId: 'dsh-approve-for-me/network-v1',
      semantics: { family: 'network-v1', value: { operation: 'http-request', target: { scheme: 'https', hostname: 'example.test', port: 443, pathAndQuery: '/a?q=1' }, method: 'POST', headers: [{ name: 'accept' }, { name: 'authorization' }], body: { kind: 'utf8', byteLength: 5, sha256: expect.stringMatching(/^sha256:/) }, redirect: 'manual' } },
    })
    expect(Object.isFrozen(action.semantics.value)).toBe(true)
  })

  it.each([
    [{ url: 'file:///secret', method: 'GET', redirect: 'error' }, /http\(s\)/],
    [{ url: 'https://user@example.test/a', method: 'GET', redirect: 'error' }, /credential-free/],
    [{ url: 'https://example.test/a#fragment', method: 'GET', redirect: 'error' }, /fragment-free/],
    [{ url: 'https://example.test/a', method: 'GET', redirect: 'follow' }, /redirect/],
    [{ url: 'https://example.test/a', method: 'GET', redirect: 'manual', headers: { A: 'one', a: 'two' } }, /headers/],
    [{ url: 'https://example.test/a', method: 'GET', redirect: 'manual', body: 'x'.repeat(32_769) }, /budget/],
    [{ url: 'https://example.test/a', method: 'GET', redirect: 'manual', extra: true }, /unrecognized/],
  ])('fails closed for incomplete or ambiguous HTTP arguments', (arguments_, _message) => {
    const projector = createNetworkActionProjector({ httpRequest: 'fetch' })
    expect(() => projector.project(fakeExecution(fakeAgent('parent-1'), { name: 'fetch', arguments: arguments_ }))).toThrow(TypeError)
  })

  it('requires one explicit known HTTP tool binding', () => {
    expect(() => createNetworkActionProjector({ httpRequest: '' })).toThrow(/non-empty/)
    expect(() => createNetworkActionProjector({ httpRequest: 'fetch', websocket: 'ws' } as never)).toThrow(/unknown operation/)
  })
})

describe('createCaptureBridge', () => {
  it('projects and freezes the complete action before the approval ask', async () => {
    const store = new DefaultActionCapture<Agent, string>()
    const permissions = [{ kind: 'sandbox' as const, scope: 'workspace-write' }]
    const projector: ActionProjector<ToolExecution> = createDefaultActionProjector(execution =>
      execution.name === 'bash' ? permissions : [])
    const bridge = createCaptureBridge(projector, store)
    const owner = fakeAgent('parent-1')
    const execution = fakeExecution(owner)
    const decision = await bridge.preExecute(execution, allow)
    expect(decision).toEqual({ kind: 'allow' })
    const captured = store.lookup(owner, 'call-1', 'bash')!
    expect(captured).toMatchObject({
      toolName: 'bash',
      arguments: { command: 'pwd' },
      requestedPermissions: [{ kind: 'sandbox', scope: 'workspace-write' }],
    })
    expect(Object.isFrozen(captured.arguments)).toBe(true)
  })

  it('skips capture for executions without a caller agent', async () => {
    const store = new DefaultActionCapture<Agent, string>()
    const bridge = createCaptureBridge(createDefaultActionProjector(), store)
    const execution = fakeExecution(fakeAgent('x'), { callId: 'call-1' })
    const callerLess: ToolExecution = {
      callId: execution.callId,
      rootCallId: execution.rootCallId,
      name: execution.name,
      arguments: execution.arguments,
      signal: execution.signal,
      token: execution.token,
    }
    await expect(bridge.preExecute(callerLess, allow)).resolves.toEqual({ kind: 'allow' })
    bridge.observeResult(callerLess)
    expect(() => store.remember(fakeAgent('parent-1'), 'call-1', createActionSnapshot({ toolName: 'x', arguments: {} })))
      .not.toThrow()
  })

  it('releases the capture when the tool result settles', async () => {
    const store = new DefaultActionCapture<Agent, string>()
    const bridge = createCaptureBridge(createDefaultActionProjector(), store)
    const owner = fakeAgent('parent-1')
    const execution = fakeExecution(owner)
    await bridge.preExecute(execution, allow)
    expect(store.lookup(owner, 'call-1', 'bash')).toBeDefined()
    bridge.observeResult(execution)
    expect(store.lookup(owner, 'call-1', 'bash')).toBeUndefined()
  })

  it('skips capture instead of breaking the tool call for unsnapshottable arguments', async () => {
    const store = new DefaultActionCapture<Agent, string>()
    const bridge = createCaptureBridge(createDefaultActionProjector(), store)
    const owner = fakeAgent('parent-1')
    const execution = fakeExecution(owner, { arguments: { command: undefined } })
    // The action cannot survive the lossless-JSON boundary: the tool call
    // must still proceed and the approval ask must fail closed without it.
    await expect(bridge.preExecute(execution, allow)).resolves.toEqual({ kind: 'allow' })
    expect(store.lookup(owner, 'call-1', 'bash')).toBeUndefined()
    bridge.observeResult(execution)
  })

  it('propagates unexpected projector failures instead of hiding them', async () => {
    const store = new DefaultActionCapture<Agent, string>()
    const projector: ActionProjector<ToolExecution> = {
      project: () => { throw new Error('projector exploded') },
    }
    const bridge = createCaptureBridge(projector, store)
    await expect(bridge.preExecute(fakeExecution(fakeAgent('parent-1')), allow))
      .rejects.toThrow('projector exploded')
  })
})
