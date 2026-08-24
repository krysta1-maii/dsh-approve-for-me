import { describe, expect, it, vi } from 'vitest'
import {
  ActionCaptureStore,
  ReviewProtocolError,
  createApprovalAnswerer,
  createReviewerProviderData,
} from '../src/index.js'
import type { ApprovalDecision, ApprovalReviewer } from '../src/index.js'

type Parent = { id: string }

const providerData = createReviewerProviderData({
  generation: 'generation-1',
  modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  policyVersion: 'policy-1',
  toolsetVersion: 1,
})

function captured(store: ActionCaptureStore<Parent>, parent: Parent): void {
  store.capture(parent, {
    parentSessionId: parent.id,
    callId: 'call-1',
    toolName: 'bash',
    arguments: { command: 'pwd' },
  })
}

function reviewerWith(decision: ApprovalDecision | Error): ApprovalReviewer<Parent> & { review: ReturnType<typeof vi.fn> } {
  return {
    review: vi.fn(async () => {
      if (decision instanceof Error) throw decision
      return decision
    }),
  }
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

describe('createApprovalAnswerer', () => {
  it('forwards the exact live parent object and maps allow', async () => {
    const parent = { id: 'parent-1' }
    const captures = new ActionCaptureStore<Parent>()
    captured(captures, parent)
    const reviewer = reviewerWith(decision('allow'))
    const answer = createApprovalAnswerer(reviewer, captures, {
      mode: 'auto', providerData, parentSessionId: value => value.id,
    })
    const next = vi.fn(async () => 'rejected' as const)
    await expect(answer({ agent: parent, toolName: 'bash', callId: 'call-1' }, next)).resolves.toBe('allowed-once')
    expect(reviewer.review.mock.calls[0]![0]).toBe(parent)
    expect(next).not.toHaveBeenCalled()
  })

  it('delegates human_review only in auto-then-user mode', async () => {
    const parent = { id: 'parent-1' }
    const captures = new ActionCaptureStore<Parent>()
    captured(captures, parent)
    const reviewer = reviewerWith(decision('human_review'))
    const next = vi.fn(async () => 'rejected' as const)
    const answer = createApprovalAnswerer(reviewer, captures, {
      mode: 'auto-then-user', providerData, parentSessionId: value => value.id,
    })
    await expect(answer({ agent: parent, toolName: 'bash', callId: 'call-1' }, next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
  })

  it('fails closed when action arguments were not captured', async () => {
    const parent = { id: 'parent-1' }
    const reviewer = reviewerWith(decision('allow'))
    const captures = new ActionCaptureStore<Parent>()
    const auto = createApprovalAnswerer(reviewer, captures, {
      mode: 'auto', providerData, parentSessionId: value => value.id,
    })
    const next = vi.fn(async () => 'allowed-once' as const)
    await expect(auto({ agent: parent, toolName: 'bash', callId: 'missing' }, next)).resolves.toBe('unavailable')
    expect(next).not.toHaveBeenCalled()
  })

  it('does not use a capture whose recorded parent identity disagrees', async () => {
    const parent = { id: 'parent-1' }
    const captures = new ActionCaptureStore<Parent>()
    captures.capture(parent, {
      parentSessionId: 'parent-other', callId: 'call-1', toolName: 'bash', arguments: {},
    })
    const reviewer = reviewerWith(decision('allow'))
    const answer = createApprovalAnswerer(reviewer, captures, {
      mode: 'auto', providerData, parentSessionId: value => value.id,
    })
    await expect(answer({ agent: parent, toolName: 'bash', callId: 'call-1' }, async () => 'allowed-once'))
      .resolves.toBe('unavailable')
    expect(reviewer.review).not.toHaveBeenCalled()
  })

  it('delegates an uncaptured action in auto-then-user mode', async () => {
    const parent = { id: 'parent-1' }
    const reviewer = reviewerWith(decision('allow'))
    const captures = new ActionCaptureStore<Parent>()
    const answer = createApprovalAnswerer(reviewer, captures, {
      mode: 'auto-then-user', providerData, parentSessionId: value => value.id,
    })
    const next = vi.fn(async () => 'rejected' as const)
    await expect(answer({ agent: parent, toolName: 'bash' }, next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
  })

  it('maps abort to cancelled and all other failures to unavailable', async () => {
    const parent = { id: 'parent-1' }
    const captures = new ActionCaptureStore<Parent>()
    captured(captures, parent)
    const aborted = createApprovalAnswerer(
      reviewerWith(new ReviewProtocolError('aborted', 'cancelled')),
      captures,
      { mode: 'auto', providerData, parentSessionId: value => value.id },
    )
    await expect(aborted({ agent: parent, toolName: 'bash', callId: 'call-1' }, async () => 'rejected'))
      .resolves.toBe('cancelled')
    const failed = createApprovalAnswerer(
      reviewerWith(new Error('model failed')),
      captures,
      { mode: 'auto', providerData, parentSessionId: value => value.id },
    )
    await expect(failed({ agent: parent, toolName: 'bash', callId: 'call-1' }, async () => 'rejected'))
      .resolves.toBe('unavailable')
  })
})
