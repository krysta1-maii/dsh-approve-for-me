import { describe, expect, it } from 'vitest'
import {
  DefaultDecisionChannel,
  ReviewProtocolError,
  createActionSnapshot,
  createApprovalReviewRequest,
} from '../../src/index.js'
import type { ApprovalReviewRequest, ReviewClock } from '../../src/index.js'

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

function request(overrides: Partial<ApprovalReviewRequest> = {}): ApprovalReviewRequest {
  const base = createApprovalReviewRequest(createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }), {
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

describe('DefaultDecisionChannel', () => {
  it('accepts the first fully matching result and tombstones duplicates', async () => {
    const clock = new FakeClock()
    const channel = new DefaultDecisionChannel(clock)
    const pending = channel.arm(request())
    const first = channel.submit(decision(), { actualReviewerSessionId: 'reviewer-1' })
    const second = channel.submit(decision(), { actualReviewerSessionId: 'reviewer-1' })
    expect(first.status).toBe('accepted')
    expect(second).toEqual({ status: 'duplicate', reviewId: 'review-1' })
    await expect(pending).resolves.toMatchObject({ decision: 'allow' })
  })

  it('closes a routable malformed result instead of waiting for a replacement', async () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const pending = channel.arm(request())
    const disposition = channel.submit({ ...decision(), risk: 'safe' }, { actualReviewerSessionId: 'reviewer-1' })
    expect(disposition.status).toBe('invalid')
    await expect(pending).rejects.toMatchObject({ code: 'invalid-result' })
    expect(channel.submit(decision(), { actualReviewerSessionId: 'reviewer-1' }))
      .toEqual({ status: 'late', reviewId: 'review-1' })
  })

  it('does not let an unroutable malformed payload close another request', async () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const pending = channel.arm(request())
    expect(channel.submit('allow', { actualReviewerSessionId: 'reviewer-1' }).status).toBe('invalid')
    // Pending work stays open: a later valid result is still accepted.
    expect(channel.submit(decision(), { actualReviewerSessionId: 'reviewer-1' }).status).toBe('accepted')
    await expect(pending).resolves.toMatchObject({ decision: 'allow' })
  })

  it.each([
    ['parentSessionId', 'parent-2'],
    ['reviewerSessionId', 'reviewer-2'],
    ['generation', 'generation-2'],
    ['actionHash', `sha256:${'0'.repeat(64)}`],
  ] as const)('fails closed when %s mismatches', async (field, value) => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const pending = channel.arm(request())
    expect(channel.submit({ ...decision(), [field]: value }, { actualReviewerSessionId: 'reviewer-1' }).status)
      .toBe('identity-mismatch')
    await expect(pending).rejects.toMatchObject({ code: 'identity-mismatch' })
  })

  it('binds the result to the actual scoped-tool child identity', async () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const pending = channel.arm(request())
    expect(channel.submit(decision(), { actualReviewerSessionId: 'reviewer-elsewhere' }).status)
      .toBe('identity-mismatch')
    await expect(pending).rejects.toMatchObject({ code: 'identity-mismatch' })
  })

  it('times out, rejects the promise, and classifies a later result', async () => {
    const clock = new FakeClock()
    const channel = new DefaultDecisionChannel(clock)
    const pending = channel.arm(request())
    clock.advance(101)
    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'timed-out' }))
    expect(channel.submit(decision(), { actualReviewerSessionId: 'reviewer-1' }))
      .toEqual({ status: 'late', reviewId: 'review-1' })
  })

  it('honors abort and disposal without double settlement', async () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const abort = new AbortController()
    const first = channel.arm(request(), abort.signal)
    const secondRequest = request({ reviewId: 'review-2' })
    const second = channel.arm(secondRequest)
    abort.abort()
    channel.dispose()
    channel.dispose()
    await expect(first).rejects.toMatchObject({ code: 'aborted' })
    await expect(second).rejects.toMatchObject({ code: 'disposed' })
  })

  it('reports unknown ids without affecting pending work', async () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const pending = channel.arm(request())
    const unknown = { ...decision(), reviewId: 'review-unknown' }
    expect(channel.submit(unknown, { actualReviewerSessionId: 'reviewer-1' }))
      .toEqual({ status: 'unknown', reviewId: 'review-unknown' })
    channel.cancel('review-1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects arming an id that already settled', async () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    const pending = channel.arm(request())
    channel.cancel('review-1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(() => channel.arm(request())).toThrow(/already been armed/)
  })

  it('throws synchronously for a duplicate pending id', () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    channel.arm(request())
    expect(() => channel.arm(request())).toThrow(/already been armed/)
  })

  it('throws synchronously for an already-aborted or expired arm and tombstones it', () => {
    const clock = new FakeClock()
    const channel = new DefaultDecisionChannel(clock)
    const abort = new AbortController()
    abort.abort()
    expect(() => channel.arm(request(), abort.signal))
      .toThrow(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'aborted' }))
    // The tombstone is recorded: a later result for that id is late, never accepted.
    expect(channel.submit(decision(), { actualReviewerSessionId: 'reviewer-1' }))
      .toEqual({ status: 'late', reviewId: 'review-1' })
    const expired = request({ reviewId: 'review-2', issuedAt: 100, deadlineAt: 50 })
    expect(() => channel.arm(expired))
      .toThrow(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'timed-out' }))
  })

  it('throws synchronously when the channel is disposed', () => {
    const channel = new DefaultDecisionChannel(new FakeClock())
    channel.dispose()
    expect(() => channel.arm(request()))
      .toThrow(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'disposed' }))
  })
})
