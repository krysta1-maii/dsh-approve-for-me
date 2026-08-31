import type { ActionSnapshot, ApprovalDecision, ApprovalRisk } from './protocol.js'
import type { EarlierSandboxDenialV1 } from './dossier.js'
import { canonicalJson, parseUniqueJson } from './json.js'

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
  /** Candidate refs available only for a fresh Guardian correlation. */
  readonly sandboxDenialCandidateRefs?: readonly string[]
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

export interface DirectUserAuthorizationEvidenceV1 {
  readonly seq: number
  readonly content: readonly unknown[]
  readonly surfaceState?: 'visible' | 'superseded'
}

type AuthorizationInputV1 = number | DirectUserAuthorizationEvidenceV1

type AuthorizationDirectiveV1 =
  | {
      readonly kind: 'allow'
      readonly toolName: string
      readonly arguments: unknown
      readonly requestedPermissions: readonly unknown[]
    }
  | { readonly kind: 'deny' }

interface AuthorizationSourceV1 {
  readonly seq: number
  readonly directive?: AuthorizationDirectiveV1
}

const AUTHORIZATION_COMMAND = '/approve-for-me '

/**
 * Parse only one standalone, exact command. Natural prose, markdown fences,
 * quoted examples, XML-looking text, and mixed-content messages are inert.
 */
function directiveFromContent(content: readonly unknown[]): AuthorizationDirectiveV1 | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return undefined
  const value = block as Record<string, unknown>
  if (Object.keys(value).some(key => !['type', 'text'].includes(key))
    || value.type !== 'text' || typeof value.text !== 'string' || value.text.length > 131_072) return undefined
  const text = value.text.trim()
  if (!text.startsWith(AUTHORIZATION_COMMAND) || text.slice(AUTHORIZATION_COMMAND.length).trim().length === 0) return undefined
  try {
    const parsed = parseUniqueJson(text.slice(AUTHORIZATION_COMMAND.length))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const directive = parsed as Record<string, unknown>
    if (directive.version !== 1 || directive.scope !== 'next-action'
      || Object.keys(directive).some(key => !['version', 'scope', 'allow', 'deny'].includes(key))) return undefined
    if (directive.deny === true && directive.allow === undefined) return Object.freeze({ kind: 'deny' })
    if (directive.deny !== undefined || directive.allow === null || typeof directive.allow !== 'object' || Array.isArray(directive.allow)) return undefined
    const allow = directive.allow as Record<string, unknown>
    if (Object.keys(allow).some(key => !['toolName', 'arguments', 'requestedPermissions'].includes(key))
      || typeof allow.toolName !== 'string' || allow.toolName.length === 0 || allow.toolName.length > 256
      || allow.arguments === undefined || !Array.isArray(allow.requestedPermissions)) return undefined
    // Canonicalization proves both fields are bounded JSON values before they
    // can be compared with the source-verified action snapshot.
    if (canonicalJson(allow.arguments as never).length > 262_144
      || canonicalJson(allow.requestedPermissions as never).length > 65_536) return undefined
    return Object.freeze({
      kind: 'allow',
      toolName: allow.toolName,
      arguments: allow.arguments,
      requestedPermissions: Object.freeze([...allow.requestedPermissions]),
    })
  } catch {
    return undefined
  }
}

function authorizationSources(inputs: readonly AuthorizationInputV1[]): readonly AuthorizationSourceV1[] | undefined {
  if (inputs.every(input => typeof input === 'number')) return undefined
  const sources: AuthorizationSourceV1[] = []
  for (const input of inputs) {
    if (typeof input === 'number' || !Number.isSafeInteger(input.seq) || input.seq < 0 || !Array.isArray(input.content)
      || (input.surfaceState !== undefined && input.surfaceState !== 'visible')) continue
    const directive = directiveFromContent(input.content)
    sources.push(Object.freeze({ seq: input.seq, ...(directive === undefined ? {} : { directive }) }))
  }
  return Object.freeze(sources.sort((left, right) => left.seq - right.seq))
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function directiveCoversAction(directive: AuthorizationDirectiveV1, action: ActionSnapshot): boolean {
  if (directive.kind !== 'allow' || directive.toolName !== action.toolName) return false
  try {
    return canonicalJson(directive.arguments as never) === canonicalJson(action.arguments)
      && canonicalJson(directive.requestedPermissions as never) === canonicalJson(action.requestedPermissions)
  } catch {
    return false
  }
}

function assessAuthorization(
  action: ActionSnapshot,
  inputs: readonly AuthorizationInputV1[],
): AuthorizationAssessmentV1 {
  const legacyRefs = Object.freeze(inputs.flatMap(input => {
    const seq = typeof input === 'number' ? input : input.seq
    return Number.isSafeInteger(seq) && seq >= 0 ? [`event:${seq}`] : []
  }).sort())
  const sources = authorizationSources(inputs)
  if (sources === undefined) {
    return Object.freeze({
      level: 'unknown', targetCovered: false, sideEffectsCovered: false, sourceRefs: legacyRefs,
      rationale: 'Direct-user event references contain no retained message content to match against the action.',
    })
  }
  const latest = sources.at(-1)
  if (latest === undefined) {
    return Object.freeze({
      level: 'absent', targetCovered: false, sideEffectsCovered: false, sourceRefs: Object.freeze([]),
      rationale: 'No retained visible direct-user message is available.',
    })
  }
  const sourceRefs = Object.freeze([`event:${latest.seq}`])
  if (latest.directive?.kind === 'deny') {
    return Object.freeze({
      level: 'conflicting', targetCovered: false, sideEffectsCovered: false, sourceRefs,
      rationale: 'The latest direct-user next-action directive denies authorization.',
    })
  }
  if (latest.directive === undefined) {
    return Object.freeze({
      level: 'absent', targetCovered: false, sideEffectsCovered: false, sourceRefs,
      rationale: 'The latest direct-user message contains no standalone structured next-action directive.',
    })
  }
  const covered = directiveCoversAction(latest.directive, action)
  return Object.freeze({
    level: covered ? 'explicit' : 'conflicting',
    targetCovered: covered,
    sideEffectsCovered: covered,
    sourceRefs,
    rationale: covered
      ? 'The latest direct-user next-action directive exactly matches the verified tool, arguments, and requested permissions.'
      : 'The latest structured next-action directive does not exactly match the verified action.',
  })
}

/**
 * Conservative assessment from one source-verified action and retained direct
 * user messages. Numeric-only inputs remain the legacy provenance-only form and
 * can never authorize; only one standalone, exact, JSON next-action command
 * can authorize, never natural-language or model claims.
 */
export function assessVerifiedActionV1(
  action: ActionSnapshot,
  directUserEvidence: readonly AuthorizationInputV1[],
  earlierSandboxDenials: readonly EarlierSandboxDenialV1[] = [],
): RiskAssessmentV1 {
  const categories = new Set<RiskCategoryV1>()
  const evidence: RiskEvidenceV1[] = []
  const add = (category: RiskCategoryV1, scope: RiskEvidenceV1['scope'], trigger: string): void => {
    categories.add(category)
    evidence.push(Object.freeze({ category, sourceRefs: Object.freeze(['action-snapshot']), scope, trigger }))
  }
  let risk: ApprovalRisk = 'low'
  const value = recordValue(action.semantics.value)
  if (value === undefined) { add('unknown-semantics', 'action', 'semantic value is not an object'); risk = 'unknown' }
  else if (action.semantics.family === 'network-v1') {
    add('network-exposure', 'target', 'network semantic family'); risk = 'medium'
    const body = recordValue(value.body)
    if (body?.kind === 'utf8' || (Array.isArray(value.headers) && value.headers.length > 0)) { add('data-exfiltration', 'action', 'network payload or headers are present'); risk = 'high' }
  } else if (action.semantics.family === 'filesystem-v1' && ['delete', 'write', 'edit', 'move'].includes(String(value.operation))) {
    add('destructive-change', 'target', `filesystem ${String(value.operation)} operation`); risk = value.operation === 'delete' ? 'high' : 'medium'
  } else if (!['shell-process-v1', 'filesystem-v1'].includes(action.semantics.family)) { add('unknown-semantics', 'action', `unrecognized semantic family ${action.semantics.family}`); risk = 'unknown' }
  const sandboxExpansion = action.requestedPermissions.find(permission => permission.kind === 'sandbox')
  if (sandboxExpansion !== undefined) {
    add('permission-expansion', 'environment', `${sandboxExpansion.scope} sandbox permission requested`)
    risk = sandboxExpansion.scope === 'danger-full-access' ? 'critical' : risk === 'low' ? 'medium' : risk
  }
  const matchedAuthorization = value === undefined
    ? Object.freeze({ level: 'unknown' as const, targetCovered: false, sideEffectsCovered: false, sourceRefs: Object.freeze([]), rationale: 'Malformed action semantics cannot be authorized.' })
    : assessAuthorization(action, directUserEvidence)
  // Candidates are facts, not authorization and not retry/equivalence edges.
  // Permission expansion is therefore never eligible for a pre-review fast path;
  // only a fresh Guardian can select one candidate through its typed relation.
  const denialSourceRefs = sandboxExpansion === undefined
    ? Object.freeze([])
    : Object.freeze(earlierSandboxDenials.map(denial => `event:${denial.source.event.seq}`))
  const authorization = sandboxExpansion === undefined
    ? matchedAuthorization
    : Object.freeze({
        ...matchedAuthorization,
        sideEffectsCovered: false,
        sandboxDenialCandidateRefs: denialSourceRefs,
        rationale: denialSourceRefs.length === 0
          ? `${matchedAuthorization.rationale} Sandbox expansion has no current-turn denial candidate.`
          : `${matchedAuthorization.rationale} Sandbox-denial candidates require fresh Guardian correlation and are not authorization evidence.`,
      })
  return Object.freeze({ version: 1, risk, categories: Object.freeze([...categories].sort()), evidence: Object.freeze(evidence.sort((a, b) => a.category.localeCompare(b.category))), authorization })
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
  if (assessment.categories.includes('approval-evasion') || decision.categories.includes('approval-evasion')) {
    return { kind: 'prohibited', reason: 'approval-evasion is an absolute denial condition' }
  }
  const claim = decision.assessment
  const selectedDenialRef = claim?.sandboxDenialRelation?.sourceRef
  const validSandboxRelation = selectedDenialRef !== undefined
    && assessment.categories.includes('permission-expansion')
    && (assessment.authorization.sandboxDenialCandidateRefs ?? []).includes(selectedDenialRef)
  if (selectedDenialRef !== undefined && !validSandboxRelation) {
    return { kind: 'under-evidenced', reason: 'decision selects a sandbox denial outside the source-derived current-turn candidates' }
  }
  if (claim !== undefined) {
    const sourceRefs = new Set(assessment.authorization.sourceRefs)
    if (claim.sourceRefs.some(ref => !sourceRefs.has(ref))) return { kind: 'under-evidenced', reason: 'decision cites a source outside the source-derived authorization evidence' }
    if (claim.targetCovered && !assessment.authorization.targetCovered) return { kind: 'under-evidenced', reason: 'decision claims target coverage beyond source-derived authorization evidence' }
    if (claim.sideEffectsCovered && !assessment.authorization.sideEffectsCovered && !validSandboxRelation) {
      return { kind: 'under-evidenced', reason: 'decision claims side-effect coverage without source coverage or a valid fresh sandbox-denial relation' }
    }
  }
  if (decision.decision !== 'allow') return { kind: 'valid' }
  if (assessment.risk === 'critical' || assessment.risk === 'unknown'
    || decision.risk === 'critical' || decision.risk === 'unknown') {
    return { kind: 'prohibited', reason: 'critical or unknown risk cannot be automatically allowed' }
  }
  const sideEffectsCovered = assessment.authorization.sideEffectsCovered || validSandboxRelation
  if (assessment.authorization.level !== 'explicit' || decision.userAuthorization !== 'explicit'
    || !assessment.authorization.targetCovered || !sideEffectsCovered) {
    return { kind: 'under-evidenced', reason: 'explicit authorization does not cover target and side effects' }
  }
  if (claim === undefined || !claim.targetCovered || !claim.sideEffectsCovered) {
    return { kind: 'under-evidenced', reason: 'allow decision does not affirm validated target and side-effect coverage' }
  }
  const expectedRefs = new Set(assessment.authorization.sourceRefs)
  if (claim.sourceRefs.length !== expectedRefs.size || claim.sourceRefs.some(ref => !expectedRefs.has(ref))) {
    return { kind: 'under-evidenced', reason: 'allow decision does not cite the exact source-derived authorization evidence' }
  }
  return { kind: 'valid' }
}

export function permitsAutomaticFastPath(assessment: RiskAssessmentV1): boolean {
  return assessment.risk !== 'critical' && assessment.risk !== 'unknown'
    && !assessment.categories.includes('permission-expansion')
    && assessment.authorization.level !== 'absent' && assessment.authorization.level !== 'conflicting' && assessment.authorization.level !== 'unknown'
    && assessment.authorization.targetCovered && assessment.authorization.sideEffectsCovered
}
