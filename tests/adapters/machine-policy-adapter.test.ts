import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDelegatingGate, createMachinePolicyAdapter } from '../../src/index.js'
import type { GateMachinePolicyV1, GateMachineRequestV1 } from '../../src/approval-gate/machine-policy.js'

function fakeAgent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
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
      mode: 'auto',
    })
    expect(decisions[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes undefined optional fields without inventing identities', async () => {
    const { gate, decisions } = gateRecording()
    const adapter = createMachinePolicyAdapter({
      gate,
      mode: 'auto-then-user',
      resolveActionHash: () => `sha256:${'b'.repeat(64)}`,
    })

    await adapter.decide({
      agent: fakeAgent(),
      toolName: 'read',
    })

    expect(decisions[0]).toMatchObject({
      parentSessionId: 'parent-1',
      toolName: 'read',
      actionHash: `sha256:${'b'.repeat(64)}`,
      mode: 'auto-then-user',
    })
    expect(decisions[0]!.requestId).toBeUndefined()
    expect(decisions[0]!.callId).toBeUndefined()
    expect(decisions[0]!.reason).toBeUndefined()
    expect(decisions[0]!.signal).toBeUndefined()
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
      callId: 'call-1',
    })).resolves.toBe('allowed-once')
  })

  it('fails closed when the action hash cannot be resolved', async () => {
    const adapter = createMachinePolicyAdapter({
      gate: createDelegatingGate(),
      mode: 'auto',
      resolveActionHash: () => '',
    })

    await expect(adapter.decide({
      agent: fakeAgent(),
      toolName: 'bash',
      callId: 'call-1',
    })).rejects.toThrow(/could not resolve an action hash/)
  })

  it('exposes the stable machine-policy id', () => {
    expect(createMachinePolicyAdapter({
      gate: createDelegatingGate(),
      mode: 'auto',
      resolveActionHash: () => `sha256:${'d'.repeat(64)}`,
    }).id).toBe('dsh-approve-for-me/v1')
  })

  it('uses the transitional gate while P2 is not installed', async () => {
    const gate = createDelegatingGate()
    await expect(gate.decide({
      parentSessionId: 'parent-1',
      toolName: 'bash',
      actionHash: `sha256:${'e'.repeat(64)}`,
      mode: 'auto',
    })).resolves.toBe('delegate')
  })
})
