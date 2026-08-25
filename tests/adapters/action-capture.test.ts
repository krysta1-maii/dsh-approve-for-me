import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DefaultActionCapture,
  createCaptureBridge,
  createDefaultActionProjector,
  createActionSnapshot,
} from '../../src/index.js'
import type { ActionProjector } from '../../src/index.js'

function fakeAgent(id: string): Agent {
  return { id: SessionId(id), session: { id: SessionId(id) } } as unknown as Agent
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
