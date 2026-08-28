import { createHash } from 'node:crypto'
import { canonicalJson } from './json.js'

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
