import type { ActionSnapshot, ApprovalRisk } from './protocol.js'

/** Evidence-bound R4 baseline; it never interprets free-form model claims. */
export type RiskCategoryV1 = 'data-exfiltration' | 'destructive-change' | 'privilege-expansion' | 'external-side-effect' | 'unknown-semantics'
export interface AuthorizationAssessmentV1 {
  readonly level: 'explicit' | 'implicit' | 'absent' | 'conflicting' | 'unknown'
  readonly targetCovered: boolean
  readonly sideEffectsCovered: boolean
  readonly sourceRefs: readonly string[]
  readonly rationale: string
}
export interface RiskAssessmentV1 {
  readonly version: 1
  readonly risk: ApprovalRisk
  readonly categories: readonly RiskCategoryV1[]
  readonly authorization: AuthorizationAssessmentV1
}

/**
 * Conservative baseline from a source-verified action. Direct-user event refs
 * establish provenance only; without a target/side-effect interpreter R4 may
 * not promote them to authorization.
 */
export function assessVerifiedActionV1(action: ActionSnapshot, directUserEventSeqs: readonly number[]): RiskAssessmentV1 {
  const categories = new Set<RiskCategoryV1>()
  let risk: ApprovalRisk = 'low'
  const value = action.semantics.value !== null && typeof action.semantics.value === 'object' && !Array.isArray(action.semantics.value)
    ? action.semantics.value as Record<string, unknown> : undefined
  if (value === undefined) { categories.add('unknown-semantics'); risk = 'unknown' }
  else if (action.semantics.family === 'network-v1') {
    categories.add('external-side-effect'); risk = 'medium'
    const body = value.body as Record<string, unknown> | undefined
    if (body?.kind === 'utf8' || (Array.isArray(value.headers) && value.headers.length > 0)) { categories.add('data-exfiltration'); risk = 'high' }
  } else if (action.semantics.family === 'filesystem-v1' && ['delete', 'write', 'edit', 'move'].includes(String(value.operation))) {
    categories.add('destructive-change'); risk = value.operation === 'delete' ? 'high' : 'medium'
  } else if (!['shell-process-v1', 'filesystem-v1'].includes(action.semantics.family)) { categories.add('unknown-semantics'); risk = 'unknown' }
  if (action.requestedPermissions.some(permission => permission.kind === 'sandbox' && permission.scope === 'danger-full-access')) { categories.add('privilege-expansion'); risk = 'critical' }
  return Object.freeze({ version: 1, risk, categories: Object.freeze([...categories].sort()), authorization: Object.freeze({ level: 'unknown', targetCovered: false, sideEffectsCovered: false, sourceRefs: Object.freeze([...directUserEventSeqs].sort((a, b) => a - b).map(seq => `event:${seq}`)), rationale: 'R4 baseline does not infer target or side-effect authorization from message text.' }) })
}

export function permitsAutomaticFastPath(assessment: RiskAssessmentV1): boolean {
  return assessment.risk !== 'critical' && assessment.risk !== 'unknown'
    && assessment.authorization.level !== 'absent' && assessment.authorization.level !== 'conflicting' && assessment.authorization.level !== 'unknown'
    && assessment.authorization.targetCovered && assessment.authorization.sideEffectsCovered
}
