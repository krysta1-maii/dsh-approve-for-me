import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryDecisionRecordStorageBackend,
  ReviewDecisionRecordStore,
  reviewRecordKey,
} from '../../src/index.js'
import type { ReviewDecisionRecordV1, StorageWriteResult } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function record(): ReviewDecisionRecordV1 {
  return {
    version: 1,
    session: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 },
    approval: { askedEventSeq: 5, callId: 'call-1', toolName: 'bash' },
    review: {
      reviewRunId: 'run-1',
      actionHash: hash('a'),
      dossierHash: hash('b'),
      dossierVersion: 1,
      approvalProtocolVersion: 1,
      decisionSchemaVersion: 1,
      packetCodecId: 'approval-review-packet-v1',
      hashSuiteId: 'dsh-approve-for-me-hash-v1',
      sourceProjectionPolicyId: 'dsh-session-facts-v1',
      argumentSemanticsId: 'default-v1',
      actionProjectorId: 'default-v1',
      policyVersion: 'policy-v1',
      policyArtifactFingerprint: hash('c'),
      decisionSchemaFingerprint: hash('d'),
      classificationCatalogFingerprint: hash('e'),
      toolsetVersion: 1,
      configurationFingerprint: hash('f'),
      generation: 'generation-1',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    },
    attempts: [{
      ordinal: 1,
      reviewId: 'review-1',
      reviewerSessionId: 'reviewer-1',
      generation: 'generation-1',
      outcome: { kind: 'decision', decision: 'allow' },
      durationMs: 10,
    }],
    recoveries: [],
    guardian: {
      kind: 'decision',
      decision: 'allow',
      risk: 'low',
      categories: [],
      userAuthorization: 'explicit',
      decisionPayloadHash: hash('1'),
      rationaleBytes: 4,
    },
    pluginDisposition: 'allow',
    completedAt: 2_000,
  }
}

describe('InMemoryDecisionRecordStorageBackend', () => {
  it('implements create-once identical/conflict semantics', async () => {
    const backend = new InMemoryDecisionRecordStorageBackend()
    const key = reviewRecordKey(record().session, record().review.reviewRunId)
    await expect(backend.putIfAbsent(key, record(), 'x')).resolves.toBe('stored')
    await expect(backend.putIfAbsent(key, record(), 'x')).resolves.toBe('identical')
    await expect(backend.putIfAbsent(key, record(), 'y')).resolves.toBe('conflict')
    await expect(backend.read(key)).resolves.toEqual(record())
  })
})

describe('ReviewDecisionRecordStore', () => {
  it('maps stored/identical to confirmed and conflict to conflict', async () => {
    const backend = new InMemoryDecisionRecordStorageBackend()
    const store = new ReviewDecisionRecordStore(backend)
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed(record())).resolves.toBe('confirmed')
    await expect(store.createConfirmed({
      ...record(),
      pluginDisposition: 'deny',
    })).resolves.toBe('conflict')
  })

  it('rejects malformed records before the durable backend sees them', async () => {
    const backend = new InMemoryDecisionRecordStorageBackend()
    const store = new ReviewDecisionRecordStore(backend)
    await expect(store.createConfirmed({
      ...record(),
      review: { ...record().review, packetCodecId: 'not-a-codec' as never },
    })).rejects.toThrow(/packetCodecId/)
    await expect(backend.read(reviewRecordKey(record().session, record().review.reviewRunId))).resolves.toBeUndefined()
  })

  it('surfaces backend unavailable without overwriting', async () => {
    const backend = new InMemoryDecisionRecordStorageBackend()
    backend.putIfAbsent = vi.fn(async (): Promise<StorageWriteResult> => 'unavailable')
    const store = new ReviewDecisionRecordStore(backend)
    await expect(store.createConfirmed(record())).resolves.toBe('unavailable')
    await expect(backend.drain()).resolves.toBeUndefined()
  })
})
