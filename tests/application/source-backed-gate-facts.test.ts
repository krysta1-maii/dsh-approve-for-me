import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParentAuthority } from '../../src/ports/managed-reviewer.js'
import { SourceBackedGateFactResolver } from '../../src/application/source-backed-gate-facts.js'

const agent = { id: 'session-1', session: { id: 'session-1' } } as unknown as Agent
const authority = { sessionId: 'session-1' } as unknown as ParentAuthority<Agent, string>
const request = {
  requestId: 'ask-1', parentSessionId: 'session-1', callId: 'call-1',
  toolName: 'bash', actionHash: 'hash-1', mode: 'auto' as const,
}

function resolver() {
  const snapshot = vi.fn()
  const compile = vi.fn()
  const snapshotInput = vi.fn()
  return {
    snapshot, compile, snapshotInput,
    resolver: new SourceBackedGateFactResolver({
      factSource: { snapshot } as never,
      compiler: { compile } as never,
      projector: { project: vi.fn() },
      snapshotInput,
    }),
  }
}

describe('SourceBackedGateFactResolver', () => {
  it('does not consult a source without the complete exact ask correlation', async () => {
    const subject = resolver()
    const { requestId: _requestId, ...withoutRequestId } = request
    await expect(subject.resolver.resolve(withoutRequestId)).resolves.toBeUndefined()
    await expect(subject.resolver.resolve({ ...request, actionHash: 'other' })).resolves.toBeUndefined()
    expect(subject.snapshotInput).not.toHaveBeenCalled()
    expect(subject.snapshot).not.toHaveBeenCalled()
  })

  it('registration is metadata only and rejects conflicting replacement', () => {
    const subject = resolver()
    const pending = { ...request, agent, authority }
    subject.resolver.register(pending)
    expect(subject.resolver.authorityFor('session-1')).toBe(authority)
    expect(() => subject.resolver.register({ ...pending })).toThrow(/already registered/)
  })

  it('requires an exact source snapshot and a ready branded compilation', async () => {
    const subject = resolver()
    subject.resolver.register({ ...request, agent, authority })
    subject.snapshotInput.mockResolvedValue({
      agent, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash',
    })
    subject.snapshot.mockReturnValue({ source: 'facts' })
    subject.compile.mockReturnValue({ kind: 'incomplete' })
    await expect(subject.resolver.resolve(request)).resolves.toBeUndefined()

    subject.snapshotInput.mockResolvedValue({
      agent, approvalRequestId: 'ask-1', callId: 'wrong', toolName: 'bash',
    })
    await expect(subject.resolver.resolve(request)).resolves.toBeUndefined()
    expect(subject.snapshot).toHaveBeenCalledTimes(1)
  })
})
