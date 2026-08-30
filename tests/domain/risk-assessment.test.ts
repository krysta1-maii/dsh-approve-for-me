import { describe, expect, it } from 'vitest'
import { assessVerifiedActionV1, createActionSnapshot, permitsAutomaticFastPath, RISK_RULES_V1, validateDecisionAssessmentV1 } from '../../src/index.js'
import type { ApprovalDecision } from '../../src/index.js'

function decision(overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return { protocolVersion: 1, reviewId: 'review-1', parentSessionId: 'parent-1', reviewerSessionId: 'reviewer-1', generation: 'generation-1', actionHash: `sha256:${'a'.repeat(64)}`, decision: 'allow', risk: 'low', categories: [], userAuthorization: 'explicit', rationale: 'test', ...overrides }
}

describe('assessVerifiedActionV1', () => {
  it('publishes a complete non-authorizing rule matrix', () => {
    expect(RISK_RULES_V1).toHaveLength(9)
    expect(new Set(RISK_RULES_V1.map(rule => rule.category)).size).toBe(9)
    for (const rule of RISK_RULES_V1) {
      expect(rule.structuralTrigger).not.toHaveLength(0)
      expect(rule.counterevidence).not.toHaveLength(0)
      expect(rule.authorizationRequirement).not.toHaveLength(0)
      expect(rule.manualConfirmation).not.toHaveLength(0)
      expect(rule.absoluteDenial).not.toHaveLength(0)
    }
  })

  it('records network payload risk without inferring user authorization', () => {
    const action = createActionSnapshot({ toolName: 'fetch', arguments: {}, projectorId: 'network-v1', semantics: { family: 'network-v1', value: { body: { kind: 'utf8' }, headers: [] } } })
    const assessment = assessVerifiedActionV1(action, [7])
    expect(assessment).toMatchObject({ risk: 'high', categories: ['data-exfiltration', 'network-exposure'], authorization: { level: 'unknown', targetCovered: false, sideEffectsCovered: false, sourceRefs: ['event:7'] } })
    expect(assessment.evidence).toEqual([
      expect.objectContaining({ category: 'data-exfiltration', sourceRefs: ['action-snapshot'] }),
      expect.objectContaining({ category: 'network-exposure', sourceRefs: ['action-snapshot'] }),
    ])
    expect(Object.isFrozen(assessment.evidence)).toBe(true)
    expect(permitsAutomaticFastPath(assessment)).toBe(false)
  })

  it('rejects a model allow that lowers or omits source risk', () => {
    const action = createActionSnapshot({ toolName: 'fetch', arguments: {}, projectorId: 'network-v1', semantics: { family: 'network-v1', value: { body: { kind: 'utf8' }, headers: [] } } })
    const assessment = assessVerifiedActionV1(action, [7])
    expect(validateDecisionAssessmentV1(decision(), assessment)).toMatchObject({ kind: 'under-evidenced', reason: 'decision lowers source-derived risk' })
    expect(validateDecisionAssessmentV1(decision({ risk: 'high', categories: ['data-exfiltration', 'network-exposure'] }), assessment)).toMatchObject({ kind: 'under-evidenced', reason: 'explicit authorization does not cover target and side effects' })
    expect(validateDecisionAssessmentV1(decision({ decision: 'human_review', risk: 'high', categories: ['data-exfiltration', 'network-exposure'] }), assessment)).toEqual({ kind: 'valid' })
  })

  it('rejects cited authorization claims that exceed source-derived evidence', () => {
    const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' }, projectorId: 'shell-v1', semantics: { family: 'shell-process-v1', value: { command: 'pwd' } } })
    const assessment = assessVerifiedActionV1(action, [7])
    expect(validateDecisionAssessmentV1(decision({ assessment: { version: 1, targetCovered: false, sideEffectsCovered: false, sourceRefs: ['event:8'], rationale: 'wrong source' } }), assessment))
      .toMatchObject({ kind: 'under-evidenced', reason: 'decision cites a source outside the source-derived authorization evidence' })
    expect(validateDecisionAssessmentV1(decision({ assessment: { version: 1, targetCovered: true, sideEffectsCovered: false, sourceRefs: ['event:7'], rationale: 'overclaims target' } }), assessment))
      .toMatchObject({ kind: 'under-evidenced', reason: 'decision claims target coverage beyond source-derived authorization evidence' })
  })

  it('keeps a benign complete shell snapshot low risk without inventing authorization', () => {
    const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' }, projectorId: 'shell-v1', semantics: { family: 'shell-process-v1', value: { command: 'pwd' } } })
    const assessment = assessVerifiedActionV1(action, [9, 3])
    expect(assessment).toMatchObject({ risk: 'low', categories: [], evidence: [], authorization: { level: 'unknown', sourceRefs: ['event:3', 'event:9'] } })
    expect(permitsAutomaticFastPath(assessment)).toBe(false)
  })

  it('treats an unrecognized semantic family as insufficient evidence, not benign behavior', () => {
    const action = createActionSnapshot({ toolName: 'opaque', arguments: {}, projectorId: 'opaque-v1', semantics: { family: 'opaque-v1', value: {} } })
    const assessment = assessVerifiedActionV1(action, [])
    expect(assessment).toMatchObject({ risk: 'unknown', categories: ['unknown-semantics'], evidence: [expect.objectContaining({ trigger: 'unrecognized semantic family opaque-v1' })] })
    expect(permitsAutomaticFastPath(assessment)).toBe(false)
  })

  it('marks destructive privilege expansion critical and remains non-authorizing', () => {
    const action = createActionSnapshot({ toolName: 'delete', arguments: {}, projectorId: 'filesystem-v1', semantics: { family: 'filesystem-v1', value: { operation: 'delete' } }, requestedPermissions: [{ kind: 'sandbox', scope: 'danger-full-access' }] })
    expect(assessVerifiedActionV1(action, []).categories).toEqual(['destructive-change', 'permission-expansion'])
    expect(assessVerifiedActionV1(action, []).risk).toBe('critical')
  })
})
