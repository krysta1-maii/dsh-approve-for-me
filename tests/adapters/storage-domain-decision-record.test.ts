import { describe, expect, it, vi } from 'vitest'
import { DshStorageDomainGateDecisionRecordStore } from '../../src/index.js'
import type { GateDecisionRecord, StorageDomainFacility } from '../../src/index.js'

function record(overrides: Partial<GateDecisionRecord> = {}): GateDecisionRecord {
  return {
    reviewRunId: 'run-1', requestId: 'ask-1', parentSessionId: 'session-1',
    callId: 'call-1', actionHash: `sha256:${'a'.repeat(64)}`,
    generation: 'gen-1', configurationFingerprint: `sha256:${'b'.repeat(64)}`,
    disposition: 'allow', ...overrides,
  }
}

function facility() {
  const rows = new Map<string, unknown>()
  const put = vi.fn(async (key: string, value: unknown) => { rows.set(key, value) })
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ table: () => ({ get: (key: string) => rows.get(key), put }), close }))
  return { facility: { open } as StorageDomainFacility, rows, put, close, open }
}

describe('DshStorageDomainGateDecisionRecordStore', () => {
  it('uses one private per-key lane to create once durably', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(Promise.all([store.createConfirmed(record()), store.createConfirmed(record())]))
      .resolves.toEqual(['confirmed', 'confirmed'])
    expect(fake.put).toHaveBeenCalledOnce()
    await store.drain()
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('detects an incompatible durable decision rather than overwriting it', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed(record({ disposition: 'deny' }))).resolves.toBe('conflict')
    expect(fake.put).toHaveBeenCalledOnce()
  })

  it('fails closed when the domain cannot open', async () => {
    const store = new DshStorageDomainGateDecisionRecordStore({ open: async () => { throw new Error('offline') } })
    await expect(store.createConfirmed(record())).resolves.toBe('unavailable')
  })
})
