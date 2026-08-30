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
  assessVerifiedActionV1,
  parseApprovalReviewPacketV1,
  parseApprovalReviewPacketV2,
  snapshotJson,
} from '../../src/index.js'
import { sealSourceVerifiedDossier } from '../../src/domain/dossier.js'
import type {
  ApprovalReviewRequest,
  ManagedOwnedReviewer,
  ManagedReviewerPort,
  ParentAuthority,
  ReviewerProviderDataV1,
  ReviewerTextBlock,
  ReviewClock,
  ReviewerTelemetrySink,
} from '../../src/index.js'

type Parent = { id: string }

type Delivery = { authority: ParentAuthority<Parent, string>; childId: string; request: ApprovalReviewRequest; packetVersion: 1 | 2 }

class FakePort implements ManagedReviewerPort<Parent, string> {
  children: ManagedOwnedReviewer<string>[] = []
  creates = 0
  deliveries: Delivery[] = []
  interrupts: Array<{ authority: ParentAuthority<Parent, string>; childId: string }> = []
  rotates: Array<{ authority: ParentAuthority<Parent, string>; childId: string }> = []
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
      contaminated: false,
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
    const raw = JSON.parse(encoded) as { version?: unknown }
    const packet = raw.version === 2 ? parseApprovalReviewPacketV2(raw) : parseApprovalReviewPacketV1(raw)
    const delivery = { authority, childId, request: packet.request, packetVersion: packet.version }
    this.deliveries.push(delivery)
    await this.onDeliver?.(delivery)
    return `message-${this.deliveries.length}`
  }

  interrupt(authority: ParentAuthority<Parent, string>, childId: string): void {
    this.interrupts.push({ authority, childId })
  }

  async rotate(authority: ParentAuthority<Parent, string>, childId: string): Promise<string> {
    this.rotates.push({ authority, childId })
    const index = this.children.findIndex(child => child.id === childId)
    if (index >= 0) {
      this.children[index] = { ...this.children[index]!, contaminated: true }
    }
    return this.create(authority, {
      label: 'Approval Reviewer',
      providerData: createReviewerProviderData({
        generation: 'generation-1',
        modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        policyVersion: 'policy-1',
        toolsetVersion: 1,
      }),
    })
  }
}

const action = () => createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
const verifiedDossier = (pendingAction = action(), callId = 'call-1', parentSessionId = 'parent-1') => sealSourceVerifiedDossier({
  version: 1 as const,
  kind: 'guardian-dossier' as const,
  freeze: { parent: { sessionId: parentSessionId, sessionFormatVersion: 0, createdAt: 0 }, throughSeq: 1, currentTurn: 1, currentStep: 0, frozenAt: 1 },
  environment: {}, instructions: {}, interaction: {}, currentTurnTools: {},
  pendingApproval: { callId, action: pendingAction as unknown as import('../../src/index.js').JsonValue, actionHash: hashAction(pendingAction) },
  completeness: { complete: true, sourceThroughSeq: 1, omissions: [] },
})
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
  now?: () => number
  clock?: ReviewClock
  reviewId?: () => string
  submit?: (payload: unknown, actualId: string) => ReturnType<DefaultDecisionChannel['submit']>
  telemetry?: ReviewerTelemetrySink
} = {}) {
  const channel = new DefaultDecisionChannel(overrides.clock)
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
      ...overrides.now === undefined ? {} : { now: overrides.now },
      ...overrides.reviewId === undefined ? {} : { reviewId: overrides.reviewId },
      ...overrides.telemetry === undefined ? {} : { telemetry: overrides.telemetry },
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
    await expect(coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() })).resolves.toMatchObject({ decision: 'allow' })
    await expect(coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() })).resolves.toMatchObject({ decision: 'allow' })
    expect(port.creates).toBe(1)
    expect(port.deliveries.map(item => item.childId)).toEqual(['parent-1-reviewer-1', 'parent-1-reviewer-1'])
    expect(port.deliveries[0]!.request.action).toEqual(action())
  })

  it('observes a settled reviewer outcome without changing it', async () => {
    const port = new FakePort()
    const observe = vi.fn()
    const { coordinator, submit } = makeCoordinator(port, { telemetry: { observe } })
    port.onDeliver = ({ childId, request }) => { expect(submit(decision(request), childId).status).toBe('accepted') }
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ decision: 'allow' })
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'review', outcome: 'allow', attempts: 1, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }))
  })

  it('delivers an assessed v2 packet when source-derived evidence is supplied', async () => {
    const port = new FakePort()
    const { coordinator, submit } = makeCoordinator(port)
    port.onDeliver = ({ childId, request }) => { expect(submit(decision(request), childId).status).toBe('accepted') }
    const reviewedAction = action()
    await expect(coordinator.review({
      authority: authority({ id: 'parent-1' }),
      action: reviewedAction,
      verifiedDossier: verifiedDossier(reviewedAction),
      assessment: assessVerifiedActionV1(reviewedAction, [1]),
    })).resolves.toMatchObject({ decision: 'allow' })
    expect(port.deliveries[0]!.packetVersion).toBe(2)
  })

  it('serializes the complete review interval for one parent', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()! })
    const parent = { id: 'parent-1' }
    const first = coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() })
    const second = coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() })
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
    const first = coordinator.review({ authority: authority({ id: 'parent-a' }), action: action(), verifiedDossier: verifiedDossier(action(), 'call-1', 'parent-a') })
    const second = coordinator.review({ authority: authority({ id: 'parent-b' }), action: action(), verifiedDossier: verifiedDossier(action(), 'call-1', 'parent-b') })
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
      label: 'Approval Reviewer', providerData: snapshotJson(old), activity: 'inactive', contaminated: false,
    })
    const { coordinator, submit } = makeCoordinator(port)
    port.onDeliver = ({ childId, request }) => { submit(decision(request), childId) }
    await coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() })
    expect(port.creates).toBe(1)
    expect(port.children.map(child => child.id)).toEqual(['old-reviewer', 'parent-1-reviewer-1'])
  })

  it('fails closed when current descriptor identity is ambiguous', async () => {
    const port = new FakePort()
    const data = providerData()
    port.children.push(
      { id: 'r1', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Reviewer', providerData: snapshotJson(data), activity: 'inactive', contaminated: false },
      { id: 'r2', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Reviewer', providerData: snapshotJson(data), activity: 'inactive', contaminated: false },
    )
    const { coordinator } = makeCoordinator(port)
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
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
    await expect(coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() }))
      .rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(port.interrupts).toEqual([{ authority: authority(parent), childId: 'parent-1-reviewer-1' }])
    expect(port.deliveries).toHaveLength(1)
  })

  it('retries one routed malformed result with a new protocol review ID', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()! })
    let first = true
    port.onDeliver = ({ childId, request }) => {
      if (first) {
        first = false
        expect(submit({ reviewId: request.reviewId }, childId).status).toBe('invalid')
        return
      }
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ reviewId: 'review-2', decision: 'allow' })
    expect(port.deliveries.map(delivery => delivery.request.reviewId)).toEqual(['review-1', 'review-2'])
    expect(port.interrupts).toHaveLength(1)
  })

  it('keeps a late first-attempt result isolated from the second attempt', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()! })
    let firstRequest: ApprovalReviewRequest | undefined
    port.onDeliver = ({ childId, request }) => {
      if (firstRequest === undefined) {
        firstRequest = request
        expect(submit({ reviewId: request.reviewId }, childId).status).toBe('invalid')
        return
      }
      expect(submit(decision(firstRequest!), childId).status).toBe('late')
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ reviewId: 'review-2' })
  })

  it('fails closed after two malformed-result attempts without a third delivery', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2', 'review-3']
    const observe = vi.fn()
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()!, telemetry: { observe } })
    port.onDeliver = ({ childId, request }) => {
      expect(submit({ reviewId: request.reviewId }, childId).status).toBe('invalid')
    }
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
      .rejects.toMatchObject({ code: 'invalid-result' })
    expect(port.deliveries.map(delivery => delivery.request.reviewId)).toEqual(['review-1', 'review-2'])
    expect(port.interrupts).toHaveLength(2)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'review', outcome: 'error', failure: 'invalid-result', attempts: 2,
      contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }))
  })

  it('closes the pending result when deliver fails', async () => {
    const port = new FakePort()
    port.deliveryError = new Error('inbox unavailable')
    const { coordinator, channel } = makeCoordinator(port, { reviewId: () => 'review-1' })
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
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
    const pending = coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() })
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
      action: action(), verifiedDossier: verifiedDossier(),
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
    await expect(coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ reviewId: 'review-1' })
    // The same review id can never be armed again: the second review rejects
    // without a second delivery and without interrupting the idle child.
    await expect(coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() }))
      .rejects.toThrow(/already been armed/)
    expect(port.deliveries).toHaveLength(1)
    expect(port.interrupts).toHaveLength(0)
  })

  it('never selects a contaminated Reviewer and creates a fresh clean child', async () => {
    const port = new FakePort()
    const data = providerData()
    port.children.push({
      id: 'bad-contaminated', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER,
      label: 'Approval Reviewer', providerData: snapshotJson(data), activity: 'inactive', contaminated: true,
    })
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => 'review-1' })
    port.onDeliver = ({ childId, request }) => {
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ reviewId: 'review-1' })
    expect(port.creates).toBe(1)
    expect(port.deliveries).toHaveLength(1)
    expect(port.deliveries[0]!.childId).not.toBe('bad-contaminated')
  })

  it('reuses a clean replacement beside a persisted contaminated child after reload', async () => {
    const port = new FakePort()
    const data = providerData()
    port.children.push(
      { id: 'old-contaminated', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Approval Reviewer', providerData: snapshotJson(data), activity: 'inactive', contaminated: true },
      { id: 'clean-replacement', parentSessionId: 'parent-1', provider: REVIEWER_PROVIDER, label: 'Approval Reviewer', providerData: snapshotJson(data), activity: 'inactive', contaminated: false },
    )
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => 'review-1' })
    port.onDeliver = ({ childId, request }) => {
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    await expect(coordinator.review({ authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ reviewId: 'review-1' })
    expect(port.creates).toBe(0)
    expect(port.deliveries).toHaveLength(1)
    expect(port.deliveries[0]!.childId).toBe('clean-replacement')
  })

  it('rejects an action that does not match the verified dossier before creating a reviewer', async () => {
    const port = new FakePort()
    const { coordinator } = makeCoordinator(port)
    const differentAction = createActionSnapshot({ toolName: 'bash', arguments: { command: 'rm -rf /tmp/example' } })
    await expect(coordinator.review({
      authority: authority({ id: 'parent-1' }), action: differentAction, verifiedDossier: verifiedDossier(action()),
    })).rejects.toMatchObject({ code: 'invalid-result' })
    expect(port.creates).toBe(0)
    expect(port.deliveries).toHaveLength(0)
  })

  it('rejects a verified dossier from a different parent before creating a reviewer', async () => {
    const port = new FakePort()
    const { coordinator } = makeCoordinator(port)
    await expect(coordinator.review({
      authority: authority({ id: 'parent-2' }), action: action(), verifiedDossier: verifiedDossier(),
    })).rejects.toMatchObject({ code: 'invalid-result' })
    expect(port.creates).toBe(0)
    expect(port.deliveries).toHaveLength(0)
  })

  it('retries once when a newly contaminated child is discovered during delivery', async () => {
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const observe = vi.fn()
    const { coordinator, submit } = makeCoordinator(port, { reviewId: () => ids.shift()!, telemetry: { observe } })
    const parent = { id: 'parent-1' }
    let first = true
    port.onDeliver = async ({ childId, request }) => {
      if (first) {
        first = false
        const index = port.children.findIndex(child => child.id === childId)
        if (index >= 0) {
          port.children[index] = { ...port.children[index]!, contaminated: true }
        }
        throw new Error(`managed child "${childId}" is contaminated and must be rotated`)
      }
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    await expect(coordinator.review({ authority: authority(parent), action: action(), verifiedDossier: verifiedDossier() }))
      .resolves.toMatchObject({ reviewId: 'review-2' })
    expect(port.creates).toBe(2)
    expect(port.deliveries).toHaveLength(2)
    expect(port.rotates).toHaveLength(1)
    expect(port.children.filter(child => child.contaminated)).toHaveLength(1)
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'review', outcome: 'allow', attempts: 1,
      contaminatedRotationAttempts: 1, contaminatedRotations: 1,
    }))
  })

  it('shares one absolute deadline across contaminated-child recovery attempts', async () => {
    let now = 1_000
    const clock: ReviewClock = {
      now: () => now,
      setTimeout: () => Symbol('timer'),
      clearTimeout: () => undefined,
    }
    const port = new FakePort()
    const ids = ['review-1', 'review-2']
    const { coordinator, submit } = makeCoordinator(port, {
      timeoutMs: 50, now: () => now, clock, reviewId: () => ids.shift()!,
    })
    let first = true
    port.onDeliver = ({ childId, request }) => {
      if (first) {
        first = false
        const index = port.children.findIndex(child => child.id === childId)
        port.children[index] = { ...port.children[index]!, contaminated: true }
        now = 1_010
        throw new Error(`managed child "${childId}" is contaminated and must be rotated`)
      }
      expect(submit(decision(request), childId).status).toBe('accepted')
    }
    await expect(coordinator.review({
      authority: authority({ id: 'parent-1' }), action: action(), verifiedDossier: verifiedDossier(),
    })).resolves.toMatchObject({ reviewId: 'review-2' })
    expect(port.deliveries.map(delivery => delivery.request.deadlineAt)).toEqual([1_050, 1_050])
  })
})
