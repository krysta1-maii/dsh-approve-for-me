import { describe, expect, it } from 'vitest'
import { InMemoryGateDecisionRecordStore } from '../../src/index.js'
import type { GateDecisionRecord } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function record(overrides: Partial<GateDecisionRecord> = {}): GateDecisionRecord {
  return {
    version: 2,
    reviewRunId: 'run-1',
    route: 'guardian',
    normalizedDecision: 'allow',
    pluginDisposition: 'allow',
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    parentLifecycleFingerprint: 'lifecycle-1',
    callId: 'call-1',
    actionHash: hash('a'),
    generation: 'generation-1',
    policyVersion: 'policy-1',
    configurationFingerprint: hash('c'),
    disposition: 'allow',
    reviewAttempts: 1,
    contaminatedRotationAttempts: 0,
    contaminatedRotations: 0,
    ...overrides,
  }
}

describe('InMemoryGateDecisionRecordStore', () => {
  it('confirms a new record and treats an identical confirmation as idempotent', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
  })

  it('accepts a closed post-facts no-decision audit row', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    const { reviewRunId: _reviewRunId, ...base } = record()
    const failure: GateDecisionRecord = {
      ...base,
      route: 'post-facts-failure',
      normalizedDecision: 'no-decision',
      pluginDisposition: 'unavailable',
      disposition: 'no-decision',
      failureStage: 'classification',
      reviewAttempts: 0,
      contaminatedRotationAttempts: 0,
      contaminatedRotations: 0,
    }
    await expect(store.createConfirmed(failure)).resolves.toBe('confirmed')
    await expect(store.createConfirmed({ ...failure, reviewRunId: 'forbidden' })).rejects.toThrow(/no-decision/)
    await expect(store.createConfirmed({ ...failure, failureStage: 'unknown' as never })).rejects.toThrow(/no-decision/)
  })

  it('accepts only a zero-summary exact denial-breaker audit row', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    const { reviewRunId: _reviewRunId, ...base } = record()
    const breaker: GateDecisionRecord = {
      ...base, route: 'exact-denial-breaker', normalizedDecision: 'deny', pluginDisposition: 'deny', disposition: 'deny',
      reviewAttempts: 0, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }
    await expect(store.createConfirmed(breaker)).resolves.toBe('confirmed')
    await expect(store.createConfirmed({ ...breaker, reviewAttempts: 1 })).rejects.toThrow(/execution summary/)
    await expect(store.createConfirmed({ ...breaker, reviewRunId: 'forbidden' })).rejects.toThrow(/reviewRunId/)
  })

  it('rejects unknown fields at the compact durable boundary', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed({ ...record(), packet: {} } as unknown as GateDecisionRecord)).rejects.toThrow(/not supported/)
  })

  it('rejects inconsistent decision fields, execution summaries, and run identity routes', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed(record({ normalizedDecision: 'deny' }))).rejects.toThrow(/inconsistent/)
    await expect(store.createConfirmed(record({ route: 'trust-envelope' }))).rejects.toThrow(/reviewRunId/)
    await expect(store.createConfirmed(record({ contaminatedRotations: 1 }))).rejects.toThrow(/execution summary/)
    await expect(store.createConfirmed(record({ reviewAttempts: 0 }))).rejects.toThrow(/execution summary/)
  })

  it('returns conflict when the same ask confirms a different disposition or execution summary', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.createConfirmed(record())
    await expect(store.createConfirmed(record({ disposition: 'deny', normalizedDecision: 'deny', pluginDisposition: 'deny' }))).resolves.toBe('conflict')
    await expect(store.createConfirmed(record({ reviewAttempts: 2 }))).resolves.toBe('conflict')
  })

  it('does not collide when a reused session id has another lifecycle', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed(record({ parentLifecycleFingerprint: 'lifecycle-2' }))).resolves.toBe('confirmed')
  })

  it('allows a best-effort record to be promoted to confirmed', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.recordBestEffort(record())
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
  })

  it('conflicts when a best-effort record contradicts a later confirmation', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.recordBestEffort(record({ disposition: 'deny', normalizedDecision: 'deny', pluginDisposition: 'deny' }))
    await expect(store.createConfirmed(record())).resolves.toBe('conflict')
  })

  it('throws when a best-effort record would contradict an existing best effort', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await store.recordBestEffort(record({ disposition: 'deny', normalizedDecision: 'deny', pluginDisposition: 'deny' }))
    await expect(store.recordBestEffort(record())).rejects.toThrow(/conflicts/)
  })

  it('accepts a post-facts no-decision row carrying a §4.4 failure code', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    const { reviewRunId: _reviewRunId, ...base } = record()
    const failure: GateDecisionRecord = {
      ...base, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'unavailable',
      disposition: 'no-decision', failureStage: 'verified-dossier', failureCode: 'seal-chain-invalid',
      reviewAttempts: 0, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }
    await expect(store.createConfirmed(failure)).resolves.toBe('confirmed')
  })

  it('rejects an unknown failure code at the compact durable boundary (closed set)', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    const { reviewRunId: _reviewRunId, ...base } = record()
    const failure: GateDecisionRecord = {
      ...base, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'unavailable',
      disposition: 'no-decision', failureStage: 'verified-dossier', failureCode: 'bogus-code' as never,
      reviewAttempts: 0, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }
    await expect(store.createConfirmed(failure)).rejects.toThrow(/failureCode/)
  })

  it('rejects a failure code on a non-no-decision row', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed(record({ failureCode: 'seal-chain-invalid' }))).rejects.toThrow(/failureCode/)
  })

  it('reason-code read returns the recorded failure code for a post-facts row (WP5-c)', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    const { reviewRunId: _reviewRunId, ...base } = record()
    const failure: GateDecisionRecord = {
      ...base, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'unavailable',
      disposition: 'no-decision', failureStage: 'verified-dossier', failureCode: 'ledger-storage-unavailable',
      reviewAttempts: 0, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }
    await expect(store.createConfirmed(failure)).resolves.toBe('confirmed')
    await expect(store.readReasonCode('ask-1')).resolves.toBe('ledger-storage-unavailable')
  })

  it('reason-code read misses for a non-failure row or another request id (WP5-c)', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.readReasonCode('ask-1')).resolves.toBeUndefined()
    await expect(store.readReasonCode('ask-other')).resolves.toBeUndefined()
  })

  it('reason-code read resolves via a recorded best-effort row (WP5-c)', async () => {
    const store = new InMemoryGateDecisionRecordStore()
    const { reviewRunId: _reviewRunId, ...base } = record()
    const failure: GateDecisionRecord = {
      ...base, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'delegate',
      disposition: 'no-decision', failureStage: 'verified-dossier', failureCode: 'tail-budget-overflow',
      reviewAttempts: 0, contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    }
    await store.recordBestEffort(failure)
    await expect(store.readReasonCode('ask-1')).resolves.toBe('tail-budget-overflow')
  })
})
