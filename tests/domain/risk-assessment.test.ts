import { describe, expect, it } from 'vitest'
import { assessVerifiedActionV1, createActionSnapshot, permitsAutomaticFastPath } from '../../src/index.js'

describe('assessVerifiedActionV1', () => {
  it('records network payload risk without inferring user authorization', () => {
    const action = createActionSnapshot({ toolName: 'fetch', arguments: {}, projectorId: 'network-v1', semantics: { family: 'network-v1', value: { body: { kind: 'utf8' }, headers: [] } } })
    const assessment = assessVerifiedActionV1(action, [7])
    expect(assessment).toMatchObject({ risk: 'high', categories: ['data-exfiltration', 'network-exposure'], authorization: { level: 'unknown', targetCovered: false, sideEffectsCovered: false, sourceRefs: ['event:7'] } })
    expect(permitsAutomaticFastPath(assessment)).toBe(false)
  })

  it('marks destructive privilege expansion critical and remains non-authorizing', () => {
    const action = createActionSnapshot({ toolName: 'delete', arguments: {}, projectorId: 'filesystem-v1', semantics: { family: 'filesystem-v1', value: { operation: 'delete' } }, requestedPermissions: [{ kind: 'sandbox', scope: 'danger-full-access' }] })
    expect(assessVerifiedActionV1(action, []).categories).toEqual(['destructive-change', 'permission-expansion'])
    expect(assessVerifiedActionV1(action, []).risk).toBe('critical')
  })
})
