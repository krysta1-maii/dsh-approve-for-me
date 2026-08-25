import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DefaultDecisionChannel,
  DefaultReviewCoordinator,
  DefaultReviewerDirectory,
  REVIEWER_PROVIDER,
  SerialLanes,
  createActionSnapshot,
  createReviewerProviderData,
  hashAction,
  parseApprovalReviewRequest,
  snapshotJson,
} from '../../src/index.js'
import type {
  ApprovalReviewRequest,
  ManagedOwnedReviewer,
  ManagedReviewerPort,
  ParentAuthority,
  ReviewerProviderDataV1,
  ReviewerTextBlock,
} from '../../src/index.js'

type Parent = { id: string }

type Delivery = { authority: ParentAuthority<Parent, string>; childId: string; request: ApprovalReviewRequest }

class FakePort implements ManagedReviewerPort<Parent, string> {
  children: ManagedOwnedReviewer<string>[] = []
  creates = 0
  deliveries: Delivery[] = []
  interrupts: Array<{ authority: ParentAuthority<Parent, string>; childId: string }> = []
  onDeliver?: (delivery: Delivery) => void | Promise<void>
  deliveryError?: Error

  async create(authority: ParentAuthority<Parent, string>, options: {
    label: string
    providerData: ReviewerProviderDataV1
  }): Promise<string> {
    const id = `${authority.sessionId}-reviewer-${++this.creates}`
    this.children.push({
      id,
      parentSessionId: authority.sessionId,
      provider: REVIEWER_PROVIDER,
      label: options.label,
      providerData: snapshotJson(options.providerData),
      activity: 'inactive',
    })
    return id
  }

  async list(parentSessionId: string): Promise<ManagedOwnedReviewer<string>[]> {
    return this.children.filter(child => child.parentSessionId === parentSessionId)
  }

  async deliver(
    authority: ParentAuthority<Parent, string>,
    childId: string,
    content: readonly ReviewerTextBlock[],
  ): Promise<string> {
    if (this.deliveryError !== undefined) throw this.deliveryError
    const encoded = content[0]!.text.split('\n').at(-1)!
    const delivery = { authority, childId, request: parseApprovalReviewRequest(JSON.parse(encoded)) }
    this.deliveries.push(delivery)
    await this.onDeliver?.(delivery)
    return `message-${this.deliveries.length}`
  }

  interrupt(authority: ParentAuthority<Parent, string>, childId: string): void {
    this.interrupts.push({ authority, childId })
  }
}

const action = () => createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
const providerData = (generation = 'generation-1') => createReviewerProviderData({
  generation,
  modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  policyVersion: 'policy-1',
  toolsetVersion: 1,
})

function decision(request: ApprovalReviewRequest) {
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

function authority(parent: Parent): ParentAuthority<Parent, string> {
  return { live: parent, sessionId: parent.id }
}

function makeCoordinator(port: FakePort, overrides: {
  timeoutMs?: number
  reviewId?: () => string
  submit?: (payload: unknown, actualId: string) => ReturnType<DefaultDecisionChannel['submit']>
} = {}) {
  const channel = new DefaultDecisionChannel()
  const submit = overrides.submit ?? ((payload: unknown, actualId: string) => channel.submit(payload, { actualReviewerSessionId: actualId }))
  return {
    channel,
    coordinator: new DefaultReviewCoordinator({
      port,
      directory: new DefaultReviewerDirectory(port),
      channel,
      lane: new SerialLanes(),
      timeoutMs: overrides.timeoutMs ?? 1_000,
      preset: providerData(),
      ...overrides.reviewId === undefined ? {} : { reviewId: overrides.reviewId },
    }),
    submit,
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

describe('DefaultReviewCoordinator', () => {
  it('lazily creates one Reviewer and reuses it for later serialized reviews', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()! })
    port.onDeliver = ({ childId, request }) => {
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    const parent = { id: 'parent-1' }
    await expect(coordinator.review({ authority: authority(parent), action: action() })).resolves.toMatchObject({ decision: 'allow' })
    await expect(coordinator.review({ authority: authority(parent), action: action() })).resolves.toMatchObject({ decision: 'allow' })
    expect(port.creates).toBe(1)
    expect(port.deliveries.map(item => item.childId)).toEqual(['parent-1-reviewer-1', 'parent-1-reviewer-1'])
    expect(port.deliveries[0]!.request.action).toEqual(action())
  })

  it('serializes the complete review interval for one parent', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()! })
    const parent = { id: 'parent-1' }
    const first = coordinator.review({ authority: authority(parent), action: action() })
    const second = coordinator.review({ authority: authority(parent), action: action() })
    await waitFor(() => port.deliveries.length === 1)
    expect(port.deliveries).toHaveLength(1)
    const firstDelivery = port.deliveries[0]!
    submit(decision(firstDelivery.request), firstDelivery.childId)
    await expect(first).resolves.toMatchObject({ reviewId: 'review-1' })
    await waitFor(() => port.deliveries.length === 2)
    const secondDelivery = port.deliveries[1]!
    submit(decision(secondDelivery.request), secondDelivery.childId)
    await expect(second).resolves.toMatchObject({ reviewId: 'review-2' })
  })

  it('allows different parent lanes to progress independently', async () => {
    const port = new FakePort()
    let id = 0
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => `review-${++id}` })
    const first = coordinator.review({ authority: authority({ id: 'parent-a' }), action: action() })
    const second = coordinator.review({ authority: authority({ id: 'parent-b' }), action: action() })
    await waitFor(() => port.deliveries.length === 2)
    for (const delivery of port.deliveries) submit(decision(delivery.request), delivery.childId)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(port.creates).toBe(2)
  })

  it('creates a replacement for a new generation and preserves old history', async () => {
    const port = new FakePort()
    const old = providerData('generation-old')
    port.children.push({
      id: 'old-reviewer', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER,
      label: 'Approval Reviewer', providerData: snapshotJson(old), activity: 'inactive',
    })
    const { coordinator, submit } = makeCoordinator(port)
    port.onDeliver = ({ childId, request }) => { submit(decision(request), childId) }
    await coordinator.review({ authority: authority({ id: 'parent-1' }), action: action() })
    expect(port.creates).toBe(1)
    expect(port.children.map(child => child.id)).toEqual(['old-reviewer', 'parent-1-reviewer-1'])
  })

  it('fails closed when current descriptor identity is ambiguous', async () => {
    const port = new FakePort()
    const data = providerData()
    port.children.push(
      { id: 'r1', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Reviewer', providerData: snapshotJson(data), activity: 'inactive' },
      { id: 'r2', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Reviewer', providerData: snapshotJson(data), activity: 'inactive' },
    )
    const { coordinator } = makeCoordinator(port)
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action() }))
      .rejects.toThrow(/multiple Approval Reviewers/)
    expect(port.deliveries).toHaveLength(0)
  })

  it('interrupts a Reviewer that submits a mismatched terminal identity', async () => {
    const port = new FakePort()
    const { coordinator, submit } = makeCoordinator(port)
    const parent = { id: 'parent-1' }
    port.onDeliver = ({ childId, request }) => {
      expect(submit({ ...decision(request), generation: 'generation-other' }, childId).status)
        .toBe('identity-mismatch')
    }
    await expect(coordinator.review({ authority: authority(parent), action: action() }))
      .rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(port.interrupts).toEqual([{ authority: authority(parent), childId: 'parent-1-reviewer-1' }])
  })

  it('closes the pending result when deliver fails', async () => {
    const port = new FakePort()
    port.deliveryError = new Error('inbox unavailable')
    const { coordinator, channel } = makeCoordinator(port, { reviewId: () => 'review-1' })
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action() }))
      .rejects.toThrow('inbox unavailable')
    expect(channel.submit({
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
    }, { actualReviewerSessionId: 'parent-1-reviewer-1' }).status).toBe('late')
  })

  it('interrupts the Reviewer when the business deadline expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const port = new FakePort()
    const { coordinator, submit } = makeCoordinator(port, { timeoutMs: 50 })
    const parent = { id: 'parent-1' }
    const pending = coordinator.review({ authority: authority(parent), action: action() })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timed-out' })
    await waitFor(() => port.deliveries.length === 1)
    await vi.advanceTimersByTimeAsync(51)
    await rejected
    expect(port.interrupts).toEqual([{ authority: authority(parent), childId: 'parent-1-reviewer-1' }])
    void submit
  })

  it('never creates or delivers for an already-aborted review', async () => {
    const port = new FakePort()
    const { coordinator } = makeCoordinator(port)
    const abort = new AbortController()
    abort.abort()
    await expect(coordinator.review({
      authority: authority({ id: 'parent-1' }),
      action: action(),
      signal: abort.signal,
    })).rejects.toMatchObject({ code: 'aborted' })
    expect(port.creates).toBe(0)
    expect(port.deliveries).toHaveLength(0)
    expect(port.interrupts).toHaveLength(0)
  })

  it('does not deliver a review that never entered the channel', async () => {
    const port = new FakePort()
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => 'review-1' })
    const parent = { id: 'parent-1' }
    port.onDeliver = ({ childId, request }) => { expect(submit(decision(request), childId).status).toBe('accepted') }
    await expect(coordinator.review({ authority: authority(parent), action: action() }))
      .resolves.toMatchObject({ reviewId: 'review-1' })
    // The same review id can never be armed again: the second review rejects
    // without a second delivery and without interrupting the idle child.
    await expect(coordinator.review({ authority: authority(parent), action: action() }))
      .rejects.toThrow(/already been armed/)
    expect(port.deliveries).toHaveLength(1)
    expect(port.interrupts).toHaveLength(0)
  })
})
