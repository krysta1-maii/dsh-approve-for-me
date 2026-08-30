import { describe, expect, it } from 'vitest'
import { assessVerifiedActionV1, createActionSnapshot, permitsAutomaticFastPath, RISK_RULES_V1 } from '../../src/index.js'

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
