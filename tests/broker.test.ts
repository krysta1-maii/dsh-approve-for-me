import { describe, expect, it } from 'vitest'
import {
  DecisionBroker,
  ReviewProtocolError,
  createActionSnapshot,
  createApprovalRequest,
} from '../src/index.js'
import type { ApprovalRequest, ReviewClock } from '../src/index.js'

class FakeClock implements ReviewClock {
  value = 100
  private id = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now(): number { return this.value }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.id
    this.timers.set(id, { at: this.value + delayMs, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    this.value += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.value) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createApprovalRequest(createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), {
    reviewId: 'review-1',
    parentSessionId: 'parent-1',
    reviewerSessionId: 'reviewer-1',
    generation: 'generation-1',
    issuedAt: 100,
    deadlineAt: 200,
  })
  return { ...base, ...overrides }
}

function decision(req = request()) {
  return {
    protocolVersion: 1,
    reviewId: req.reviewId,
    parentSessionId: req.parentSessionId,
    reviewerSessionId: req.reviewerSessionId,
    generation: req.generation,
    actionHash: req.actionHash,
    decision: 'allow',
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'Authorized.',
  }
}

describe('DecisionBroker', () => {
  it('accepts the first fully matching result and tombstones duplicates', async () => {
    const clock = new FakeClock()
    const broker = new DecisionBroker(clock)
    const pending = broker.arm(request())
    const first = broker.submit(decision(), { actualReviewerSessionId: 'reviewer-1' })
    const second = broker.submit(decision(), { actualReviewerSessionId: 'reviewer-1' })
    expect(first.status).toBe('accepted')
    expect(second).toEqual({ status: 'duplicate', reviewId: 'review-1' })
    await expect(pending).resolves.toMatchObject({ decision: 'allow' })
  })

  it('closes a routable malformed result instead of waiting for a replacement', async () => {
    const broker = new DecisionBroker(new FakeClock())
    const pending = broker.arm(request())
    const disposition = broker.submit({ ...decision(), risk: 'safe' }, { actualReviewerSessionId: 'reviewer-1' })
    expect(disposition.status).toBe('invalid')
    await expect(pending).rejects.toMatchObject({ code: 'invalid-result' })
    expect(broker.submit(decision(), { actualReviewerSessionId: 'reviewer-1' })).toEqual({ status: 'late', reviewId: 'review-1' })
  })

  it('does not let an unroutable malformed payload close another request', async () => {
    const broker = new DecisionBroker(new FakeClock())
    const pending = broker.arm(request())
    expect(broker.submit('allow', { actualReviewerSessionId: 'reviewer-1' }).status).toBe('invalid')
    expect(broker.hasPending('review-1')).toBe(true)
    broker.cancel('review-1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it.each([
    ['parentSessionId', 'parent-2'],
    ['reviewerSessionId', 'reviewer-2'],
    ['generation', 'generation-2'],
    ['actionHash', `sha256:${'0'.repeat(64)}`],
  ] as const)('fails closed when %s mismatches', async (field, value) => {
    const broker = new DecisionBroker(new FakeClock())
    const pending = broker.arm(request())
    expect(broker.submit({ ...decision(), [field]: value }, { actualReviewerSessionId: 'reviewer-1' }).status)
      .toBe('identity-mismatch')
    await expect(pending).rejects.toMatchObject({ code: 'identity-mismatch' })
  })

  it('binds the result to the actual scoped-tool child identity', async () => {
    const broker = new DecisionBroker(new FakeClock())
    const pending = broker.arm(request())
    expect(broker.submit(decision(), { actualReviewerSessionId: 'reviewer-elsewhere' }).status)
      .toBe('identity-mismatch')
    await expect(pending).rejects.toMatchObject({ code: 'identity-mismatch' })
  })

  it('times out, rejects the promise, and classifies a later result', async () => {
    const clock = new FakeClock()
    const broker = new DecisionBroker(clock)
    const pending = broker.arm(request())
    clock.advance(101)
    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'timed-out' }))
    expect(broker.submit(decision(), { actualReviewerSessionId: 'reviewer-1' })).toEqual({ status: 'late', reviewId: 'review-1' })
  })

  it('honors abort and disposal without double settlement', async () => {
    const broker = new DecisionBroker(new FakeClock())
    const abort = new AbortController()
    const first = broker.arm(request(), abort.signal)
    const secondRequest = request({ reviewId: 'review-2' })
    const second = broker.arm(secondRequest)
    abort.abort()
    broker.close()
    broker.close()
    await expect(first).rejects.toMatchObject({ code: 'aborted' })
    await expect(second).rejects.toMatchObject({ code: 'disposed' })
  })

  it('reports unknown ids without affecting pending work', async () => {
    const broker = new DecisionBroker(new FakeClock())
    const pending = broker.arm(request())
    const unknown = { ...decision(), reviewId: 'review-unknown' }
    expect(broker.submit(unknown, { actualReviewerSessionId: 'reviewer-1' }))
      .toEqual({ status: 'unknown', reviewId: 'review-unknown' })
    broker.cancel('review-1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})
