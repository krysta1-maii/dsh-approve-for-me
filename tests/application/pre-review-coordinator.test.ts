import { describe, expect, it, vi } from 'vitest'
import {
  DefaultPreReviewCoordinator,
  InMemorySealedDispositionRegistry,
  createActionSnapshot,
  hashAction,
  assessVerifiedActionV1,
} from '../../src/index.js'
import { sealSourceVerifiedDossier } from '../../src/domain/dossier.js'
import type { ApprovalDecision, ReviewCoordinator } from '../../src/index.js'

const action = () => createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
const verifiedDossier = () => sealSourceVerifiedDossier({
  version: 1 as const, kind: 'guardian-dossier' as const,
  freeze: { parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 0 }, throughSeq: 1, currentTurn: 1, currentStep: 0, frozenAt: 1 },
  environment: {}, instructions: {}, interaction: {}, currentTurnTools: {}, pendingApproval: {}, completeness: { complete: true, sourceThroughSeq: 1, omissions: [] },
})

function decision(overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    protocolVersion: 1,
    reviewId: 'review-1',
    parentSessionId: 'parent-1',
    reviewerSessionId: 'reviewer-1',
    generation: 'generation-1',
    actionHash: hashAction(action()),
    decision: 'allow',
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'Authorized.',
    ...overrides,
  }
}

function reviewReturning(result: ApprovalDecision) {
  return { review: vi.fn(async () => result) } as unknown as ReviewCoordinator<{ id: string }, string>
}

function input(overrides: Partial<Parameters<DefaultPreReviewCoordinator<{ id: string }, string>['preReview']>[0]> = {}) {
  return {
    authority: { live: { id: 'parent-1' }, sessionId: 'parent-1' },
    requestId: 'ask-1',
    callId: 'call-1',
    action: action(),
    verifiedDossier: verifiedDossier(),
    generation: 'generation-1',
    configurationFingerprint: `sha256:${'b'.repeat(64)}`,
    issuedAt: 100,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  }
}

describe('DefaultPreReviewCoordinator', () => {
  it('seals an allow and replays it without a second review', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const reviewer = reviewReturning(decision())
    const review = (reviewer as unknown as { review: ReturnType<typeof vi.fn> }).review
    const coordinator = new DefaultPreReviewCoordinator(reviewer, seals)
    const sealed = await coordinator.preReview(input())
    expect(sealed.disposition).toBe('allow')
    expect(sealed.requestId).toBe('ask-1')
    expect(review).toHaveBeenCalledOnce()
    expect(coordinator.replay({ requestId: 'ask-1', callId: 'call-1', actionHash: hashAction(action()) })).toEqual({
      kind: 'sealed',
      disposition: sealed,
    })
  })

  it('constrains an identity-valid model allow with the source assessment before sealing', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const coordinator = new DefaultPreReviewCoordinator(reviewReturning(decision()), seals)
    const assessedAction = action()
    await expect(coordinator.preReview(input({ action: assessedAction, assessment: assessVerifiedActionV1(assessedAction, [1]) })))
      .resolves.toMatchObject({ disposition: 'human' })
  })

  it('downgrades a cited allow that overclaims source-derived coverage', async () => {
    const assessedAction = action()
    const reviewer = reviewReturning(decision({ assessment: { version: 1, targetCovered: true, sideEffectsCovered: true, sourceRefs: ['event:1'], rationale: 'overclaimed' } }))
    const coordinator = new DefaultPreReviewCoordinator(reviewer, new InMemorySealedDispositionRegistry())
    await expect(coordinator.preReview(input({ action: assessedAction, assessment: assessVerifiedActionV1(assessedAction, [1]) })))
      .resolves.toMatchObject({ disposition: 'human' })
  })

  it('never weakens a Guardian deny because its risk explanation is incomplete', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const coordinator = new DefaultPreReviewCoordinator(reviewReturning(decision({ decision: 'deny' })), seals)
    const assessedAction = action()
    await expect(coordinator.preReview(input({ action: assessedAction, assessment: assessVerifiedActionV1(assessedAction, [1]) })))
      .resolves.toMatchObject({ disposition: 'deny' })
  })

  it('maps deny and human_review to sealed dispositions', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const coordinator = new DefaultPreReviewCoordinator(
      reviewReturning(decision({ decision: 'deny' })),
      seals,
    )
    await expect(coordinator.preReview(input())).resolves.toMatchObject({ disposition: 'deny' })

    const humanSeals = new InMemorySealedDispositionRegistry()
    const human = new DefaultPreReviewCoordinator(
      reviewReturning(decision({ decision: 'human_review' })),
      humanSeals,
    )
    await expect(human.preReview(input())).resolves.toMatchObject({ disposition: 'human' })
  })

  it('fails closed before sealing when Guardian identity drifts', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const coordinator = new DefaultPreReviewCoordinator(
      reviewReturning(decision({ generation: 'generation-other' })),
      seals,
    )
    await expect(coordinator.preReview(input())).rejects.toMatchObject({
      name: 'GateFailure',
      code: 'integrity',
    })
    expect(coordinator.replay({ requestId: 'ask-1', callId: 'call-1', actionHash: hashAction(action()) }).kind).toBe('missing')
  })

  it('rejects an expired pre-review before calling Guardian', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const reviewer = reviewReturning(decision())
    const review = (reviewer as unknown as { review: ReturnType<typeof vi.fn> }).review
    const coordinator = new DefaultPreReviewCoordinator(reviewer, seals, () => 200)
    await expect(coordinator.preReview(input({ deadlineAt: 200 }))).rejects.toMatchObject({ code: 'deadline' })
    expect(review).not.toHaveBeenCalled()
    expect(coordinator.replay({ requestId: 'ask-1', callId: 'call-1', actionHash: hashAction(action()) }).kind).toBe('missing')
  })

  it('rejects a Guardian decision that arrives after the absolute deadline', async () => {
    let now = 150
    const reviewer = { review: vi.fn(async () => { now = 201; return decision() }) } as unknown as ReviewCoordinator<{ id: string }, string>
    const seals = new InMemorySealedDispositionRegistry()
    const coordinator = new DefaultPreReviewCoordinator(reviewer, seals, () => now)
    await expect(coordinator.preReview(input({ deadlineAt: 200 }))).rejects.toMatchObject({ code: 'deadline' })
    expect(coordinator.replay({ requestId: 'ask-1', callId: 'call-1', actionHash: hashAction(action()) }).kind).toBe('missing')
  })

  it('reports missing, mismatch, and consumed replays through the registry', async () => {
    const seals = new InMemorySealedDispositionRegistry()
    const coordinator = new DefaultPreReviewCoordinator(
      reviewReturning(decision()),
      seals,
    )
    await coordinator.preReview(input())
    expect(coordinator.replay({ requestId: 'missing', callId: 'call-1', actionHash: hashAction(action()) }).kind).toBe('missing')
    expect(coordinator.replay({ requestId: 'ask-1', callId: 'call-other', actionHash: hashAction(action()) }).kind).toBe('mismatch')
    expect(seals.consume('ask-1', 'call-1')).toBe(true)
    expect(coordinator.replay({ requestId: 'ask-1', callId: 'call-1', actionHash: hashAction(action()) }).kind).toBe('consumed')
  })
})
