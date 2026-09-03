import { describe, expect, it } from 'vitest'
import {
  artifactBytes,
  caseArtifactKey,
  hashApprovalDecisionPayload,
  hashApprovalReviewPacket,
  hashDecisionToolSchema,
  hashGuardianPolicyArtifact,
  reviewRecordKey,
  validateCaseCaptureConfig,
} from '../../src/index.js'

const session = {
  sessionId: 'parent-1',
  sessionFormatVersion: 0,
  createdAt: 1_000,
}

describe('record/artifact key encoding', () => {
  it('produces stable r1_/c1_ keys from canonical session+identity', () => {
    const record = reviewRecordKey(session, 'run-1')
    const artifact = caseArtifactKey(session, 'artifact-1')
    expect(record.startsWith('r1_')).toBe(true)
    expect(artifact.startsWith('c1_')).toBe(true)
    expect(record).toBe(reviewRecordKey(session, 'run-1'))
    expect(artifact).toBe(caseArtifactKey(session, 'artifact-1'))
    expect(record).not.toBe(caseArtifactKey(session, 'run-1'))
  })

  it('bounds key length for unbounded provider callIds and cwd paths', () => {
    const huge = {
      sessionId: `session-${'s'.repeat(300)}`,
      sessionFormatVersion: 0,
      createdAt: 1_000,
      cwd: `/workspace/${'deep/'.repeat(120)}`,
    }
    const record = reviewRecordKey(huge, `run-${'r'.repeat(300)}`)
    const artifact = caseArtifactKey(huge, `artifact-${'a'.repeat(300)}`)
    // prefix (3) + sha256 hex (64): always below the 255-byte file-name bound.
    expect(record).toMatch(/^r1_[0-9a-f]{64}$/)
    expect(artifact).toMatch(/^c1_[0-9a-f]{64}$/)
    expect(record.length).toBe(67)
    expect(artifact.length).toBe(67)
  })
})

describe('H4 hash helpers', () => {
  it('uses the versioned domain separators and canonical JSON', () => {
    const packet = { version: 1, kind: 'packet', value: { b: 2, a: 1 } }
    const reordered = { version: 1, kind: 'packet', value: { a: 1, b: 2 } }
    expect(hashApprovalReviewPacket(packet)).toBe(hashApprovalReviewPacket(reordered))
    expect(hashApprovalReviewPacket(packet)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(hashApprovalDecisionPayload({ decision: 'allow' })).not.toBe(hashApprovalReviewPacket(packet))
    expect(hashDecisionToolSchema({ type: 'object' })).toMatch(/^sha256:/)
    expect(hashGuardianPolicyArtifact({ version: 1 })).toMatch(/^sha256:/)
  })
})

describe('case capture config validation', () => {
  it('accepts a valid config and rejects unsafe values', () => {
    expect(() => validateCaseCaptureConfig({
      mode: 'off',
      maxCases: 10,
      maxArtifactBytes: 100,
      maxTotalBytes: 1_000,
      retentionDays: 30,
    })).not.toThrow()
    expect(() => validateCaseCaptureConfig({
      mode: 'full',
      maxCases: 0,
      maxArtifactBytes: 100,
      maxTotalBytes: 1_000,
      retentionDays: 30,
    })).toThrow(/positive safe integer/)
    expect(() => validateCaseCaptureConfig({
      mode: 'full',
      maxCases: 10,
      maxArtifactBytes: 2_000,
      maxTotalBytes: 1_000,
      retentionDays: 30,
    })).toThrow(/must be <= maxTotalBytes/)
  })

  it('computes billed bytes from key plus canonical artifact JSON', () => {
    const key = caseArtifactKey(session, 'a')
    const bytes = artifactBytes(key, { version: 1, value: 'x' })
    expect(bytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThan(bytes)
  })
})
