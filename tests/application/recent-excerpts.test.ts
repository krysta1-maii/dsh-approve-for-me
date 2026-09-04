import { describe, expect, it } from 'vitest'
import {
  assembleRecentExcerpts,
  DEFAULT_MAX_RECENT_EXCERPT_EVENTS,
} from '../../src/application/recent-excerpts.js'
import type { RecentExcerptEventView } from '../../src/application/recent-excerpts.js'

const user = (seq: number, text: string, data: unknown = {}): RecentExcerptEventView => ({
  seq,
  type: 'user/message',
  time: 1_000 + seq,
  data: {
    id: `user-${seq}`,
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
    ...(data as Record<string, unknown>),
  },
})

/** A user/message event masquerading as a non-human (tool / model / plugin) source. */
const injected = (seq: number, kind: string, body: string): RecentExcerptEventView => ({
  seq,
  type: 'user/message',
  time: 1_000 + seq,
  data: { id: `user-${seq}`, source: { kind, callId: 'call-secret' }, content: [{ type: 'text', text: body }] as unknown[] },
})

const session = (events: readonly RecentExcerptEventView[]) => {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return { eventAt: (seq: number) => bySeq.get(seq) }
}

describe('assembleRecentExcerpts', () => {
  it('returns an empty, legal result when the window has no human user messages', () => {
    const subject = session([
      { seq: 1, type: 'assistant/message', time: 1_001, data: { source: { kind: 'model' }, content: [{ type: 'text', text: 'LLM text' }] } },
      { seq: 2, type: 'tool/result', time: 1_002, data: {} },
    ])
    expect(assembleRecentExcerpts({ askedSeq: 5, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })).toEqual({
      excerpts: [],
      truncated: 0,
      stripped: 0,
    })
  })

  it('captures a single human user/message as one ordered {seq, text} excerpt', () => {
    const subject = session([user(3, 'inspect the workspace first')])
    const got = assembleRecentExcerpts({ askedSeq: 6, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })
    expect(got).toEqual({ excerpts: [{ seq: 3, text: 'inspect the workspace first' }], truncated: 0, stripped: 0 })
  })

  it('keeps the newest excerpt and drops the oldest on over-budget, counting the drop', () => {
    const subject = session([user(3, 'aaaa'), user(6, 'bbbb')])
    const got = assembleRecentExcerpts({ askedSeq: 8, maxRecentExcerptBytes: 25, eventAt: subject.eventAt })
    // Each {seq, text} canonical entry is ~22 bytes; two together exceed 25.
    expect(got.excerpts).toEqual([{ seq: 6, text: 'bbbb' }])
    expect(got.truncated).toBe(1)
    expect(got.stripped).toBe(0)
  })

  it('retains both excerpts in ascending seq order when the budget covers both', () => {
    const subject = session([user(3, 'aaaa'), user(6, 'bbbb')])
    const got = assembleRecentExcerpts({ askedSeq: 8, maxRecentExcerptBytes: 50, eventAt: subject.eventAt })
    expect(got.excerpts).toEqual([{ seq: 3, text: 'aaaa' }, { seq: 6, text: 'bbbb' }])
    expect(got.truncated).toBe(0)
  })

  it('filters tool, model, and plugin/instructions sources from the intent channel', () => {
    const subject = session([
      injected(1, 'tool', 'tool output body'),
      injected(2, 'model', 'LLM rationale'),
      injected(3, 'agent-instructions', 'follow project rules'),
      user(4, 'the real user intent'),
    ])
    const got = assembleRecentExcerpts({ askedSeq: 6, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })
    expect(got.excerpts).toEqual([{ seq: 4, text: 'the real user intent' }])
    expect(got.stripped).toBe(3)
    expect(got.truncated).toBe(0)
  })

  it('does not copy tool-result bodies, IDs, or session IDs from a user message payload (leak guard)', () => {
    const subject = session([user(3, 'safe intent', {
      id: 'evt-evil-123',
      sessionId: 'session-secret',
      content: [
        { type: 'text', text: 'safe intent' },
        { type: 'tool-result', text: 'SENSITIVE-OUTPUT-XYZ', toolCallId: 'call-secret' },
      ] as unknown[],
    })])
    const got = assembleRecentExcerpts({ askedSeq: 6, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })
    expect(got.excerpts).toEqual([{ seq: 3, text: 'safe intent' }])
    const serialized = JSON.stringify(got.excerpts)
    expect(serialized).not.toContain('SENSITIVE-OUTPUT-XYZ')
    expect(serialized).not.toContain('call-secret')
    expect(serialized).not.toContain('evt-evil-123')
    expect(serialized).not.toContain('session-secret')
    expect(got.excerpts[0]!.text).toBe('safe intent')
  })

  it('strips control characters and abnormal shapes into safe normalized text', () => {
    const subject = session([user(3, `\u0000hello\u0007 world\u001F`)])
    const got = assembleRecentExcerpts({ askedSeq: 6, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })
    expect(got.excerpts[0]!.text).toBe('hello world')
  })

  it('normalizes an event whose content carries only non-text blocks as stripped, not leaked', () => {
    const subject = session([{
      seq: 3,
      type: 'user/message',
      time: 1_003,
      data: { id: 'user-3', source: { kind: 'user' }, content: [{ type: 'tool-result', text: 'SENSITIVE-OUTPUT', toolCallId: 'call-secret' }] as unknown[] },
    }])
    const got = assembleRecentExcerpts({ askedSeq: 6, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })
    expect(got.excerpts).toEqual([])
    expect(got.stripped).toBe(1)
    expect(JSON.stringify(got.excerpts)).not.toContain('SENSITIVE-OUTPUT')
  })

  it('bounds the back-scan to the requested window (independent from the seal tail)', () => {
    const subject = session([user(290, 'outside window'), user(297, 'inside window')])
    const got = assembleRecentExcerpts({ askedSeq: 300, maxRecentExcerptBytes: 24_000, maxRecentExcerptEvents: 5, eventAt: subject.eventAt })
    expect(got.excerpts).toEqual([{ seq: 297, text: 'inside window' }])
  })

  it('defaults the window to DEFAULT_MAX_RECENT_EXCERPT_EVENTS (same order as the sealed tail)', () => {
    // askedSeq 2000, default window 512 => start 1488; only seq 1500 is collected.
    const subject = session([user(1_500, 'in default window')])
    const got = assembleRecentExcerpts({ askedSeq: 2_000, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })
    expect(got.excerpts).toEqual([{ seq: 1_500, text: 'in default window' }])
    expect(DEFAULT_MAX_RECENT_EXCERPT_EVENTS).toBe(512)
  })

  it('is deterministic: replaying the same session yields the same output', () => {
    const subject = session([user(2, 'first'), user(5, 'second')])
    const input = { askedSeq: 7, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt }
    expect(assembleRecentExcerpts(input)).toEqual(assembleRecentExcerpts(input))
    expect(assembleRecentExcerpts(input)).toEqual({
      excerpts: [{ seq: 2, text: 'first' }, { seq: 5, text: 'second' }],
      truncated: 0,
      stripped: 0,
    })
  })

  it('degrades to an empty result for invalid inputs instead of throwing', () => {
    const subject = session([user(3, 'hello')])
    expect(assembleRecentExcerpts({ askedSeq: -1, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })).toEqual({ excerpts: [], truncated: 0, stripped: 0 })
    expect(assembleRecentExcerpts({ askedSeq: 5, maxRecentExcerptBytes: 24_000, eventAt: subject.eventAt })).toEqual({
      excerpts: [{ seq: 3, text: 'hello' }],
      truncated: 0,
      stripped: 0,
    })
    expect(assembleRecentExcerpts({ askedSeq: 5, maxRecentExcerptBytes: Number.NaN, eventAt: subject.eventAt })).toEqual({ excerpts: [], truncated: 0, stripped: 0 })
  })
})
