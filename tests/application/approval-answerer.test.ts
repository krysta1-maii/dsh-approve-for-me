import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DefaultActionCapture,
  ReviewProtocolError,
  createActionSnapshot,
  createApprovalAnswerer,
} from '../../src/index.js'
import type { ApprovalDecision, ApprovalOutcome, ReviewCoordinator } from '../../src/index.js'

function fakeAgent(id: string): Agent {
  return { id: SessionId(id), session: { id: SessionId(id) } } as unknown as Agent
}

function decision(kind: ApprovalDecision['decision']): ApprovalDecision {
  return {
    protocolVersion: 1,
    reviewId: 'review-1',
    parentSessionId: 'parent-1',
    reviewerSessionId: 'reviewer-1',
    generation: 'generation-1',
    actionHash: `sha256:${'0'.repeat(64)}`,
    decision: kind,
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'Test result.',
  }
}

function coordinatorWith(decisionOrError: ApprovalDecision | Error) {
  const review = vi.fn(async (_input: Parameters<ReviewCoordinator<Agent, string>['review']>[0]) => {
    if (decisionOrError instanceof Error) throw decisionOrError
    return decisionOrError
  })
  return { review }
}

describe('createApprovalAnswerer', () => {
  it('forwards the exact live parent object and maps allow', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    captures.remember(parent, 'call-1', createActionSnapshot({ toolName: 'bash', arguments: {} }))
    const coordinator = coordinatorWith(decision('allow'))
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto' })
    const next = vi.fn(async () => 'rejected' as const)
    await expect(answer({
      agent: parent, toolName: 'bash', callId: 'call-1' as never,
    }, next)).resolves.toBe('allowed-once')
    expect(coordinator.review.mock.calls[0]![0].authority.live).toBe(parent)
    expect(coordinator.review.mock.calls[0]![0].authority.sessionId).toBe('parent-1')
    expect(next).not.toHaveBeenCalled()
  })

  it('delegates human_review only in auto-then-user mode', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    captures.remember(parent, 'call-1', createActionSnapshot({ toolName: 'bash', arguments: {} }))
    const coordinator = coordinatorWith(decision('human_review'))
    const next = vi.fn(async () => 'rejected' as const)
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto-then-user' })
    await expect(answer({
      agent: parent, toolName: 'bash', callId: 'call-1' as never,
    }, next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
  })

  it('fails closed when action arguments were not captured', async () => {
    const parent = fakeAgent('parent-1')
    const coordinator = coordinatorWith(decision('allow'))
    const captures = new DefaultActionCapture<Agent, string>()
    const auto = createApprovalAnswerer({ coordinator, captures, mode: 'auto' })
    const next = vi.fn(async () => 'allowed-once' as const)
    await expect(auto({
      agent: parent, toolName: 'bash', callId: 'missing' as never,
    }, next)).resolves.toBe('unavailable')
    expect(next).not.toHaveBeenCalled()
  })

  it('does not use a capture whose tool name disagrees with the request', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    captures.remember(parent, 'call-1', createActionSnapshot({ toolName: 'read', arguments: {} }))
    const coordinator = coordinatorWith(decision('allow'))
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto' })
    await expect(answer({
      agent: parent, toolName: 'bash', callId: 'call-1' as never,
    }, async () => 'allowed-once' as const)).resolves.toBe('unavailable')
    expect(coordinator.review).not.toHaveBeenCalled()
  })

  it('delegates an uncaptured action in auto-then-user mode', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    const coordinator = coordinatorWith(decision('allow'))
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto-then-user' })
    const next = vi.fn(async () => 'rejected' as const)
    await expect(answer({
      agent: parent, toolName: 'bash',
    }, next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0]).toHaveLength(0)
  })

  it('maps abort to cancelled and all other failures to unavailable', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    captures.remember(parent, 'call-1', createActionSnapshot({ toolName: 'bash', arguments: {} }))
    const aborted = createApprovalAnswerer({
      coordinator: coordinatorWith(new ReviewProtocolError('aborted', 'cancelled')),
      captures,
      mode: 'auto',
    })
    await expect(aborted({
      agent: parent, toolName: 'bash', callId: 'call-1' as never,
    }, async () => 'rejected' as const)).resolves.toBe('cancelled')
    const failed = createApprovalAnswerer({
      coordinator: coordinatorWith(new Error('model failed')),
      captures,
      mode: 'auto',
    })
    await expect(failed({
      agent: parent, toolName: 'bash', callId: 'call-1' as never,
    }, async () => 'rejected' as const)).resolves.toBe('unavailable')
  })

  it('returns cancelled when the request signal is already aborted', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    const coordinator = coordinatorWith(decision('allow'))
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto' })
    const abort = new AbortController()
    abort.abort()
    await expect(answer({
      agent: parent, toolName: 'bash', callId: 'call-1' as never, signal: abort.signal,
    }, async () => 'allowed-once' as const)).resolves.toBe('cancelled')
    expect(coordinator.review).not.toHaveBeenCalled()
  })

  it('forwards reason and signal into the review', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    captures.remember(parent, 'call-1', createActionSnapshot({ toolName: 'bash', arguments: {} }))
    const coordinator = coordinatorWith(decision('allow'))
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto' })
    const abort = new AbortController()
    await answer({
      agent: parent, toolName: 'bash', callId: 'call-1' as never,
      reason: 'wider sandbox', signal: abort.signal,
    }, async () => 'rejected' as const)
    expect(coordinator.review.mock.calls[0]![0]).toMatchObject({
      callId: 'call-1',
      reason: 'wider sandbox',
      signal: abort.signal,
    })
  })

  it('maps an allow decision to allowed-once when the request carries a call id', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    captures.remember(parent, 'call-2', createActionSnapshot({ toolName: 'read', arguments: { path: 'x' } }))
    const coordinator = coordinatorWith(decision('allow'))
    const answer = createApprovalAnswerer({ coordinator, captures, mode: 'auto' })
    const next = vi.fn(async () => 'rejected' as const)
    await expect(answer({
      agent: parent, toolName: 'read', callId: 'call-2' as never,
    }, next)).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    expect(coordinator.review.mock.calls[0]![0].action).toMatchObject({
      toolName: 'read',
      arguments: { path: 'x' },
    })
  })

  it('exposes a next type compatible with the DSH waterfall', async () => {
    const parent = fakeAgent('parent-1')
    const captures = new DefaultActionCapture<Agent, string>()
    const answer = createApprovalAnswerer({
      coordinator: coordinatorWith(decision('allow')),
      captures,
      mode: 'auto',
    })
    const handler: (request: { agent: Agent; toolName: string; callId?: string | undefined }, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> = answer as never
    expect(typeof handler).toBe('function')
  })
})
