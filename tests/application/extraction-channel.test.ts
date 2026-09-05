import { describe, expect, it } from 'vitest'
import {
  DefaultExtractionChannel,
  ReviewProtocolError,
} from '../../src/index.js'
import type { AuthorizationExtractionRequest, ReviewClock } from '../../src/index.js'

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

function request(overrides: Partial<AuthorizationExtractionRequest> = {}): AuthorizationExtractionRequest {
  const base: AuthorizationExtractionRequest = {
    extractionId: 'ext-1',
    parentSessionId: 'parent-1',
    extractorSessionId: 'extractor-1',
    generation: 'generation-1',
    extractorVersion: 'extractor-v1',
    throughSeq: 42,
    deadlineAt: 200,
  }
  return { ...base, ...overrides }
}

function submission(req = request()) {
  return {
    protocolVersion: 1,
    extractionId: req.extractionId,
    parentSessionId: req.parentSessionId,
    extractorSessionId: req.extractorSessionId,
    generation: req.generation,
    extractorVersion: req.extractorVersion,
    throughSeq: req.throughSeq,
    entries: [
      { sourceSeq: 10, quote: 'please allow this', effect: 'grant', coverage: 'action', summary: 'user grants' },
    ],
  }
}

describe('DefaultExtractionChannel', () => {
  it('accepts the first fully matching result and tombstones duplicates', async () => {
    const clock = new FakeClock()
    const channel = new DefaultExtractionChannel(clock)
    const pending = channel.arm(request())
    const first = channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' })
    const second = channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' })
    expect(first.status).toBe('accepted')
    expect(second).toEqual({ status: 'duplicate', extractionId: 'ext-1' })
    await expect(pending).resolves.toMatchObject({ extractionId: 'ext-1' })
  })

  it('closes a routable malformed result instead of waiting for a replacement', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    const malformed = { ...submission(), entries: [{ sourceSeq: -1, quote: 'x', effect: 'grant', coverage: 'action', summary: 'y' }] }
    const disposition = channel.submit(malformed, { actualExtractorSessionId: 'extractor-1' })
    expect(disposition.status).toBe('invalid')
    await expect(pending).rejects.toMatchObject({ code: 'invalid-result' })
    expect(channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' }))
      .toEqual({ status: 'late', extractionId: 'ext-1' })
  })

  it('does not let an unroutable malformed payload close another request', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    expect(channel.submit('grant', { actualExtractorSessionId: 'extractor-1' }).status).toBe('invalid')
    // Pending work stays open: a later valid result is still accepted.
    expect(channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' }).status).toBe('accepted')
    await expect(pending).resolves.toMatchObject({ extractionId: 'ext-1' })
  })

  it('does not let a routable invalid payload from another child kill the pending extraction', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    const malformed = { ...submission(), entries: [{ sourceSeq: -1, quote: 'x', effect: 'grant', coverage: 'action', summary: 'y' }] }
    expect(channel.submit(malformed, { actualExtractorSessionId: 'extractor-other' }).status).toBe('invalid')
    // The owning extractor can still submit a valid result.
    expect(channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' }).status).toBe('accepted')
    await expect(pending).resolves.toMatchObject({ extractionId: 'ext-1' })
  })

  it.each([
    ['parentSessionId', 'parent-2'],
    ['extractorSessionId', 'extractor-2'],
    ['generation', 'generation-2'],
    ['extractorVersion', 'extractor-v2'],
    ['throughSeq', 99],
  ] as const)('fails closed when %s mismatches', async (field, value) => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    expect(channel.submit({ ...submission(), [field]: value }, { actualExtractorSessionId: 'extractor-1' }).status)
      .toBe('identity-mismatch')
    await expect(pending).rejects.toMatchObject({ code: 'identity-mismatch' })
  })

  it('binds the result to the actual scoped-tool child identity', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    expect(channel.submit(submission(), { actualExtractorSessionId: 'extractor-elsewhere' }).status)
      .toBe('identity-mismatch')
    await expect(pending).rejects.toMatchObject({ code: 'identity-mismatch' })
  })

  it('times out, rejects the promise, and classifies a later result', async () => {
    const clock = new FakeClock()
    const channel = new DefaultExtractionChannel(clock)
    const pending = channel.arm(request())
    clock.advance(101)
    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'timed-out' }))
    expect(channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' }))
      .toEqual({ status: 'late', extractionId: 'ext-1' })
  })

  it('honors abort and disposal without double settlement', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const abort = new AbortController()
    const first = channel.arm(request(), abort.signal)
    const secondRequest = request({ extractionId: 'ext-2' })
    const second = channel.arm(secondRequest)
    abort.abort()
    channel.dispose()
    channel.dispose()
    await expect(first).rejects.toMatchObject({ code: 'aborted' })
    await expect(second).rejects.toMatchObject({ code: 'disposed' })
  })

  it('reports unknown ids without affecting pending work', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    const unknown = { ...submission(), extractionId: 'ext-unknown' }
    expect(channel.submit(unknown, { actualExtractorSessionId: 'extractor-1' }))
      .toEqual({ status: 'unknown', extractionId: 'ext-unknown' })
    channel.cancel('ext-1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects arming an id that already settled', async () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    const pending = channel.arm(request())
    channel.cancel('ext-1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(() => channel.arm(request())).toThrow(/already been armed/)
  })

  it('throws synchronously for a duplicate pending id', () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    channel.arm(request())
    expect(() => channel.arm(request())).toThrow(/already been armed/)
  })

  it('throws synchronously for an already-aborted or expired arm and tombstones it', () => {
    const clock = new FakeClock()
    const channel = new DefaultExtractionChannel(clock)
    const abort = new AbortController()
    abort.abort()
    expect(() => channel.arm(request(), abort.signal))
      .toThrow(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'aborted' }))
    // The tombstone is recorded: a later result for that id is late, never accepted.
    expect(channel.submit(submission(), { actualExtractorSessionId: 'extractor-1' }))
      .toEqual({ status: 'late', extractionId: 'ext-1' })
    const expired = request({ extractionId: 'ext-2', deadlineAt: 50 })
    expect(() => channel.arm(expired))
      .toThrow(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'timed-out' }))
  })

  it('throws synchronously when the channel is disposed', () => {
    const channel = new DefaultExtractionChannel(new FakeClock())
    channel.dispose()
    expect(() => channel.arm(request()))
      .toThrow(expect.objectContaining<Partial<ReviewProtocolError>>({ code: 'disposed' }))
  })

  it('rejects a submission arriving after the deadline via receivedAt', async () => {
    const clock = new FakeClock()
    const channel = new DefaultExtractionChannel(clock)
    const pending = channel.arm(request())
    const result = channel.submit(submission(), { actualExtractorSessionId: 'extractor-1', receivedAt: 201 })
    expect(result.status).toBe('late')
    await expect(pending).rejects.toMatchObject({ code: 'timed-out' })
  })

  it('accepts a submission arriving exactly at the deadline', async () => {
    const clock = new FakeClock()
    const channel = new DefaultExtractionChannel(clock)
    const pending = channel.arm(request())
    const result = channel.submit(submission(), { actualExtractorSessionId: 'extractor-1', receivedAt: 200 })
    expect(result.status).toBe('accepted')
    await expect(pending).resolves.toMatchObject({ extractionId: 'ext-1' })
  })
})
