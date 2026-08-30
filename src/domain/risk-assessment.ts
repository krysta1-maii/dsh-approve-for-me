import type { ActionSnapshot, ApprovalDecision, ApprovalRisk } from './protocol.js'

/** Evidence-bound R4 baseline; it never interprets free-form model claims. */
export type RiskCategoryV1 =
  | 'data-exfiltration'
  | 'credential-access'
  | 'destructive-change'
  | 'persistent-security-weakening'
  | 'permission-expansion'
  | 'network-exposure'
  | 'supply-chain-or-unverified-execution'
  | 'approval-evasion'
  | 'unknown-semantics'
export interface AuthorizationAssessmentV1 {
  readonly level: 'explicit' | 'implicit' | 'absent' | 'conflicting' | 'unknown'
  readonly targetCovered: boolean
  readonly sideEffectsCovered: boolean
  readonly sourceRefs: readonly string[]
  readonly rationale: string
}
export interface RiskRuleV1 {
  readonly category: RiskCategoryV1
  readonly structuralTrigger: string
  readonly counterevidence: string
  readonly scope: 'action' | 'target' | 'environment'
  readonly authorizationRequirement: string
  readonly manualConfirmation: string
  readonly absoluteDenial: string
}

/** Stable R4 rule matrix. Rules with no proved structural adapter stay unasserted. */
export const RISK_RULES_V1: readonly RiskRuleV1[] = Object.freeze([
  { category: 'data-exfiltration', structuralTrigger: 'network payload or headers', counterevidence: 'verified absence of outbound payload and headers', scope: 'action', authorizationRequirement: 'explicit target and data authorization', manualConfirmation: 'required unless future verified scope matcher proves coverage', absoluteDenial: 'never automatically allow when destination or payload is unknown' },
  { category: 'credential-access', structuralTrigger: 'future credential-specific semantic projector', counterevidence: 'verified semantic absence', scope: 'target', authorizationRequirement: 'explicit credential scope', manualConfirmation: 'required', absoluteDenial: 'unverified credential target' },
  { category: 'destructive-change', structuralTrigger: 'filesystem destructive operation', counterevidence: 'verified non-mutating operation', scope: 'target', authorizationRequirement: 'explicit target and effect authorization', manualConfirmation: 'required until target coverage is verified', absoluteDenial: 'unknown target or irreversible effect' },
  { category: 'persistent-security-weakening', structuralTrigger: 'future security-configuration semantic projector', counterevidence: 'verified unchanged security configuration', scope: 'environment', authorizationRequirement: 'explicit security-boundary authorization', manualConfirmation: 'required', absoluteDenial: 'unverified persistent weakening' },
  { category: 'permission-expansion', structuralTrigger: 'danger-full-access sandbox request', counterevidence: 'verified confined permission request', scope: 'environment', authorizationRequirement: 'explicit expanded-permission authorization', manualConfirmation: 'required', absoluteDenial: 'unbounded sandbox expansion' },
  { category: 'network-exposure', structuralTrigger: 'network semantic family', counterevidence: 'verified absence of network target', scope: 'target', authorizationRequirement: 'explicit network target authorization', manualConfirmation: 'required until target coverage is verified', absoluteDenial: 'unknown network destination or redirect' },
  { category: 'supply-chain-or-unverified-execution', structuralTrigger: 'future provenance-specific semantic projector', counterevidence: 'verified pinned and trusted provenance', scope: 'action', authorizationRequirement: 'explicit unverified-execution authorization', manualConfirmation: 'required', absoluteDenial: 'unknown executable provenance' },
  { category: 'approval-evasion', structuralTrigger: 'future verified conflict with existing approval fact', counterevidence: 'verified non-conflict', scope: 'action', authorizationRequirement: 'none; conflict is not authorization', manualConfirmation: 'required', absoluteDenial: 'attempt to replay or bypass a rejection' },
  { category: 'unknown-semantics', structuralTrigger: 'unrecognized or non-object semantic projection', counterevidence: 'complete registered semantic projection', scope: 'action', authorizationRequirement: 'not assessable', manualConfirmation: 'required', absoluteDenial: 'automatic allow forbidden' },
])

export interface RiskEvidenceV1 {
  readonly category: RiskCategoryV1
  /** `action-snapshot` or retained direct-user event refs; never model text. */
  readonly sourceRefs: readonly string[]
  readonly scope: 'action' | 'target' | 'environment'
  readonly trigger: string
  readonly counterevidence?: string
}
export interface RiskAssessmentV1 {
  readonly version: 1
  readonly risk: ApprovalRisk
  readonly categories: readonly RiskCategoryV1[]
  readonly evidence: readonly RiskEvidenceV1[]
  readonly authorization: AuthorizationAssessmentV1
}

/**
 * Conservative baseline from a source-verified action. Direct-user event refs
 * establish provenance only; without a target/side-effect interpreter R4 may
 * not promote them to authorization.
 */
export function assessVerifiedActionV1(action: ActionSnapshot, directUserEventSeqs: readonly number[]): RiskAssessmentV1 {
  const categories = new Set<RiskCategoryV1>()
  const evidence: RiskEvidenceV1[] = []
  const add = (category: RiskCategoryV1, scope: RiskEvidenceV1['scope'], trigger: string): void => {
    categories.add(category)
    evidence.push(Object.freeze({ category, sourceRefs: Object.freeze(['action-snapshot']), scope, trigger }))
  }
  let risk: ApprovalRisk = 'low'
  const value = action.semantics.value !== null && typeof action.semantics.value === 'object' && !Array.isArray(action.semantics.value)
    ? action.semantics.value as Record<string, unknown> : undefined
  if (value === undefined) { add('unknown-semantics', 'action', 'semantic value is not an object'); risk = 'unknown' }
  else if (action.semantics.family === 'network-v1') {
    add('network-exposure', 'target', 'network semantic family'); risk = 'medium'
    const body = value.body as Record<string, unknown> | undefined
    if (body?.kind === 'utf8' || (Array.isArray(value.headers) && value.headers.length > 0)) { add('data-exfiltration', 'action', 'network payload or headers are present'); risk = 'high' }
  } else if (action.semantics.family === 'filesystem-v1' && ['delete', 'write', 'edit', 'move'].includes(String(value.operation))) {
    add('destructive-change', 'target', `filesystem ${String(value.operation)} operation`); risk = value.operation === 'delete' ? 'high' : 'medium'
  } else if (!['shell-process-v1', 'filesystem-v1'].includes(action.semantics.family)) { add('unknown-semantics', 'action', `unrecognized semantic family ${action.semantics.family}`); risk = 'unknown' }
  if (action.requestedPermissions.some(permission => permission.kind === 'sandbox' && permission.scope === 'danger-full-access')) { add('permission-expansion', 'environment', 'danger-full-access sandbox permission requested'); risk = 'critical' }
  return Object.freeze({ version: 1, risk, categories: Object.freeze([...categories].sort()), evidence: Object.freeze(evidence.sort((a, b) => a.category.localeCompare(b.category))), authorization: Object.freeze({ level: 'unknown', targetCovered: false, sideEffectsCovered: false, sourceRefs: Object.freeze([...directUserEventSeqs].sort((a, b) => a - b).map(seq => `event:${seq}`)), rationale: 'R4 baseline does not infer target or side-effect authorization from message text.' }) })
}

export type DecisionAssessmentValidityV1 =
  | { readonly kind: 'valid' }
  | { readonly kind: 'under-evidenced'; readonly reason: string }
  | { readonly kind: 'prohibited'; readonly reason: string }

/**
 * R5's DSH-neutral evidence floor. It does not trust a model's labels to lower
 * source-derived risk, omit asserted categories, or invent authorization.
 */
export function validateDecisionAssessmentV1(decision: ApprovalDecision, assessment: RiskAssessmentV1): DecisionAssessmentValidityV1 {
  const ranks: Record<ApprovalRisk, number> = { low: 0, medium: 1, high: 2, critical: 3, unknown: 4 }
  if (ranks[decision.risk] < ranks[assessment.risk]) return { kind: 'under-evidenced', reason: 'decision lowers source-derived risk' }
  if (assessment.categories.some(category => !decision.categories.includes(category))) return { kind: 'under-evidenced', reason: 'decision omits source-derived risk category' }
  if (assessment.categories.includes('approval-evasion')) return { kind: 'prohibited', reason: 'approval-evasion is an absolute denial condition' }
  if (decision.decision !== 'allow') return { kind: 'valid' }
  if (assessment.risk === 'critical' || assessment.risk === 'unknown') return { kind: 'prohibited', reason: 'critical or unknown risk cannot be automatically allowed' }
  if (assessment.authorization.level !== 'explicit' || decision.userAuthorization !== 'explicit'
    || !assessment.authorization.targetCovered || !assessment.authorization.sideEffectsCovered) {
    return { kind: 'under-evidenced', reason: 'explicit authorization does not cover target and side effects' }
  }
  return { kind: 'valid' }
}

export function permitsAutomaticFastPath(assessment: RiskAssessmentV1): boolean {
  return assessment.risk !== 'critical' && assessment.risk !== 'unknown'
    && assessment.authorization.level !== 'absent' && assessment.authorization.level !== 'conflicting' && assessment.authorization.level !== 'unknown'
    && assessment.authorization.targetCovered && assessment.authorization.sideEffectsCovered
}
