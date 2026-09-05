import { describe, expect, it } from 'vitest'
import {
  collectAuthorizationInputWindow,
  createAuthorizationEntryV1,
  genesisAuthorizationHash,
  verifyAuthorizationEntriesLiveV1,
  verifyAuthorizationEntryLiveV1,
} from '../../src/index.js'
import type { AuthorizationLiveEventView } from '../../src/index.js'

const LIFE = 'life'

function userEvent(seq: number, text: string, time = 1000 + seq): AuthorizationLiveEventView {
  return {
    seq,
    type: 'user/message',
    time,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function view(events: readonly AuthorizationLiveEventView[]) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return (seq: number) => bySeq.get(seq)
}

function entry(over: Partial<Parameters<typeof createAuthorizationEntryV1>[0]> = {}) {
  return createAuthorizationEntryV1({
    lifecycleFingerprint: LIFE,
    sourceSeq: 5,
    occurredAt: 1005,
    quote: 'delete the cache',
    effect: 'grant',
    coverage: 'action',
    summary: 'user allows deleting the cache',
    extractorVersion: 'extractor-v1',
    previousEntryHash: genesisAuthorizationHash(LIFE),
    ...over,
  })
}

describe('authorization live verification', () => {
  const events = [userEvent(5, 'please delete the cache now')]
  it('accepts a verbatim quote re-bound to its exact live event', () => {
    expect(verifyAuthorizationEntryLiveV1(entry(), view(events))).toBeDefined()
  })
  it('rejects a quote that is not a verbatim substring', () => {
    expect(verifyAuthorizationEntryLiveV1(entry({ quote: 'delete the caches' }), view(events))).toBeUndefined()
    expect(verifyAuthorizationEntryLiveV1(entry({ quote: 'cache the delete' }), view(events))).toBeUndefined()
  })
  it('rejects a missing, wrong-type, or wrong-time event', () => {
    expect(verifyAuthorizationEntryLiveV1(entry(), view([]))).toBeUndefined()
    expect(verifyAuthorizationEntryLiveV1(entry(), view([{ ...userEvent(5, 'please delete the cache now'), type: 'assistant/message' }]))).toBeUndefined()
    expect(verifyAuthorizationEntryLiveV1(entry(), view([userEvent(5, 'please delete the cache now', 9999)]))).toBeUndefined()
  })
  it('rejects plugin-injected (non-human) sources and malformed entries', () => {
    const injected = userEvent(5, 'please delete the cache now')
    ;(injected.data as { source: { kind: string } }).source.kind = 'plugin'
    expect(verifyAuthorizationEntryLiveV1(entry(), view([injected]))).toBeUndefined()
    expect(verifyAuthorizationEntryLiveV1({ version: 7 }, view(events))).toBeUndefined()
  })
  it('poisons the whole batch when any single entry fails', () => {
    const good = entry()
    const bad = entry({ sourceSeq: 6, occurredAt: 1006, previousEntryHash: good.entryHash })
    expect(verifyAuthorizationEntriesLiveV1([good], view(events))).toBeDefined()
    expect(verifyAuthorizationEntriesLiveV1([good, bad], view(events))).toBeUndefined()
  })
})

describe('collectAuthorizationInputWindow', () => {
  const events = [
    userEvent(3, 'first'),
    userEvent(8, 'second'),
    { seq: 9, type: 'assistant/message', time: 1009, data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'model' }] } },
    userEvent(15, 'third'),
  ]
  it('collects only direct human user texts in (afterSeq, throughSeq]', () => {
    const result = collectAuthorizationInputWindow({ afterSeq: 2, throughSeq: 15, eventAt: view(events) })
    expect(result.items.map(item => [item.seq, item.text])).toEqual([[3, 'first'], [8, 'second'], [15, 'third']])
    expect(result.throughSeq).toBe(15)
    expect(result.truncated).toBe(0)
  })
  it('respects the exclusive lower bound and keeps newest under the event budget', () => {
    const result = collectAuthorizationInputWindow({ afterSeq: 3, throughSeq: 15, eventAt: view(events), maxEvents: 1 })
    expect(result.items.map(item => item.seq)).toEqual([15])
    expect(result.truncated).toBe(1)
  })
  it('keeps newest under the byte budget and counts dropped candidates', () => {
    const result = collectAuthorizationInputWindow({ afterSeq: 0, throughSeq: 15, eventAt: view(events), maxWindowBytes: 40 })
    expect(result.items.map(item => item.text)).toEqual(['third'])
    expect(result.truncated).toBe(2)
  })
  it('degrades to empty on an invalid range or a throwing eventAt', () => {
    expect(collectAuthorizationInputWindow({ afterSeq: 9, throughSeq: 3, eventAt: view(events) }).items).toEqual([])
    expect(collectAuthorizationInputWindow({ afterSeq: 0, throughSeq: 15, eventAt: () => { throw new Error('boom') } }).items).toEqual([])
  })
})
