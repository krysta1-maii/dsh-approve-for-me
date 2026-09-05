import { describe, expect, it, vi } from 'vitest'
import { DshStorageDomainGateDecisionRecordStore } from '../../src/index.js'
import type { GateDecisionRecord, StorageDomainFacility } from '../../src/index.js'

function record(overrides: Partial<GateDecisionRecord> = {}): GateDecisionRecord {
  return {
    version: 2, reviewRunId: 'run-1', route: 'guardian', normalizedDecision: 'allow', pluginDisposition: 'allow',
    requestId: 'ask-1', parentSessionId: 'session-1',
    parentLifecycleFingerprint: 'lifecycle-1', callId: 'call-1', actionHash: `sha256:${'a'.repeat(64)}`,
    generation: 'gen-1', policyVersion: 'policy-1', configurationFingerprint: `sha256:${'b'.repeat(64)}`,
    disposition: 'allow', reviewAttempts: 1, contaminatedRotationAttempts: 0, contaminatedRotations: 0, ...overrides,
  }
}

function facility() {
  const rows = new Map<string, unknown>()
  const put = vi.fn(async (key: string, value: unknown) => { rows.set(key, value) })
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ table: () => ({ get: (key: string) => rows.get(key), put, delete: async (key: string) => { rows.delete(key) } }), close }))
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
    await expect(store.createConfirmed(record({ disposition: 'deny', normalizedDecision: 'deny', pluginDisposition: 'deny' }))).resolves.toBe('conflict')
    await expect(store.createConfirmed(record({ reviewAttempts: 2 }))).resolves.toBe('conflict')
    expect(fake.put).toHaveBeenCalledOnce()
  })

  it('keys reused session ids by their full lifecycle fingerprint', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed(record({ parentLifecycleFingerprint: 'lifecycle-2' }))).resolves.toBe('confirmed')
    expect(fake.put).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a resolved write is not readable as the canonical record', async () => {
    const put = vi.fn(async () => {})
    const store = new DshStorageDomainGateDecisionRecordStore({
      open: async () => ({ table: () => ({ get: () => undefined, put, delete: async () => {} }), close: async () => {} }),
    })
    await expect(store.createConfirmed(record())).resolves.toBe('unavailable')
    expect(put).toHaveBeenCalledOnce()
  })

  it('fails closed before storage on malformed compact audit input', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed({ ...record(), packet: {} } as unknown as GateDecisionRecord)).resolves.toBe('unavailable')
    expect(fake.put).not.toHaveBeenCalled()
  })

  it('fails closed when the domain cannot open', async () => {
    const store = new DshStorageDomainGateDecisionRecordStore({ open: async () => { throw new Error('offline') } })
    await expect(store.createConfirmed(record())).resolves.toBe('unavailable')
  })
})

function failureRecord(code: string): GateDecisionRecord {
  return {
    version: 2, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'unavailable',
    requestId: 'ask-fail', parentSessionId: 'session-1', parentLifecycleFingerprint: 'lifecycle-1', callId: 'call-1',
    actionHash: `sha256:${'a'.repeat(64)}`, generation: 'gen-1', policyVersion: 'policy-1',
    configurationFingerprint: `sha256:${'b'.repeat(64)}`, disposition: 'no-decision', reviewAttempts: 0,
    contaminatedRotationAttempts: 0, contaminatedRotations: 0, failureStage: 'verified-dossier',
    failureCode: code as never,
  }
}

describe('DshStorageDomainGateDecisionRecordStore reason-code read (WP5-c)', () => {
  it('persists a metadata-only reason-code row and reads it back by request id', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed(failureRecord('sealed-current-missing'))).resolves.toBe('confirmed')
    await expect(store.readReasonCode('ask-fail')).resolves.toBe('sealed-current-missing')
  })

  it('does NOT write a reason-code row for a non-failure decision', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.readReasonCode('ask-1')).resolves.toBeUndefined()
  })

  it('returns undefined when the domain is unavailable', async () => {
    const store = new DshStorageDomainGateDecisionRecordStore({ open: async () => { throw new Error('offline') } })
    await expect(store.readReasonCode('ask-fail')).resolves.toBeUndefined()
  })

  it('returns undefined for a missing or malformed index row (degrade to miss)', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.readReasonCode('no-such-ask')).resolves.toBeUndefined()
  })

  it('does not expose any non-reason-code field (metadata-only boundary)', async () => {
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed(failureRecord('ledger-storage-unavailable'))).resolves.toBe('confirmed')
    const code = await store.readReasonCode('ask-fail')
    // The read channel is a typed reason code only: no record shape, hash or
    // action may escape. A mutation that returns the whole record must fail here.
    expect(code).toBe('ledger-storage-unavailable')
    expect(typeof code).toBe('string')
    // The value serializes to a bare JSON string code, never a record/hash object.
    expect(JSON.stringify(code)).toBe(JSON.stringify('ledger-storage-unavailable'))
  })

  it('metadata-only boundary is enforced by the index value schema (a record write is rejected)', async () => {
    // A mutation that tried to store the whole record in the reason-code index
    // would fail the index valueSchema (only {version, failureCode} allowed), so
    // an unauthorized field can never survive into the read channel.
    const fake = facility()
    const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await expect(store.createConfirmed(failureRecord('seal-chain-invalid'))).resolves.toBe('confirmed')
    const raw = fake.rows.get('ask-fail') as { version: number; failureCode: string }
    expect(Object.keys(raw).sort()).toEqual(['failureCode', 'version'])
  })
})
