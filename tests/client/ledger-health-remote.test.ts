import { describe, expect, it, vi } from 'vitest'
import {
  decodeLedgerHealth,
  fetchLedgerHealth,
  LEDGER_HEALTH_REMOTE_PATH,
  type LedgerHealthViewModel,
} from '../../src/client/ledger-health-remote.js'

const FULL = {
  version: 1,
  seal: { chains: 2, sealedFacts: 7 },
  authorization: { entries: 3, checkpoints: 2, maxThroughSeq: 50615 },
  generatedAt: 1725500000000,
}

function fetchOf(body: unknown, init: { ok?: boolean; throws?: boolean; badJson?: boolean } = {}) {
  return vi.fn(async () => {
    if (init.throws) throw new Error('network down')
    return {
      ok: init.ok ?? true,
      json: init.badJson ? async () => { throw new Error('not json') } : async () => body,
    }
  })
}

describe('decodeLedgerHealth (WP8-b closed set)', () => {
  it('accepts the full shape', () => {
    expect(decodeLedgerHealth(FULL)).toEqual(FULL)
  })

  it('accepts degraded bodies with either or both segments omitted', () => {
    expect(decodeLedgerHealth({ version: 1, generatedAt: 5 })).toEqual({ version: 1, generatedAt: 5 })
    expect(decodeLedgerHealth({ version: 1, seal: { chains: 1, sealedFacts: 2 }, generatedAt: 5 })).toEqual({
      version: 1,
      seal: { chains: 1, sealedFacts: 2 },
      generatedAt: 5,
    })
    expect(decodeLedgerHealth({
      version: 1,
      authorization: { entries: 0, checkpoints: 0, maxThroughSeq: null },
      generatedAt: 5,
    })).toEqual({
      version: 1,
      authorization: { entries: 0, checkpoints: 0, maxThroughSeq: null },
      generatedAt: 5,
    })
  })

  it('rejects unknown fields anywhere in the body', () => {
    expect(decodeLedgerHealth({ ...FULL, sessionId: 's-1' })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, seal: { ...FULL.seal, tipHash: 'sha256:x' } })).toBeUndefined()
    expect(decodeLedgerHealth({
      ...FULL,
      authorization: { ...FULL.authorization, quote: 'allow it' },
    })).toBeUndefined()
  })

  it('rejects wrong versions, missing generatedAt, and wrong leaf types', () => {
    expect(decodeLedgerHealth({ ...FULL, version: 2 })).toBeUndefined()
    expect(decodeLedgerHealth({ version: 1, seal: FULL.seal })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, generatedAt: 'now' })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, generatedAt: -1 })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, generatedAt: 1.5 })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, seal: { chains: '2', sealedFacts: 7 } })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, seal: { chains: -2, sealedFacts: 7 } })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, authorization: { entries: 3, checkpoints: 2, maxThroughSeq: undefined } })).toBeUndefined()
    expect(decodeLedgerHealth({ ...FULL, authorization: { entries: 3, checkpoints: 2, maxThroughSeq: '50615' } })).toBeUndefined()
    expect(decodeLedgerHealth(null)).toBeUndefined()
    expect(decodeLedgerHealth('json string')).toBeUndefined()
    expect(decodeLedgerHealth([1, 2, 3])).toBeUndefined()
  })

  it('rejects values over the hard count cap', () => {
    expect(decodeLedgerHealth({ ...FULL, seal: { chains: 0x7fffffff + 1, sealedFacts: 7 } })).toBeUndefined()
    expect(decodeLedgerHealth({
      ...FULL,
      authorization: { entries: 3, checkpoints: 2, maxThroughSeq: 0x7fffffff + 1 },
    })).toBeUndefined()
  })
})

describe('fetchLedgerHealth', () => {
  it('fetches the default path and decodes a healthy body', async () => {
    const fetchImpl = fetchOf(FULL)
    const model = await fetchLedgerHealth({ fetch: fetchImpl })
    expect(model).toEqual(FULL)
    expect(fetchImpl).toHaveBeenCalledWith(LEDGER_HEALTH_REMOTE_PATH)
  })

  it('never rejects: network error, non-200, and bad JSON all settle to undefined', async () => {
    expect(await fetchLedgerHealth({ fetch: fetchOf(FULL, { throws: true }) })).toBeUndefined()
    expect(await fetchLedgerHealth({ fetch: fetchOf(FULL, { ok: false }) })).toBeUndefined()
    expect(await fetchLedgerHealth({ fetch: fetchOf(FULL, { ok: false, badJson: true }) })).toBeUndefined()
    expect(await fetchLedgerHealth({ fetch: fetchOf({ version: 1, generatedAt: 'x' }) })).toBeUndefined()
    expect(await fetchLedgerHealth({ fetch: fetchOf(undefined) })).toBeUndefined()
  })

  it('settles to undefined when no fetch implementation exists', async () => {
    const original = globalThis.fetch
    // @ts-expect-error deliberate removal for the default-path branch
    delete globalThis.fetch
    try {
      expect(await fetchLedgerHealth()).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('supports a path override', async () => {
    const fetchImpl = fetchOf(FULL)
    await fetchLedgerHealth({ fetch: fetchImpl, path: '/custom/health' })
    expect(fetchImpl).toHaveBeenCalledWith('/custom/health')
  })
})

describe('LedgerHealthViewModel type', () => {
  it('is exported for the settings-card renderer contract', () => {
    const model: LedgerHealthViewModel | undefined = decodeLedgerHealth(FULL)
    expect(model?.authorization?.maxThroughSeq).toBe(50615)
  })
})
