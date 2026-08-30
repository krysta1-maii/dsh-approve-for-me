import { createHash } from 'node:crypto'
import { canonicalJson } from './json.js'
import type { JsonValue } from './json.js'
import { parseApprovalDecision, parseApprovalReviewRequest } from './protocol.js'
import type { ApprovalDecision, ApprovalReviewRequest } from './protocol.js'
import type { RiskAssessmentV1 } from './risk-assessment.js'

/** Durable parent Session lifecycle identity used as record/artifact scope. */
export interface SessionLifecycleIdentityV1 {
  readonly sessionId: string
  readonly sessionFormatVersion: number
  readonly createdAt: number
  readonly cwd?: string
}

/** Loader-expressible case-capture configuration (H4, still not runtime-wired). */
export interface GuardianCaseCaptureConfigV1 {
  readonly mode: 'off' | 'full'
  readonly maxCases: number
  readonly maxArtifactBytes: number
  readonly maxTotalBytes: number
  readonly retentionDays: number
}

export const PACKET_HASH_DOMAIN = 'dsh-approve-for-me/approval-review-packet/v1\0'
export const DECISION_PAYLOAD_HASH_DOMAIN = 'dsh-approve-for-me/approval-decision-payload/v1\0'
export const DECISION_TOOL_SCHEMA_HASH_DOMAIN = 'dsh-approve-for-me/decision-tool-schema/v1\0'
export const POLICY_ARTIFACT_HASH_DOMAIN = 'dsh-approve-for-me/guardian-policy-artifact/v1\0'
export const DOSSIER_HASH_DOMAIN = 'dsh-approve-for-me/guardian-dossier/v1\0'

function hashWithDomain(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update(canonicalJson(value)).digest('hex')}`
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Storage key for one create-once `review_records` row. */
export function reviewRecordKey(
  session: SessionLifecycleIdentityV1,
  reviewRunId: string,
): string {
  return `r1_${base64url(canonicalJson([session, reviewRunId]))}`
}

/** Storage key for one create-once `case_artifacts` row. */
export function caseArtifactKey(
  session: SessionLifecycleIdentityV1,
  artifactId: string,
): string {
  return `c1_${base64url(canonicalJson([session, artifactId]))}`
}

export function hashGuardianDossier(dossier: unknown): string {
  return hashWithDomain(DOSSIER_HASH_DOMAIN, dossier)
}

export function hashApprovalReviewPacket(packet: unknown): string {
  return hashWithDomain(PACKET_HASH_DOMAIN, packet)
}

export function hashApprovalDecisionPayload(payload: unknown): string {
  return hashWithDomain(DECISION_PAYLOAD_HASH_DOMAIN, payload)
}

export function hashDecisionToolSchema(schema: unknown): string {
  return hashWithDomain(DECISION_TOOL_SCHEMA_HASH_DOMAIN, schema)
}

export function hashGuardianPolicyArtifact(artifact: unknown): string {
  return hashWithDomain(POLICY_ARTIFACT_HASH_DOMAIN, artifact)
}

export function validateCaseCaptureConfig(config: GuardianCaseCaptureConfigV1): void {
  if (config.mode !== 'off' && config.mode !== 'full') {
    throw new TypeError('caseCapture.mode must be "off" or "full"')
  }
  const values = [config.maxCases, config.maxArtifactBytes, config.maxTotalBytes, config.retentionDays]
  if (values.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError('caseCapture limits must be positive safe integers')
  }
  if (config.maxArtifactBytes > config.maxTotalBytes) {
    throw new TypeError('caseCapture.maxArtifactBytes must be <= maxTotalBytes')
  }
}

export function artifactBytes(artifactKey: string, artifact: unknown): number {
  return Buffer.byteLength(artifactKey, 'utf8') + Buffer.byteLength(canonicalJson(artifact), 'utf8')
}

export type ReviewDecisionRecordAttemptOutcome =
  | { readonly kind: 'decision'; readonly decision: 'allow' | 'deny' | 'human_review' }
  | { readonly kind: 'transport-error'; readonly code: 'provider-unavailable' | 'network' | 'rate-limited' | 'timeout' | 'model-error' | 'unknown' }
  | { readonly kind: 'invalid-result'; readonly code: 'schema-invalid' | 'identity-mismatch' | 'duplicate' | 'late' | 'unknown' }
  | { readonly kind: 'no-result'; readonly reason: 'no-tool-call' | 'max-tokens' | 'refusal' | 'completed-without-decision' }
  | { readonly kind: 'aborted' }

export interface ReviewerRecoveryRecordV1 {
  readonly ordinal: number
  readonly kind: 'contaminated-child'
  readonly reviewerSessionId: string
  readonly discardedReviewId?: string
  readonly generation: string
  readonly occurredAt: number
}

export type ReviewDecisionGuardianV1 =
  | {
      readonly kind: 'decision'
      readonly decision: 'allow' | 'deny' | 'human_review'
      readonly risk: string
      readonly categories: readonly string[]
      readonly userAuthorization: string
      readonly decisionPayloadHash: string
      readonly rationaleBytes: number
    }
  | {
      readonly kind: 'no-decision'
      readonly reason: 'transport-error' | 'invalid-result' | 'no-result' | 'deadline' | 'aborted' | 'host-disposed'
    }

export interface ReviewDecisionRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly approval: {
    readonly askedEventSeq: number
    readonly callId: string
    readonly toolName: string
  }
  readonly review: {
    readonly reviewRunId: string
    readonly actionHash: string
    readonly dossierHash: string
    readonly dossierVersion: 1
    readonly approvalProtocolVersion: 1
    readonly decisionSchemaVersion: 1
    /** Canonical Reviewer packet codec used by this recorded review. */
    readonly packetCodecId: 'approval-review-packet-v1' | 'approval-review-packet-v2'
    readonly hashSuiteId: 'dsh-approve-for-me-hash-v1'
    readonly sourceProjectionPolicyId: 'dsh-session-facts-v1'
    readonly argumentSemanticsId: string
    readonly actionProjectorId: string
    readonly policyVersion: string
    readonly policyArtifactFingerprint: string
    readonly decisionSchemaFingerprint: string
    readonly classificationCatalogFingerprint: string
    readonly toolsetVersion: 1
    readonly configurationFingerprint: string
    readonly generation: string
    readonly providerId: string
    readonly modelId: string
    readonly reasoningEffort?: string
  }
  readonly attempts: readonly {
    readonly ordinal: number
    readonly reviewId: string
    readonly reviewerSessionId: string
    readonly generation: string
    readonly outcome: ReviewDecisionRecordAttemptOutcome
    readonly durationMs: number
  }[]
  readonly recoveries: readonly ReviewerRecoveryRecordV1[]
  readonly guardian: ReviewDecisionGuardianV1
  readonly pluginDisposition: 'allow' | 'deny' | 'delegate-human' | 'unavailable' | 'cancelled'
  readonly failureStage?: string
  readonly completedAt: number
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const PLUGIN_DISPOSITIONS = ['allow', 'deny', 'delegate-human', 'unavailable', 'cancelled'] as const
const GUARDIAN_NO_DECISION_REASONS = [
  'transport-error', 'invalid-result', 'no-result', 'deadline', 'aborted', 'host-disposed',
] as const

function recordObject(input: unknown, name: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${name} must be an object`)
  }
  return input as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name}.${key} is required`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not supported`)
  }
}

function nonEmptyString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`${name} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

function safeInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value as number
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${name}[${index}]`)))
}

function hash(value: unknown, name: string): string {
  const result = nonEmptyString(value, name, 71)
  if (!HASH_PATTERN.test(result)) throw new TypeError(`${name} must be a sha256 digest`)
  return result
}

function parseAttemptOutcome(value: unknown, name: string): ReviewDecisionRecordAttemptOutcome {
  const object = recordObject(value, name)
  const kind = object.kind
  if (kind === 'decision') {
    exactKeys(object, ['kind', 'decision'], [], name)
    const decision = object.decision
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'human_review') {
      throw new TypeError(`${name}.decision must be allow/deny/human_review`)
    }
    return Object.freeze({ kind: 'decision', decision })
  }
  if (kind === 'transport-error') {
    exactKeys(object, ['kind', 'code'], [], name)
    const code = object.code
    if (!['provider-unavailable', 'network', 'rate-limited', 'timeout', 'model-error', 'unknown'].includes(code as string)) {
      throw new TypeError(`${name}.code is not supported`)
    }
    return Object.freeze({ kind: 'transport-error', code: code as 'provider-unavailable' })
  }
  if (kind === 'invalid-result') {
    exactKeys(object, ['kind', 'code'], [], name)
    const code = object.code
    if (!['schema-invalid', 'identity-mismatch', 'duplicate', 'late', 'unknown'].includes(code as string)) {
      throw new TypeError(`${name}.code is not supported`)
    }
    return Object.freeze({ kind: 'invalid-result', code: code as 'schema-invalid' })
  }
  if (kind === 'no-result') {
    exactKeys(object, ['kind', 'reason'], [], name)
    const reason = object.reason
    if (!['no-tool-call', 'max-tokens', 'refusal', 'completed-without-decision'].includes(reason as string)) {
      throw new TypeError(`${name}.reason is not supported`)
    }
    return Object.freeze({ kind: 'no-result', reason: reason as 'no-tool-call' })
  }
  if (kind === 'aborted') {
    return Object.freeze({ kind: 'aborted' })
  }
  throw new TypeError(`${name}.kind is not supported`)
}

function parseRecovery(value: unknown, name: string): ReviewerRecoveryRecordV1 {
  const object = recordObject(value, name)
  exactKeys(object, ['ordinal', 'kind', 'reviewerSessionId', 'generation', 'occurredAt'], ['discardedReviewId'], name)
  if (object.kind !== 'contaminated-child') throw new TypeError(`${name}.kind must be contaminated-child`)
  return Object.freeze({
    ordinal: safeInt(object.ordinal, `${name}.ordinal`),
    kind: 'contaminated-child',
    reviewerSessionId: nonEmptyString(object.reviewerSessionId, `${name}.reviewerSessionId`),
    ...object.discardedReviewId === undefined ? {} : { discardedReviewId: nonEmptyString(object.discardedReviewId, `${name}.discardedReviewId`) },
    generation: nonEmptyString(object.generation, `${name}.generation`),
    occurredAt: safeInt(object.occurredAt, `${name}.occurredAt`),
  })
}

function parseGuardian(value: unknown, name: string): ReviewDecisionGuardianV1 {
  const object = recordObject(value, name)
  if (object.kind === 'decision') {
    exactKeys(object, ['kind', 'decision', 'risk', 'categories', 'userAuthorization', 'decisionPayloadHash', 'rationaleBytes'], [], name)
    const decision = object.decision
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'human_review') {
      throw new TypeError(`${name}.decision must be allow/deny/human_review`)
    }
    return Object.freeze({
      kind: 'decision',
      decision,
      risk: nonEmptyString(object.risk, `${name}.risk`),
      categories: stringArray(object.categories, `${name}.categories`),
      userAuthorization: nonEmptyString(object.userAuthorization, `${name}.userAuthorization`),
      decisionPayloadHash: hash(object.decisionPayloadHash, `${name}.decisionPayloadHash`),
      rationaleBytes: safeInt(object.rationaleBytes, `${name}.rationaleBytes`),
    })
  }
  if (object.kind === 'no-decision') {
    exactKeys(object, ['kind', 'reason'], [], name)
    const reason = object.reason
    if (!GUARDIAN_NO_DECISION_REASONS.includes(reason as typeof GUARDIAN_NO_DECISION_REASONS[number])) {
      throw new TypeError(`${name}.reason is not supported`)
    }
    return Object.freeze({ kind: 'no-decision', reason: reason as 'aborted' })
  }
  throw new TypeError(`${name}.kind is not supported`)
}

export function parseReviewDecisionRecord(input: unknown): ReviewDecisionRecordV1 {
  const value = recordObject(input, 'record')
  exactKeys(value, ['version', 'session', 'approval', 'review', 'attempts', 'recoveries', 'guardian', 'pluginDisposition', 'completedAt'], ['failureStage'], 'record')
  if (value.version !== 1) throw new TypeError('record.version must be 1')

  const session = recordObject(value.session, 'record.session')
  exactKeys(session, ['sessionId', 'sessionFormatVersion', 'createdAt'], ['cwd'], 'record.session')
  const sessionIdentity: SessionLifecycleIdentityV1 = Object.freeze({
    sessionId: nonEmptyString(session.sessionId, 'record.session.sessionId'),
    sessionFormatVersion: safeInt(session.sessionFormatVersion, 'record.session.sessionFormatVersion'),
    createdAt: safeInt(session.createdAt, 'record.session.createdAt'),
    ...session.cwd === undefined ? {} : { cwd: nonEmptyString(session.cwd, 'record.session.cwd') },
  })

  const approval = recordObject(value.approval, 'record.approval')
  exactKeys(approval, ['askedEventSeq', 'callId', 'toolName'], [], 'record.approval')
  const approvalRecord = Object.freeze({
    askedEventSeq: safeInt(approval.askedEventSeq, 'record.approval.askedEventSeq'),
    callId: nonEmptyString(approval.callId, 'record.approval.callId'),
    toolName: nonEmptyString(approval.toolName, 'record.approval.toolName'),
  })

  const review = recordObject(value.review, 'record.review')
  exactKeys(review, [
    'reviewRunId', 'actionHash', 'dossierHash', 'dossierVersion', 'approvalProtocolVersion',
    'decisionSchemaVersion', 'packetCodecId', 'hashSuiteId', 'sourceProjectionPolicyId',
    'argumentSemanticsId', 'actionProjectorId', 'policyVersion', 'policyArtifactFingerprint',
    'decisionSchemaFingerprint', 'classificationCatalogFingerprint', 'toolsetVersion',
    'configurationFingerprint', 'generation', 'providerId', 'modelId',
  ], ['reasoningEffort'], 'record.review')
  if (review.dossierVersion !== 1) throw new TypeError('record.review.dossierVersion must be 1')
  if (review.approvalProtocolVersion !== 1) throw new TypeError('record.review.approvalProtocolVersion must be 1')
  if (review.decisionSchemaVersion !== 1) throw new TypeError('record.review.decisionSchemaVersion must be 1')
  if (review.packetCodecId !== 'approval-review-packet-v1' && review.packetCodecId !== 'approval-review-packet-v2') {
    throw new TypeError('record.review.packetCodecId must be approval-review-packet-v1 or approval-review-packet-v2')
  }
  if (review.hashSuiteId !== 'dsh-approve-for-me-hash-v1') throw new TypeError('record.review.hashSuiteId must be dsh-approve-for-me-hash-v1')
  if (review.sourceProjectionPolicyId !== 'dsh-session-facts-v1') throw new TypeError('record.review.sourceProjectionPolicyId must be dsh-session-facts-v1')
  if (review.toolsetVersion !== 1) throw new TypeError('record.review.toolsetVersion must be 1')
  const reviewRecord = Object.freeze({
    reviewRunId: nonEmptyString(review.reviewRunId, 'record.review.reviewRunId'),
    actionHash: hash(review.actionHash, 'record.review.actionHash'),
    dossierHash: hash(review.dossierHash, 'record.review.dossierHash'),
    dossierVersion: 1,
    approvalProtocolVersion: 1,
    decisionSchemaVersion: 1,
    packetCodecId: review.packetCodecId as 'approval-review-packet-v1' | 'approval-review-packet-v2',
    hashSuiteId: 'dsh-approve-for-me-hash-v1' as const,
    sourceProjectionPolicyId: 'dsh-session-facts-v1' as const,
    argumentSemanticsId: nonEmptyString(review.argumentSemanticsId, 'record.review.argumentSemanticsId'),
    actionProjectorId: nonEmptyString(review.actionProjectorId, 'record.review.actionProjectorId'),
    policyVersion: nonEmptyString(review.policyVersion, 'record.review.policyVersion'),
    policyArtifactFingerprint: hash(review.policyArtifactFingerprint, 'record.review.policyArtifactFingerprint'),
    decisionSchemaFingerprint: hash(review.decisionSchemaFingerprint, 'record.review.decisionSchemaFingerprint'),
    classificationCatalogFingerprint: hash(review.classificationCatalogFingerprint, 'record.review.classificationCatalogFingerprint'),
    toolsetVersion: 1,
    configurationFingerprint: hash(review.configurationFingerprint, 'record.review.configurationFingerprint'),
    generation: nonEmptyString(review.generation, 'record.review.generation'),
    providerId: nonEmptyString(review.providerId, 'record.review.providerId'),
    modelId: nonEmptyString(review.modelId, 'record.review.modelId'),
    ...review.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmptyString(review.reasoningEffort, 'record.review.reasoningEffort') },
  })

  if (!Array.isArray(value.attempts)) throw new TypeError('record.attempts must be an array')
  const attempts = Object.freeze(value.attempts.map((attempt, index) => {
    const name = `record.attempts[${index}]`
    const object = recordObject(attempt, name)
    exactKeys(object, ['ordinal', 'reviewId', 'reviewerSessionId', 'generation', 'outcome', 'durationMs'], [], name)
    return Object.freeze({
      ordinal: safeInt(object.ordinal, `${name}.ordinal`),
      reviewId: nonEmptyString(object.reviewId, `${name}.reviewId`),
      reviewerSessionId: nonEmptyString(object.reviewerSessionId, `${name}.reviewerSessionId`),
      generation: nonEmptyString(object.generation, `${name}.generation`),
      outcome: parseAttemptOutcome(object.outcome, `${name}.outcome`),
      durationMs: safeInt(object.durationMs, `${name}.durationMs`),
    })
  }))

  if (!Array.isArray(value.recoveries)) throw new TypeError('record.recoveries must be an array')
  const recoveries = Object.freeze(value.recoveries.map((recovery, index) => parseRecovery(recovery, `record.recoveries[${index}]`)))

  const pluginDisposition = value.pluginDisposition
  if (!PLUGIN_DISPOSITIONS.includes(pluginDisposition as typeof PLUGIN_DISPOSITIONS[number])) {
    throw new TypeError('record.pluginDisposition is not supported')
  }

  return Object.freeze({
    version: 1,
    session: sessionIdentity,
    approval: approvalRecord,
    review: reviewRecord,
    attempts,
    recoveries,
    guardian: parseGuardian(value.guardian, 'record.guardian'),
    pluginDisposition: pluginDisposition as 'allow',
    ...value.failureStage === undefined ? {} : { failureStage: nonEmptyString(value.failureStage, 'record.failureStage') },
    completedAt: safeInt(value.completedAt, 'record.completedAt'),
  })
}

/**
 * Canonical packet sent to Guardian: the attempt request plus an opaque,
 * source-verified dossier. D1 will replace `dossier` with the fully typed
 * `GuardianDossierV1` once the compiler lands; this shape already carries the
 * packet-level envelope and hash used by record/case artifacts.
 */
export interface ApprovalReviewPacketV1 {
  readonly version: 1
  readonly kind: 'approval-review-packet'
  readonly request: ApprovalReviewRequest
  readonly dossier: JsonValue
  readonly dossierHash: string
}

/** R5 packet extension; v1 remains available for persisted historical cases. */
export interface ApprovalReviewPacketV2 {
  readonly version: 2
  readonly kind: 'approval-review-packet'
  readonly request: ApprovalReviewRequest
  readonly dossier: JsonValue
  readonly dossierHash: string
  readonly policy: { readonly version: string; readonly configurationFingerprint: string }
  readonly baseline: RiskAssessmentV1
}

export function createApprovalReviewPacketV2(input: {
  readonly request: ApprovalReviewRequest
  readonly dossier: JsonValue
  readonly dossierHash?: string
  readonly policy: ApprovalReviewPacketV2['policy']
  readonly baseline: RiskAssessmentV1
}): ApprovalReviewPacketV2 {
  const request = parseApprovalReviewRequest(input.request)
  canonicalJson(input.dossier)
  const dossierHash = input.dossierHash ?? hashGuardianDossier(input.dossier)
  if (dossierHash !== hashGuardianDossier(input.dossier)) throw new TypeError('approval-review-packet.dossierHash does not match dossier')
  if (typeof input.policy.version !== 'string' || input.policy.version.length === 0 || !HASH_PATTERN.test(input.policy.configurationFingerprint)) throw new TypeError('approval-review-packet.policy is invalid')
  canonicalJson(input.baseline)
  return Object.freeze({ version: 2, kind: 'approval-review-packet', request, dossier: input.dossier, dossierHash, policy: Object.freeze({ ...input.policy }), baseline: input.baseline })
}

export function parseApprovalReviewPacketV2(input: unknown): ApprovalReviewPacketV2 {
  const value = recordObject(input, 'packet')
  exactKeys(value, ['version', 'kind', 'request', 'dossier', 'dossierHash', 'policy', 'baseline'], [], 'packet')
  if (value.version !== 2) throw new TypeError('packet.version must be 2')
  if (value.kind !== 'approval-review-packet') throw new TypeError('packet.kind must be approval-review-packet')
  const request = parseApprovalReviewRequest(value.request)
  canonicalJson(value.dossier)
  const dossierHash = hash(value.dossierHash, 'packet.dossierHash')
  if (dossierHash !== hashGuardianDossier(value.dossier)) throw new TypeError('packet.dossierHash does not match packet.dossier')
  const policy = recordObject(value.policy, 'packet.policy')
  exactKeys(policy, ['version', 'configurationFingerprint'], [], 'packet.policy')
  const policyVersion = nonEmptyString(policy.version, 'packet.policy.version')
  const configurationFingerprint = hash(policy.configurationFingerprint, 'packet.policy.configurationFingerprint')
  const baseline = recordObject(value.baseline, 'packet.baseline')
  exactKeys(baseline, ['version', 'risk', 'categories', 'evidence', 'authorization'], [], 'packet.baseline')
  if (baseline.version !== 1) throw new TypeError('packet.baseline.version must be 1')
  canonicalJson(baseline)
  return Object.freeze({ version: 2, kind: 'approval-review-packet', request, dossier: value.dossier as JsonValue, dossierHash, policy: Object.freeze({ version: policyVersion, configurationFingerprint }), baseline: baseline as unknown as RiskAssessmentV1 })
}

export interface GuardianPolicyArtifactV1 {
  readonly version: 1
  readonly policyVersion: string
  readonly policyArtifactFingerprint: string
  readonly systemPrompt: string
  readonly decisionToolName: string
  readonly decisionToolSchema: JsonValue
  readonly decisionSchemaFingerprint: string
  readonly toolsetVersion: 1
}

export type GuardianCaseAttemptObservationV1 =
  | { readonly kind: 'decision-tool'; readonly payload: ApprovalDecision }
  | {
      readonly kind: 'invalid-result'
      readonly code: 'schema-invalid' | 'identity-mismatch' | 'duplicate' | 'late' | 'unknown'
      readonly observedBytes?: number
    }
  | { readonly kind: 'no-result'; readonly reason: 'no-tool-call' | 'max-tokens' | 'refusal' | 'completed-without-decision' }
  | { readonly kind: 'transport-error'; readonly code: 'provider-unavailable' | 'network' | 'rate-limited' | 'timeout' | 'model-error' | 'unknown' }
  | { readonly kind: 'aborted' }

export interface GuardianCaseArtifactV1 {
  readonly version: 1
  readonly artifactId: string
  readonly session: SessionLifecycleIdentityV1
  readonly approval: ReviewDecisionRecordV1['approval']
  readonly reviewRunId: string
  readonly configurationFingerprint: string
  readonly reviewerPolicy: GuardianPolicyArtifactV1
  readonly attempts: readonly {
    readonly ordinal: number
    readonly reviewId: string
    readonly reviewerSessionId: string
    readonly packetHash: string
    readonly packet: ApprovalReviewPacketV1
    readonly generation: string
    readonly providerId: string
    readonly modelId: string
    readonly reasoningEffort?: string
    readonly startedAt: number
    readonly completedAt: number
    readonly observation: GuardianCaseAttemptObservationV1
  }[]
  readonly recoveries: readonly ReviewerRecoveryRecordV1[]
  readonly pluginDisposition: ReviewDecisionRecordV1['pluginDisposition']
  readonly capturedAt: number
  readonly expiresAt: number
}

export function createApprovalReviewPacketV1(input: {
  readonly request: ApprovalReviewRequest
  readonly dossier: JsonValue
  readonly dossierHash?: string
}): ApprovalReviewPacketV1 {
  const request = parseApprovalReviewRequest(input.request)
  // canonicalJson rejects non-JSON values before we calculate a hash.
  canonicalJson(input.dossier)
  const dossierHash = input.dossierHash ?? hashGuardianDossier(input.dossier)
  if (dossierHash !== hashGuardianDossier(input.dossier)) {
    throw new TypeError('approval-review-packet.dossierHash does not match dossier')
  }
  return Object.freeze({
    version: 1,
    kind: 'approval-review-packet',
    request,
    dossier: input.dossier,
    dossierHash,
  })
}

export function parseApprovalReviewPacketV1(input: unknown): ApprovalReviewPacketV1 {
  const value = recordObject(input, 'packet')
  exactKeys(value, ['version', 'kind', 'request', 'dossier', 'dossierHash'], [], 'packet')
  if (value.version !== 1) throw new TypeError('packet.version must be 1')
  if (value.kind !== 'approval-review-packet') throw new TypeError('packet.kind must be approval-review-packet')
  const request = parseApprovalReviewRequest(value.request)
  canonicalJson(value.dossier)
  const dossierHash = hash(value.dossierHash, 'packet.dossierHash')
  const expectedDossierHash = hashGuardianDossier(value.dossier)
  if (dossierHash !== expectedDossierHash) {
    throw new TypeError('packet.dossierHash does not match packet.dossier')
  }
  return Object.freeze({
    version: 1,
    kind: 'approval-review-packet',
    request,
    dossier: value.dossier as JsonValue,
    dossierHash,
  })
}

export function parseGuardianPolicyArtifactV1(input: unknown): GuardianPolicyArtifactV1 {
  const value = recordObject(input, 'policy-artifact')
  exactKeys(value, [
    'version', 'policyVersion', 'policyArtifactFingerprint', 'systemPrompt',
    'decisionToolName', 'decisionToolSchema', 'decisionSchemaFingerprint', 'toolsetVersion',
  ], [], 'policy-artifact')
  if (value.version !== 1) throw new TypeError('policy-artifact.version must be 1')
  if (value.toolsetVersion !== 1) throw new TypeError('policy-artifact.toolsetVersion must be 1')
  canonicalJson(value.decisionToolSchema)
  return Object.freeze({
    version: 1,
    policyVersion: nonEmptyString(value.policyVersion, 'policy-artifact.policyVersion'),
    policyArtifactFingerprint: hash(value.policyArtifactFingerprint, 'policy-artifact.policyArtifactFingerprint'),
    systemPrompt: nonEmptyString(value.systemPrompt, 'policy-artifact.systemPrompt'),
    decisionToolName: nonEmptyString(value.decisionToolName, 'policy-artifact.decisionToolName'),
    decisionToolSchema: value.decisionToolSchema as JsonValue,
    decisionSchemaFingerprint: hash(value.decisionSchemaFingerprint, 'policy-artifact.decisionSchemaFingerprint'),
    toolsetVersion: 1,
  })
}

function parseCaseObservation(value: unknown, name: string): GuardianCaseAttemptObservationV1 {
  const object = recordObject(value, name)
  const kind = object.kind
  if (kind === 'decision-tool') {
    exactKeys(object, ['kind', 'payload'], [], name)
    return Object.freeze({ kind: 'decision-tool', payload: parseApprovalDecision(object.payload) })
  }
  if (kind === 'invalid-result') {
    exactKeys(object, ['kind', 'code'], ['observedBytes'], name)
    const code = object.code
    if (!['schema-invalid', 'identity-mismatch', 'duplicate', 'late', 'unknown'].includes(code as string)) {
      throw new TypeError(`${name}.code is not supported`)
    }
    return Object.freeze({
      kind: 'invalid-result',
      code: code as 'schema-invalid',
      ...object.observedBytes === undefined ? {} : { observedBytes: safeInt(object.observedBytes, `${name}.observedBytes`) },
    })
  }
  if (kind === 'no-result') {
    exactKeys(object, ['kind', 'reason'], [], name)
    const reason = object.reason
    if (!['no-tool-call', 'max-tokens', 'refusal', 'completed-without-decision'].includes(reason as string)) {
      throw new TypeError(`${name}.reason is not supported`)
    }
    return Object.freeze({ kind: 'no-result', reason: reason as 'no-tool-call' })
  }
  if (kind === 'transport-error') {
    exactKeys(object, ['kind', 'code'], [], name)
    const code = object.code
    if (!['provider-unavailable', 'network', 'rate-limited', 'timeout', 'model-error', 'unknown'].includes(code as string)) {
      throw new TypeError(`${name}.code is not supported`)
    }
    return Object.freeze({ kind: 'transport-error', code: code as 'provider-unavailable' })
  }
  if (kind === 'aborted') return Object.freeze({ kind: 'aborted' })
  throw new TypeError(`${name}.kind is not supported`)
}

function parseSessionIdentity(value: unknown, name: string): SessionLifecycleIdentityV1 {
  const object = recordObject(value, name)
  exactKeys(object, ['sessionId', 'sessionFormatVersion', 'createdAt'], ['cwd'], name)
  return Object.freeze({
    sessionId: nonEmptyString(object.sessionId, `${name}.sessionId`),
    sessionFormatVersion: safeInt(object.sessionFormatVersion, `${name}.sessionFormatVersion`),
    createdAt: safeInt(object.createdAt, `${name}.createdAt`),
    ...object.cwd === undefined ? {} : { cwd: nonEmptyString(object.cwd, `${name}.cwd`) },
  })
}

function parseApprovalRef(value: unknown, name: string): ReviewDecisionRecordV1['approval'] {
  const object = recordObject(value, name)
  exactKeys(object, ['askedEventSeq', 'callId', 'toolName'], [], name)
  return Object.freeze({
    askedEventSeq: safeInt(object.askedEventSeq, `${name}.askedEventSeq`),
    callId: nonEmptyString(object.callId, `${name}.callId`),
    toolName: nonEmptyString(object.toolName, `${name}.toolName`),
  })
}

export function parseGuardianCaseArtifactV1(input: unknown): GuardianCaseArtifactV1 {
  const value = recordObject(input, 'case-artifact')
  exactKeys(value, ['version', 'artifactId', 'session', 'approval', 'reviewRunId', 'configurationFingerprint', 'reviewerPolicy', 'attempts', 'recoveries', 'pluginDisposition', 'capturedAt', 'expiresAt'], [], 'case-artifact')
  if (value.version !== 1) throw new TypeError('case-artifact.version must be 1')
  if (!Array.isArray(value.attempts)) throw new TypeError('case-artifact.attempts must be an array')
  if (!Array.isArray(value.recoveries)) throw new TypeError('case-artifact.recoveries must be an array')
  const pluginDisposition = value.pluginDisposition
  if (!PLUGIN_DISPOSITIONS.includes(pluginDisposition as typeof PLUGIN_DISPOSITIONS[number])) {
    throw new TypeError('case-artifact.pluginDisposition is not supported')
  }
  const capturedAt = safeInt(value.capturedAt, 'case-artifact.capturedAt')
  const expiresAt = safeInt(value.expiresAt, 'case-artifact.expiresAt')
  if (expiresAt < capturedAt) throw new TypeError('case-artifact.expiresAt must not precede capturedAt')

  const attempts = Object.freeze(value.attempts.map((attempt, index) => {
    const name = `case-artifact.attempts[${index}]`
    const object = recordObject(attempt, name)
    exactKeys(object, ['ordinal', 'reviewId', 'reviewerSessionId', 'packetHash', 'packet', 'generation', 'providerId', 'modelId', 'startedAt', 'completedAt', 'observation'], ['reasoningEffort'], name)
    const packet = parseApprovalReviewPacketV1(object.packet)
    const packetHash = hash(object.packetHash, `${name}.packetHash`)
    if (packetHash !== hashApprovalReviewPacket(packet)) {
      throw new TypeError(`${name}.packetHash does not match packet`)
    }
    return Object.freeze({
      ordinal: safeInt(object.ordinal, `${name}.ordinal`),
      reviewId: nonEmptyString(object.reviewId, `${name}.reviewId`),
      reviewerSessionId: nonEmptyString(object.reviewerSessionId, `${name}.reviewerSessionId`),
      packetHash,
      packet,
      generation: nonEmptyString(object.generation, `${name}.generation`),
      providerId: nonEmptyString(object.providerId, `${name}.providerId`),
      modelId: nonEmptyString(object.modelId, `${name}.modelId`),
      ...object.reasoningEffort === undefined ? {} : { reasoningEffort: nonEmptyString(object.reasoningEffort, `${name}.reasoningEffort`) },
      startedAt: safeInt(object.startedAt, `${name}.startedAt`),
      completedAt: safeInt(object.completedAt, `${name}.completedAt`),
      observation: parseCaseObservation(object.observation, `${name}.observation`),
    })
  }))

  return Object.freeze({
    version: 1,
    artifactId: nonEmptyString(value.artifactId, 'case-artifact.artifactId'),
    session: parseSessionIdentity(value.session, 'case-artifact.session'),
    approval: parseApprovalRef(value.approval, 'case-artifact.approval'),
    reviewRunId: nonEmptyString(value.reviewRunId, 'case-artifact.reviewRunId'),
    configurationFingerprint: hash(value.configurationFingerprint, 'case-artifact.configurationFingerprint'),
    reviewerPolicy: parseGuardianPolicyArtifactV1(value.reviewerPolicy),
    attempts,
    recoveries: Object.freeze(value.recoveries.map((recovery, index) => parseRecovery(recovery, `case-artifact.recoveries[${index}]`))),
    pluginDisposition: pluginDisposition as 'allow',
    capturedAt,
    expiresAt,
  })
}
