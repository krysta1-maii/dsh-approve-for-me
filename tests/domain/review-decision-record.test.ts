import { describe, expect, it } from 'vitest'
import { parseReviewDecisionRecord } from '../../src/index.js'
import type { ReviewDecisionRecordV1 } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function validRecord(): ReviewDecisionRecordV1 {
  return {
    version: 1,
    session: {
      sessionId: 'parent-1',
      sessionFormatVersion: 0,
      createdAt: 1_000,
    },
    approval: {
      askedEventSeq: 42,
      callId: 'call-1',
      toolName: 'bash',
    },
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
      policyArtifactFingerprint: hash('a'),
      decisionSchemaFingerprint: hash('b'),
      classificationCatalogFingerprint: hash('c'),
      toolsetVersion: 1,
      configurationFingerprint: hash('d'),
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
      durationMs: 123,
    }],
    recoveries: [],
    guardian: {
      kind: 'decision',
      decision: 'allow',
      risk: 'low',
      categories: ['read-only'],
      userAuthorization: 'explicit',
      decisionPayloadHash: hash('e'),
      rationaleBytes: 10,
    },
    pluginDisposition: 'allow',
    completedAt: 2_000,
  }
}

describe('parseReviewDecisionRecord', () => {
  it('parses and freezes a complete minimal record', () => {
    const record = parseReviewDecisionRecord(validRecord())
    expect(record.version).toBe(1)
    expect(record.review.reviewRunId).toBe('run-1')
    expect(record.attempts).toHaveLength(1)
    expect(record.attempts[0]!.outcome).toEqual({ kind: 'decision', decision: 'allow' })
    expect(Object.isFrozen(record.attempts)).toBe(true)
    expect(Object.isFrozen(record.recoveries)).toBe(true)
    expect(Object.isFrozen(record.guardian)).toBe(true)
  })

  it('preserves either canonical packet codec without retaining packet contents', () => {
    const record = parseReviewDecisionRecord({
      ...validRecord(),
      review: { ...validRecord().review, packetCodecId: 'approval-review-packet-v2' },
    })
    expect(record.review.packetCodecId).toBe('approval-review-packet-v2')
    expect('packet' in record.review).toBe(false)
  })

  it('rejects unsupported versions, unknown fields, and malformed enums', () => {
    expect(() => parseReviewDecisionRecord({ ...validRecord(), version: 2 })).toThrow(/version/)
    expect(() => parseReviewDecisionRecord({ ...validRecord(), extra: true })).toThrow(/not supported/)
    expect(() => parseReviewDecisionRecord({
      ...validRecord(),
      pluginDisposition: 'yes' as never,
    })).toThrow(/pluginDisposition/)
    expect(() => parseReviewDecisionRecord({
      ...validRecord(),
      guardian: { kind: 'no-decision', reason: 'nope' },
    })).toThrow(/guardian.reason/)
  })

  it('rejects malformed attempts, recoveries, and hashes', () => {
    expect(() => parseReviewDecisionRecord({
      ...validRecord(),
      attempts: [{ ...validRecord().attempts[0]!, outcome: { kind: 'oops' } }],
    })).toThrow(/attempts\[0\]/)
    expect(() => parseReviewDecisionRecord({
      ...validRecord(),
      recoveries: [{ ordinal: 0, kind: 'unknown' as never, reviewerSessionId: 'r', generation: 'g', occurredAt: 1 }],
    })).toThrow(/recoveries\[0\]/)
    expect(() => parseReviewDecisionRecord({
      ...validRecord(),
      review: { ...validRecord().review, actionHash: 'not-a-hash' },
    })).toThrow(/actionHash/)
  })
})
