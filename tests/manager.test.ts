import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REVIEWER_PROVIDER,
  ReviewerSessionManager,
  createActionSnapshot,
  createReviewerProviderData,
  hashAction,
  parseApprovalRequest,
} from '../src/index.js'
import type {
  ApprovalRequest,
  ManagedOwnedReviewer,
  ManagedReviewerController,
  ReviewerProviderDataV1,
  ReviewerTextBlock,
} from '../src/index.js'

type Parent = { id: string }

type Delivery = { parent: Parent; childId: string; request: ApprovalRequest }

class FakeController implements ManagedReviewerController<Parent> {
  children: ManagedOwnedReviewer[] = []
  creates = 0
  deliveries: Delivery[] = []
  interrupts: Array<{ parent: Parent; childId: string }> = []
  onDeliver?: (delivery: Delivery) => void | Promise<void>
  deliveryError?: Error

  async create(parent: Parent, options: { label: string; providerData: ReviewerProviderDataV1 }): Promise<string> {
    const id = `${parent.id}-reviewer-${++this.creates}`
    this.children.push({
      id,
      parentSessionId: parent.id,
      provider: REVIEWER_PROVIDER,
      label: options.label,
      providerData: structuredClone(options.providerData) as never,
      activity: 'inactive',
    })
    return id
  }

  async list(parentSessionId: string): Promise<ManagedOwnedReviewer[]> {
    return this.children.filter(child => child.parentSessionId === parentSessionId)
  }

  async deliver(parent: Parent, childId: string, content: readonly ReviewerTextBlock[]): Promise<string> {
    if (this.deliveryError !== undefined) throw this.deliveryError
    const encoded = content[0]!.text.split('\n').at(-1)!
    const delivery = { parent, childId, request: parseApprovalRequest(JSON.parse(encoded)) }
    this.deliveries.push(delivery)
    await this.onDeliver?.(delivery)
    return `message-${this.deliveries.length}`
  }

  interrupt(parent: Parent, childId: string): void {
    this.interrupts.push({ parent, childId })
  }
}

const action = () => createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
const providerData = (generation = 'generation-1') => createReviewerProviderData({
  generation,
  modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  policyVersion: 'policy-1',
  toolsetVersion: 1,
})

function decision(request: ApprovalRequest) {
  return {
    protocolVersion: 1,
    reviewId: request.reviewId,
    parentSessionId: request.parentSessionId,
    reviewerSessionId: request.reviewerSessionId,
    generation: request.generation,
    actionHash: request.actionHash,
    decision: 'allow',
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'Authorized.',
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

afterEach(() => { vi.useRealTimers() })

describe('ReviewerSessionManager', () => {
  it('lazily creates one Reviewer and reuses it for later serialized reviews', async () => {
    const controller = new FakeController()
    const ids = ['review-1', 'review-2']
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000, reviewId: () => ids.shift()! })
    controller.onDeliver = ({ childId, request }) => {
      expect(manager.submitDecision(decision(request), childId).status).toBe('accepted')
    }
    const parent = { id: 'parent-1' }
    await expect(manager.review(parent, parent.id, action(), providerData())).resolves.toMatchObject({ decision: 'allow' })
    await expect(manager.review(parent, parent.id, action(), providerData())).resolves.toMatchObject({ decision: 'allow' })
    expect(controller.creates).toBe(1)
    expect(controller.deliveries.map(item => item.childId)).toEqual(['parent-1-reviewer-1', 'parent-1-reviewer-1'])
  })

  it('serializes the complete review interval for one parent', async () => {
    const controller = new FakeController()
    const ids = ['review-1', 'review-2']
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000, reviewId: () => ids.shift()! })
    const parent = { id: 'parent-1' }
    const first = manager.review(parent, parent.id, action(), providerData())
    const second = manager.review(parent, parent.id, action(), providerData())
    await waitFor(() => controller.deliveries.length === 1)
    expect(controller.deliveries).toHaveLength(1)
    const firstDelivery = controller.deliveries[0]!
    manager.submitDecision(decision(firstDelivery.request), firstDelivery.childId)
    await expect(first).resolves.toMatchObject({ reviewId: 'review-1' })
    await waitFor(() => controller.deliveries.length === 2)
    const secondDelivery = controller.deliveries[1]!
    manager.submitDecision(decision(secondDelivery.request), secondDelivery.childId)
    await expect(second).resolves.toMatchObject({ reviewId: 'review-2' })
  })

  it('allows different parent lanes to progress independently', async () => {
    const controller = new FakeController()
    let id = 0
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000, reviewId: () => `review-${++id}` })
    const first = manager.review({ id: 'parent-a' }, 'parent-a', action(), providerData())
    const second = manager.review({ id: 'parent-b' }, 'parent-b', action(), providerData())
    await waitFor(() => controller.deliveries.length === 2)
    for (const delivery of controller.deliveries) manager.submitDecision(decision(delivery.request), delivery.childId)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(controller.creates).toBe(2)
  })

  it('creates a replacement for a new generation and preserves old history', async () => {
    const controller = new FakeController()
    const old = providerData('generation-old')
    controller.children.push({
      id: 'old-reviewer', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER,
      label: 'Approval Reviewer', providerData: old as never, activity: 'inactive',
    })
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000, reviewId: () => 'review-1' })
    controller.onDeliver = ({ childId, request }) => { manager.submitDecision(decision(request), childId) }
    await manager.review({ id: 'parent-1' }, 'parent-1', action(), providerData('generation-new'))
    expect(controller.creates).toBe(1)
    expect(controller.children.map(child => child.id)).toEqual(['old-reviewer', 'parent-1-reviewer-1'])
  })

  it('fails closed when current descriptor identity is ambiguous', async () => {
    const controller = new FakeController()
    const data = providerData()
    controller.children.push(
      { id: 'r1', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Reviewer', providerData: data as never, activity: 'inactive' },
      { id: 'r2', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Reviewer', providerData: data as never, activity: 'inactive' },
    )
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000 })
    await expect(manager.review({ id: 'parent-1' }, 'parent-1', action(), data)).rejects.toThrow(/multiple Approval Reviewers/)
    expect(controller.deliveries).toHaveLength(0)
  })

  it('interrupts a Reviewer that submits a mismatched terminal identity', async () => {
    const controller = new FakeController()
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000, reviewId: () => 'review-1' })
    const parent = { id: 'parent-1' }
    controller.onDeliver = ({ childId, request }) => {
      expect(manager.submitDecision({ ...decision(request), generation: 'generation-other' }, childId).status)
        .toBe('identity-mismatch')
    }
    await expect(manager.review(parent, parent.id, action(), providerData())).rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(controller.interrupts).toEqual([{ parent, childId: 'parent-1-reviewer-1' }])
  })

  it('closes the pending result when deliver fails', async () => {
    const controller = new FakeController()
    controller.deliveryError = new Error('inbox unavailable')
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 1_000, reviewId: () => 'review-1' })
    await expect(manager.review({ id: 'parent-1' }, 'parent-1', action(), providerData())).rejects.toThrow('inbox unavailable')
    expect(manager.submitDecision({
      protocolVersion: 1,
      reviewId: 'review-1',
      parentSessionId: 'parent-1',
      reviewerSessionId: 'parent-1-reviewer-1',
      generation: 'generation-1',
      actionHash: hashAction(action()),
      decision: 'allow',
      risk: 'low',
      categories: [],
      userAuthorization: 'explicit',
      rationale: 'Too late.',
    }, 'parent-1-reviewer-1').status).toBe('late')
  })

  it('interrupts the Reviewer when the business deadline expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const controller = new FakeController()
    const manager = new ReviewerSessionManager(controller, { timeoutMs: 50, reviewId: () => 'review-1' })
    const parent = { id: 'parent-1' }
    const pending = manager.review(parent, parent.id, action(), providerData())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timed-out' })
    await waitFor(() => controller.deliveries.length === 1)
    await vi.advanceTimersByTimeAsync(51)
    await rejected
    expect(controller.interrupts).toEqual([{ parent, childId: 'parent-1-reviewer-1' }])
  })
})
