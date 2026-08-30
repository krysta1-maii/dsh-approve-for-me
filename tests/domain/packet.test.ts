import { describe, expect, it } from 'vitest'
import {
  createActionSnapshot,
  createApprovalReviewPacketV1,
  createApprovalReviewPacketV2,
  assessVerifiedActionV1,
  createApprovalReviewRequest,
  hashApprovalReviewPacket,
  hashGuardianDossier,
  parseApprovalReviewPacketV1,
} from '../../src/index.js'

function request() {
  return createApprovalReviewRequest(createActionSnapshot({
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
}

const dossier = {
  version: 1,
  kind: 'guardian-dossier',
  freeze: { throughSeq: 10, parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 0 } },
  completeness: { ready: true },
}

describe('approval review packet codec', () => {
  it('creates a packet with a recomputable dossierHash and round-trips', () => {
    const packet = createApprovalReviewPacketV1({ request: request(), dossier })
    expect(packet.kind).toBe('approval-review-packet')
    expect(packet.dossierHash).toBe(hashGuardianDossier(dossier))
    expect(parseApprovalReviewPacketV1(packet)).toEqual(packet)
    expect(hashApprovalReviewPacket(packet)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('binds an R4 baseline and policy identity in the v2 packet', () => {
    const reviewRequest = request()
    const packet = createApprovalReviewPacketV2({
      request: reviewRequest,
      dossier,
      policy: { version: 'policy-v2', configurationFingerprint: `sha256:${'b'.repeat(64)}` },
      baseline: assessVerifiedActionV1(reviewRequest.action, [7]),
    })
    expect(packet).toMatchObject({ version: 2, policy: { version: 'policy-v2' }, baseline: { authorization: { sourceRefs: ['event:7'] } } })
    expect(Object.isFrozen(packet.policy)).toBe(true)
  })

  it('accepts an explicit matching dossierHash and rejects a tampered hash', () => {
    const explicit = createApprovalReviewPacketV1({
      request: request(),
      dossier,
      dossierHash: hashGuardianDossier(dossier),
    })
    expect(explicit.dossierHash).toBe(hashGuardianDossier(dossier))
    expect(() => parseApprovalReviewPacketV1({
      ...explicit,
      dossierHash: `sha256:${'0'.repeat(64)}`,
    })).toThrow(/does not match/)

    expect(() => createApprovalReviewPacketV1({
      request: request(),
      dossier,
      dossierHash: `sha256:${'0'.repeat(64)}`,
    })).toThrow(/does not match/)
  })

  it('rejects invalid envelope discriminators', () => {
    expect(() => parseApprovalReviewPacketV1({ ...createApprovalReviewPacketV1({ request: request(), dossier }), version: 2 }))
      .toThrow(/version/)
    expect(() => parseApprovalReviewPacketV1({ ...createApprovalReviewPacketV1({ request: request(), dossier }), kind: 'other' }))
      .toThrow(/kind/)
  })
})
