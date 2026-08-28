import { describe, expect, it } from 'vitest'
import { InMemoryGateDecisionRecordStore } from '../../src/index.js'
import type { GateDecisionRecord } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function record(overrides: Partial<GateDecisionRecord> = {}): GateDecisionRecord {
  return {
    reviewRunId: 'run-1',
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    callId: 'call-1',
    actionHash: hash('a'),
    generation: 'generation-1',
    configurationFingerprint: hash('cfg'),
    disposition: 'allow',
    ...overrides,
  }
}

describe('InMemoryGateDecisionRecordStore', () => {
  it('confirms a new record and treats an identical confirmation as idempotent', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
  })

  it('returns conflict when the same ask confirms a different disposition', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.createConfirmed(record())
    await expect(store.createConfirmed(record({ disposition: 'deny' }))).resolves.toBe('conflict')
  })

  it('allows a best-effort record to be promoted to confirmed', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.recordBestEffort(record())
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
  })

  it('conflicts when a best-effort record contradicts a later confirmation', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.recordBestEffort(record({ disposition: 'deny' }))
    await expect(store.createConfirmed(record())).resolves.toBe('conflict')
  })

  it('throws when a best-effort record would contradict an existing best effort', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.recordBestEffort(record({ disposition: 'deny' }))
    await expect(store.recordBestEffort(record())).rejects.toThrow(/conflicts/)
  })
})
