import { describe, expect, it, vi } from 'vitest'
import {
  createReasonCodeRemoteBridge,
  REASON_CODE_REMOTE_MAX_ENTRIES,
  REASON_CODE_REMOTE_PATH,
} from '../../src/client/reason-code-remote.js'
import { shouldRequestReasonCode } from '../../src/client/approval-flow-item.js'

interface FakeResponse {
  readonly ok: boolean
  json(): Promise<unknown>
}

function fakeFetch(handler: (url: string) => FakeResponse | Promise<FakeResponse>) {
  const calls: string[] = []
  const impl = async (url: string): Promise<FakeResponse> => {
    calls.push(url)
    return handler(url)
  }
  return { impl, calls }
}

const jsonBody = (value: unknown): FakeResponse => ({
  ok: true,
  json: async () => value,
})

describe('reason-code remote bridge (WP8-a)', () => {
  it('fetches the exact route and settles a known code', async () => {
    const { impl, calls } = fakeFetch(() => jsonBody({ version: 1, reasonCode: 'ledger-conflict' }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    expect(bridge.resolve('ask-1')).toBeUndefined()
    await bridge.request('ask-1')
    expect(calls).toEqual([`${REASON_CODE_REMOTE_PATH}?requestId=ask-1`])
    expect(bridge.resolve('ask-1')).toBe('ledger-conflict')
  })

  it('dedupes concurrent requests for one id into a single fetch', async () => {
    const { impl, calls } = fakeFetch(() => jsonBody({ version: 1 }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    await Promise.all([bridge.request('ask-1'), bridge.request('ask-1'), bridge.request('ask-1')])
    expect(calls).toHaveLength(1)
  })

  it('does not re-fetch a settled entry', async () => {
    const { impl, calls } = fakeFetch(() => jsonBody({ version: 1, reasonCode: 'integrity' }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    await bridge.request('ask-1')
    await bridge.request('ask-1')
    expect(calls).toHaveLength(1)
  })

  it('caches null on non-200, malformed JSON, unknown code and fetch failure', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes('ask-bad-status')) return { ok: false, json: async () => ({}) }
      if (url.includes('ask-bad-json')) return { ok: true, json: async () => { throw new Error('nope') } }
      if (url.includes('ask-unknown')) return jsonBody({ version: 1, reasonCode: 'made-up' })
      if (url.includes('ask-throws')) throw new Error('network down')
      return jsonBody({ version: 1 })
    })
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    for (const id of ['ask-bad-status', 'ask-bad-json', 'ask-unknown', 'ask-throws']) {
      await expect(bridge.request(id)).resolves.toBeUndefined()
      expect(bridge.resolve(id)).toBeUndefined()
    }
    // All four failure modes are settled as null: no retry is attempted.
    await bridge.request('ask-bad-status')
    await bridge.request('ask-throws')
    expect(calls).toHaveLength(4)
  })

  it('settles a bare {version:1} body to a null (miss) entry', async () => {
    const { impl, calls } = fakeFetch(() => jsonBody({ version: 1 }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    await bridge.request('ask-1')
    expect(bridge.resolve('ask-1')).toBeUndefined()
    await bridge.request('ask-1')
    expect(calls).toHaveLength(1)
  })

  it('bounds the settled cache keep-newest', async () => {
    const { impl } = fakeFetch(url => jsonBody({
      version: 1,
      reasonCode: url.endsWith('requestId=ask-1') ? 'integrity' : undefined,
    }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl, maxEntries: 2 })
    await bridge.request('ask-1')
    await bridge.request('ask-2')
    await bridge.request('ask-3')
    expect(bridge.resolve('ask-1')).toBeUndefined() // evicted oldest
    expect(bridge.resolve('ask-2')).toBeUndefined()
    expect(bridge.resolve('ask-3')).toBeUndefined()
    expect(REASON_CODE_REMOTE_MAX_ENTRIES).toBe(256)
  })

  it('re-requesting a settled id refreshes its recency', async () => {
    const { impl } = fakeFetch(() => jsonBody({ version: 1 }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl, maxEntries: 2 })
    await bridge.request('ask-1')
    await bridge.request('ask-2')
    // touch ask-1: it must now survive the eviction of ask-2
    await bridge.request('ask-1')
    await bridge.request('ask-3')
    // ask-1 settled -> no fetch happened again; ask-2 was evicted instead
    await bridge.request('ask-1')
    expect(bridge.resolve('ask-1')).toBeUndefined()
  })

  it('resolve is synchronous and never throws on unknown cache shapes', async () => {
    const { impl } = fakeFetch(() => jsonBody({ version: 1, reasonCode: 'integrity' }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    expect(bridge.resolve('missing')).toBeUndefined()
    await bridge.request('ask-1')
    expect(bridge.resolve('ask-1')).toBe('integrity')
  })

  it('reset drops settled and in-flight state', async () => {
    const { impl, calls } = fakeFetch(() => jsonBody({ version: 1 }))
    const bridge = createReasonCodeRemoteBridge({ fetch: impl })
    await bridge.request('ask-1')
    bridge.reset()
    await bridge.request('ask-1')
    expect(calls).toHaveLength(2)
  })
})

describe('shouldRequestReasonCode (ApprovalFlowItem gate)', () => {
  it('requests only for unavailable rows without a code', () => {
    expect(shouldRequestReasonCode('unavailable', undefined)).toBe(true)
    expect(shouldRequestReasonCode('unavailable', 'integrity')).toBe(false)
    expect(shouldRequestReasonCode('pending', undefined)).toBe(false)
    expect(shouldRequestReasonCode('allowed-once', undefined)).toBe(false)
    expect(shouldRequestReasonCode('rejected', undefined)).toBe(false)
    expect(shouldRequestReasonCode('cancelled', undefined)).toBe(false)
  })
})
