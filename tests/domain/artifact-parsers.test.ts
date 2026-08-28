import { describe, expect, it } from 'vitest'
import {
  createActionSnapshot,
  createApprovalReviewPacketV1,
  createApprovalReviewRequest,
  hashApprovalReviewPacket,
  parseGuardianCaseArtifactV1,
  parseGuardianPolicyArtifactV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function packet() {
  const request = createApprovalReviewRequest(createActionSnapshot({
    toolName: 'bash',
    arguments: { command: 'pwd' },
  }), {
    reviewId: 'review-1',
    parentSessionId: 'parent-1',
    reviewerSessionId: 'reviewer-1',
    generation: 'generation-1',
    callId: 'call-1',
    issuedAt: 100,
    deadlineAt: 200,
  })
  return createApprovalReviewPacketV1({
    request,
    dossier: {
      version: 1,
      kind: 'guardian-dossier',
      freeze: { throughSeq: 10 },
      completeness: { ready: true },
    },
  })
}

function policy() {
  return {
    version: 1 as const,
    policyVersion: 'policy-v1',
    policyArtifactFingerprint: hash('a'),
    systemPrompt: 'system',
    decisionToolName: 'submit_decision',
    decisionToolSchema: { type: 'object' },
    decisionSchemaFingerprint: hash('b'),
    toolsetVersion: 1 as const,
  }
}

function approvalDecision() {
  return {
    protocolVersion: 1,
    reviewId: 'review-1',
    parentSessionId: 'parent-1',
    reviewerSessionId: 'reviewer-1',
    generation: 'generation-1',
    actionHash: hash('c'),
    decision: 'allow',
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'ok',
  }
}

function caseArtifact() {
  const p = packet()
  return {
    version: 1 as const,
    artifactId: 'artifact-1',
    session: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 },
    approval: { askedEventSeq: 5, callId: 'call-1', toolName: 'bash' },
    reviewRunId: 'run-1',
    configurationFingerprint: hash('d'),
    reviewerPolicy: policy(),
    attempts: [{
      ordinal: 1,
      reviewId: 'review-1',
      reviewerSessionId: 'reviewer-1',
      packetHash: hashApprovalReviewPacket(p),
      packet: p,
      generation: 'generation-1',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      startedAt: 100,
      completedAt: 200,
      observation: { kind: 'decision-tool', payload: approvalDecision() },
    }],
    recoveries: [],
    pluginDisposition: 'allow' as const,
    capturedAt: 300,
    expiresAt: 400,
  }
}

describe('Guardian policy and case artifact parsers', () => {
  it('parses and freezes a policy artifact', () => {
    const parsed = parseGuardianPolicyArtifactV1(policy())
    expect(parsed.policyVersion).toBe('policy-v1')
    expect(parsed.toolsetVersion).toBe(1)
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it('rejects malformed policy fingerprints', () => {
    expect(() => parseGuardianPolicyArtifactV1({
      ...policy(),
      policyArtifactFingerprint: 'not-a-hash',
    })).toThrow(/policyArtifactFingerprint/)
  })

  it('parses and freezes a full case artifact with packet hash verification', () => {
    const parsed = parseGuardianCaseArtifactV1(caseArtifact())
    expect(parsed.attempts).toHaveLength(1)
    expect(parsed.attempts[0]!.observation).toMatchObject({ kind: 'decision-tool' })
    expect(parsed.attempts[0]!.packet).toBe(parsed.attempts[0]!.packet)
    expect(Object.isFrozen(parsed.attempts)).toBe(true)
    expect(parsed.expiresAt).toBeGreaterThanOrEqual(parsed.capturedAt)
  })

  it('rejects packet hash mismatch, bad expiry, and malformed observations', () => {
    const badHash = { ...caseArtifact(), attempts: [{ ...caseArtifact().attempts[0]!, packetHash: hash('f') }] }
    expect(() => parseGuardianCaseArtifactV1(badHash)).toThrow(/packetHash/)

    const badExpiry = { ...caseArtifact(), expiresAt: 100, capturedAt: 200 }
    expect(() => parseGuardianCaseArtifactV1(badExpiry)).toThrow(/expiresAt/)

    const badObservation = {
      ...caseArtifact(),
      attempts: [{ ...caseArtifact().attempts[0]!, observation: { kind: 'oops' } }],
    }
    expect(() => parseGuardianCaseArtifactV1(badObservation)).toThrow(/observation/)
  })

  it('does not reject a payload parsed from a real ApprovalDecision', () => {
    const parsed = parseGuardianCaseArtifactV1(caseArtifact())
    expect(parsed.attempts[0]!.observation).toMatchObject({
      kind: 'decision-tool',
      payload: { decision: 'allow' },
    })
  })
})
