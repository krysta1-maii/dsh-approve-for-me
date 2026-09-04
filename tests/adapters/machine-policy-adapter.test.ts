import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ApprovalRunLifecycle, GateFailure, createMachinePolicyAdapter } from '../../src/index.js'
import type { GateMachinePolicyV1, GateMachineRequestV1 } from '../../src/approval-gate/machine-policy.js'

function fakeAgent(id = 'parent-1'): Agent {
  return { id: SessionId(`agent-${id}`), session: { id: SessionId(id) } } as unknown as Agent
}

function gateRecording() {
  const decisions: GateMachineRequestV1[] = []
  const gate: GateMachinePolicyV1 = {
    id: 'dsh-approve-for-me/v1',
    async decide(request) {
      decisions.push(request)
      return 'delegate'
    },
  }
  return { gate, decisions }
}

describe('createMachinePolicyAdapter', () => {
  it('maps the patched approval ask onto the DSH-neutral gate request', async () => {
    const { gate, decisions } = gateRecording()
    const adapter = createMachinePolicyAdapter({
      gate,
      mode: 'auto',
      timeoutMs: 500,
      now: () => 1_000,
      resolveActionHash: vi.fn(() => `sha256:${'a'.repeat(64)}`),
    })

    const result = await adapter.decide({
      agent: fakeAgent(),
      toolName: 'bash',
      requestId: 'ask-123',
      callId: 'call-1',
      reason: 'requires a wider sandbox',
      signal: new AbortController().signal,
    })

    expect(result).toBe('delegate')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      requestId: 'ask-123',
      parentSessionId: 'parent-1',
      callId: 'call-1',
      toolName: 'bash',
      reason: 'requires a wider sandbox',
      actionHash: `sha256:${'a'.repeat(64)}`,
      deadlineAt: 1_500,
      mode: 'auto',
    })
    expect(decisions[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed without requestId or callId before invoking the gate', async () => {
    const { gate, decisions } = gateRecording()
    const adapter = createMachinePolicyAdapter({
      gate,
      mode: 'auto-then-user',
      resolveActionHash: () => `sha256:${'b'.repeat(64)}`,
    })

    await expect(adapter.decide({ agent: fakeAgent(), toolName: 'read', callId: 'call-1' })).resolves.toBe('unavailable')
    await expect(adapter.decide({ agent: fakeAgent(), toolName: 'read', requestId: 'ask-1' })).resolves.toBe('unavailable')
    expect(decisions).toEqual([])
  })

  it('lets the gate outcome pass through as the machine-policy answer', async () => {
    const gate: GateMachinePolicyV1 = {
      id: 'dsh-approve-for-me/v1',
      async decide() {
        return 'allowed-once'
      },
    }
    const adapter = createMachinePolicyAdapter({
      gate,
      mode: 'auto',
      resolveActionHash: () => `sha256:${'c'.repeat(64)}`,
    })

    await expect(adapter.decide({
      agent: fakeAgent(),
      toolName: 'bash',
      requestId: 'ask-1',
      callId: 'call-1',
    })).resolves.toBe('allowed-once')
  })

  it('maps unresolved and integrity action failures closed', async () => {
    const { gate } = gateRecording()
    const empty = createMachinePolicyAdapter({ gate, mode: 'auto', resolveActionHash: () => '' })
    await expect(empty.decide({ agent: fakeAgent(), toolName: 'bash', requestId: 'ask-1', callId: 'call-1' })).resolves.toBe('unavailable')
    const integrity = createMachinePolicyAdapter({
      gate,
      mode: 'auto-then-user',
      resolveActionHash: () => { throw new GateFailure('integrity', 'capture conflicted') },
    })
    await expect(integrity.decide({ agent: fakeAgent(), toolName: 'bash', requestId: 'ask-2', callId: 'call-2' })).resolves.toBe('unavailable')
  })

  it('delegates only explicit retryable failures in auto-then-user mode', async () => {
    const { gate } = gateRecording()
    const retryable = () => { throw new GateFailure('retryable-capability', 'reviewer unavailable') }
    const auto = createMachinePolicyAdapter({ gate, mode: 'auto', resolveActionHash: retryable })
    const user = createMachinePolicyAdapter({ gate, mode: 'auto-then-user', resolveActionHash: retryable })
    const ask = { agent: fakeAgent(), toolName: 'bash', requestId: 'ask-1', callId: 'call-1' }
    await expect(auto.decide(ask)).resolves.toBe('unavailable')
    await expect(user.decide(ask)).resolves.toBe('delegate')
  })

  it('returns cancelled promptly when caller aborts a non-cooperative gate', async () => {
    const lifecycle = new ApprovalRunLifecycle()
    let release!: () => void
    const gate: GateMachinePolicyV1 = {
      id: 'dsh-approve-for-me/v1',
      decide: vi.fn(async () => new Promise<'unavailable'>(resolve => { release = () => resolve('unavailable') })),
    }
    const adapter = createMachinePolicyAdapter({
      gate,
      lifecycle,
      mode: 'auto',
      resolveActionHash: () => `sha256:${'e'.repeat(64)}`,
    })
    const abort = new AbortController()
    const decision = adapter.decide({ agent: fakeAgent(), toolName: 'bash', requestId: 'ask-1', callId: 'call-1', signal: abort.signal })
    await vi.waitFor(() => expect(gate.decide).toHaveBeenCalledOnce())

    abort.abort({ kind: 'user' })
    await expect(decision).resolves.toBe('cancelled')
    release()
    await lifecycle.dispose()
  })

  it('bounds a non-cooperative gate with the complete approval deadline', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new ApprovalRunLifecycle(100)
      let release!: () => void
      const gate: GateMachinePolicyV1 = {
        id: 'dsh-approve-for-me/v1',
        decide: vi.fn(async () => new Promise<'unavailable'>(resolve => { release = () => resolve('unavailable') })),
      }
      const adapter = createMachinePolicyAdapter({
        gate,
        lifecycle,
        mode: 'auto-then-user',
        resolveActionHash: () => `sha256:${'f'.repeat(64)}`,
      })
      const decision = adapter.decide({ agent: fakeAgent(), toolName: 'bash', requestId: 'ask-1', callId: 'call-1' })
      await vi.advanceTimersByTimeAsync(100)

      await expect(decision).resolves.toBe('unavailable')
      release()
      await lifecycle.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an already aborted request and exposes a stable id', async () => {
    const { gate } = gateRecording()
    const adapter = createMachinePolicyAdapter({ gate, mode: 'auto', resolveActionHash: () => `sha256:${'d'.repeat(64)}` })
    const abort = new AbortController()
    abort.abort()
    await expect(adapter.decide({ agent: fakeAgent(), toolName: 'bash', requestId: 'ask-1', callId: 'call-1', signal: abort.signal })).resolves.toBe('cancelled')
    expect(adapter.id).toBe('dsh-approve-for-me/v1')
  })
})
