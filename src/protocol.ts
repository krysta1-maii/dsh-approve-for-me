import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, freezeJson, snapshotJson } from './json.js'
import type { JsonValue } from './json.js'

export const REVIEWER_PROVIDER = 'dsh-approve-for-me/reviewer'
export const APPROVAL_PROTOCOL_VERSION = 1 as const

const ACTION_HASH_DOMAIN = 'dsh-approve-for-me/action-snapshot/v1\0'
const CONFIG_HASH_DOMAIN = 'dsh-approve-for-me/reviewer-config/v1\0'
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/
const DECISIONS = ['allow', 'deny', 'human_review'] as const
const RISKS = ['low', 'medium', 'high', 'critical', 'unknown'] as const
const AUTHORIZATIONS = ['explicit', 'implicit', 'absent', 'conflicting', 'unknown'] as const
const PERMISSION_KINDS = ['filesystem', 'network', 'sandbox', 'process', 'other'] as const

export interface ReviewerModelRoute {
  readonly providerId: string
  readonly modelId: string
  readonly effort?: string
}

export interface ReviewerConfiguration {
  readonly generation: string
  readonly modelRoute: ReviewerModelRoute
  readonly policyVersion: string
  readonly toolsetVersion: 1
}

export interface ReviewerProviderDataV1 extends ReviewerConfiguration {
  readonly version: 1
  readonly role: 'primary'
  readonly configurationFingerprint: string
}

export type RequestedPermissionKind = typeof PERMISSION_KINDS[number]

export interface RequestedPermission {
  readonly kind: RequestedPermissionKind
  readonly scope: string
  readonly details?: JsonValue
}

export interface ActionSnapshot {
  readonly version: 1
  readonly kind: 'tool-call'
  readonly toolName: string
  readonly arguments: JsonValue
  readonly requestedPermissions: readonly RequestedPermission[]
}

export interface ActionSnapshotInput {
  readonly toolName: string
  readonly arguments: unknown
  readonly requestedPermissions?: readonly {
    readonly kind: RequestedPermissionKind
    readonly scope: string
    readonly details?: unknown
  }[]
}

export interface ApprovalRequest {
  readonly protocolVersion: 1
  readonly reviewId: string
  readonly parentSessionId: string
  readonly reviewerSessionId: string
  readonly generation: string
  readonly callId?: string
  readonly reason?: string
  readonly actionHash: string
  readonly issuedAt: number
  readonly deadlineAt: number
  readonly action: ActionSnapshot
}

export interface CreateApprovalRequestOptions {
  readonly reviewId?: string
  readonly parentSessionId: string
  readonly reviewerSessionId: string
  readonly generation: string
  readonly callId?: string
  readonly reason?: string
  readonly issuedAt: number
  readonly deadlineAt: number
}

export type ApprovalDecisionKind = typeof DECISIONS[number]
export type ApprovalRisk = typeof RISKS[number]
export type UserAuthorization = typeof AUTHORIZATIONS[number]

export interface ApprovalDecision {
  readonly protocolVersion: 1
  readonly reviewId: string
  readonly parentSessionId: string
  readonly reviewerSessionId: string
  readonly generation: string
  readonly actionHash: string
  readonly decision: ApprovalDecisionKind
  readonly risk: ApprovalRisk
  readonly categories: readonly string[]
  readonly userAuthorization: UserAuthorization
  readonly rationale: string
}

export type ReviewMode = 'auto' | 'auto-then-user'
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ApprovalResolution =
  | { readonly kind: 'outcome'; readonly outcome: ApprovalOutcome }
  | { readonly kind: 'delegate' }

export interface ReviewerTextBlock {
  readonly type: 'text'
  readonly text: string
}

function record(input: unknown, name: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${name} must be an object`)
  }
  return input as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], name: string): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name}.${key} is required`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not supported`)
  }
}

function boundedString(input: unknown, name: string, maxLength = 4096): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters`)
  }
  return input
}

function identifier(input: unknown, name: string): string {
  const value = boundedString(input, name, 512)
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} has an invalid format`)
  return value
}

function hash(input: unknown, name: string): string {
  const value = boundedString(input, name, 71)
  if (!HASH_PATTERN.test(value)) throw new TypeError(`${name} must be a sha256 digest`)
  return value
}

function member<const T extends readonly string[]>(input: unknown, values: T, name: string): T[number] {
  if (typeof input !== 'string' || !values.includes(input)) {
    throw new TypeError(`${name} must be one of ${values.join(', ')}`)
  }
  return input as T[number]
}

function timestamp(input: unknown, name: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return input as number
}

function digest(domain: string, input: unknown): string {
  return `sha256:${createHash('sha256').update(domain).update(canonicalJson(input)).digest('hex')}`
}

function parseModelRoute(input: unknown): ReviewerModelRoute {
  const value = record(input, 'providerData.modelRoute')
  exactKeys(value, ['providerId', 'modelId'], ['effort'], 'providerData.modelRoute')
  const route: ReviewerModelRoute = {
    providerId: identifier(value.providerId, 'providerData.modelRoute.providerId'),
    modelId: identifier(value.modelId, 'providerData.modelRoute.modelId'),
    ...value.effort === undefined ? {} : { effort: identifier(value.effort, 'providerData.modelRoute.effort') },
  }
  return Object.freeze(route)
}

/** Compute the immutable composition fingerprint excluding the instance generation. */
export function fingerprintReviewerConfiguration(config: Omit<ReviewerConfiguration, 'generation'>): string {
  return digest(CONFIG_HASH_DOMAIN, config)
}

/** Build trusted descriptor data for a new Reviewer child. */
export function createReviewerProviderData(config: ReviewerConfiguration): ReviewerProviderDataV1 {
  const generation = identifier(config.generation, 'providerData.generation')
  const modelRoute = parseModelRoute(config.modelRoute)
  const policyVersion = identifier(config.policyVersion, 'providerData.policyVersion')
  if (config.toolsetVersion !== 1) throw new TypeError('providerData.toolsetVersion must be 1')
  const configurationFingerprint = fingerprintReviewerConfiguration({ modelRoute, policyVersion, toolsetVersion: 1 })
  return Object.freeze({
    version: 1,
    role: 'primary',
    generation,
    configurationFingerprint,
    modelRoute,
    policyVersion,
    toolsetVersion: 1,
  })
}

/** Parse untrusted descriptor data supplied by the Managed Runtime. */
export function parseReviewerProviderData(input: unknown): ReviewerProviderDataV1 {
  const value = record(input, 'providerData')
  exactKeys(
    value,
    ['version', 'role', 'generation', 'configurationFingerprint', 'modelRoute', 'policyVersion', 'toolsetVersion'],
    [],
    'providerData',
  )
  if (value.version !== 1) throw new TypeError('providerData.version must be 1')
  if (value.role !== 'primary') throw new TypeError('providerData.role must be "primary"')
  const parsed = createReviewerProviderData({
    generation: identifier(value.generation, 'providerData.generation'),
    modelRoute: parseModelRoute(value.modelRoute),
    policyVersion: identifier(value.policyVersion, 'providerData.policyVersion'),
    toolsetVersion: value.toolsetVersion as 1,
  })
  const supplied = hash(value.configurationFingerprint, 'providerData.configurationFingerprint')
  if (supplied !== parsed.configurationFingerprint) {
    throw new TypeError('providerData.configurationFingerprint does not match the composition')
  }
  return parsed
}

function parseRequestedPermission(input: unknown, index: number): RequestedPermission {
  const name = `action.requestedPermissions[${index}]`
  const value = record(input, name)
  exactKeys(value, ['kind', 'scope'], ['details'], name)
  return Object.freeze({
    kind: member(value.kind, PERMISSION_KINDS, `${name}.kind`),
    scope: boundedString(value.scope, `${name}.scope`, 2048),
    ...value.details === undefined ? {} : { details: freezeJson(snapshotJson(value.details)) as JsonValue },
  })
}

/** Create an immutable, lossless snapshot of the action being approved. */
export function createActionSnapshot(input: ActionSnapshotInput): ActionSnapshot {
  const permissions = input.requestedPermissions ?? []
  if (permissions.length > 32) throw new TypeError('action.requestedPermissions may contain at most 32 entries')
  const snapshot: ActionSnapshot = {
    version: 1,
    kind: 'tool-call',
    toolName: identifier(input.toolName, 'action.toolName'),
    arguments: freezeJson(snapshotJson(input.arguments)) as JsonValue,
    requestedPermissions: Object.freeze(permissions.map(parseRequestedPermission)),
  }
  return Object.freeze(snapshot)
}

export function parseActionSnapshot(input: unknown): ActionSnapshot {
  const value = record(input, 'action')
  exactKeys(value, ['version', 'kind', 'toolName', 'arguments', 'requestedPermissions'], [], 'action')
  if (value.version !== 1) throw new TypeError('action.version must be 1')
  if (value.kind !== 'tool-call') throw new TypeError('action.kind must be "tool-call"')
  if (!Array.isArray(value.requestedPermissions)) throw new TypeError('action.requestedPermissions must be an array')
  return createActionSnapshot({
    toolName: identifier(value.toolName, 'action.toolName'),
    arguments: value.arguments,
    requestedPermissions: value.requestedPermissions as NonNullable<ActionSnapshotInput['requestedPermissions']>,
  })
}

/** Hash exactly the canonical immutable action snapshot with a versioned domain separator. */
export function hashAction(action: ActionSnapshot): string {
  return digest(ACTION_HASH_DOMAIN, parseActionSnapshot(action))
}

/** Bind one review identity, Reviewer identity, and deadline to an action snapshot. */
export function createApprovalRequest(action: ActionSnapshot, options: CreateApprovalRequestOptions): ApprovalRequest {
  const parsedAction = parseActionSnapshot(action)
  const issuedAt = timestamp(options.issuedAt, 'request.issuedAt')
  const deadlineAt = timestamp(options.deadlineAt, 'request.deadlineAt')
  if (deadlineAt <= issuedAt) throw new TypeError('request.deadlineAt must be after issuedAt')
  return Object.freeze({
    protocolVersion: APPROVAL_PROTOCOL_VERSION,
    reviewId: identifier(options.reviewId ?? randomUUID(), 'request.reviewId'),
    parentSessionId: identifier(options.parentSessionId, 'request.parentSessionId'),
    reviewerSessionId: identifier(options.reviewerSessionId, 'request.reviewerSessionId'),
    generation: identifier(options.generation, 'request.generation'),
    ...options.callId === undefined ? {} : { callId: identifier(options.callId, 'request.callId') },
    ...options.reason === undefined ? {} : { reason: boundedString(options.reason, 'request.reason', 8192) },
    actionHash: hashAction(parsedAction),
    issuedAt,
    deadlineAt,
    action: parsedAction,
  })
}

/** Parse a request and recompute its action hash instead of trusting the payload. */
export function parseApprovalRequest(input: unknown): ApprovalRequest {
  const value = record(input, 'request')
  exactKeys(
    value,
    ['protocolVersion', 'reviewId', 'parentSessionId', 'reviewerSessionId', 'generation', 'actionHash', 'issuedAt', 'deadlineAt', 'action'],
    ['callId', 'reason'],
    'request',
  )
  if (value.protocolVersion !== 1) throw new TypeError('request.protocolVersion must be 1')
  const action = parseActionSnapshot(value.action)
  const request = createApprovalRequest(action, {
    reviewId: identifier(value.reviewId, 'request.reviewId'),
    parentSessionId: identifier(value.parentSessionId, 'request.parentSessionId'),
    reviewerSessionId: identifier(value.reviewerSessionId, 'request.reviewerSessionId'),
    generation: identifier(value.generation, 'request.generation'),
    ...value.callId === undefined ? {} : { callId: identifier(value.callId, 'request.callId') },
    ...value.reason === undefined ? {} : { reason: boundedString(value.reason, 'request.reason', 8192) },
    issuedAt: timestamp(value.issuedAt, 'request.issuedAt'),
    deadlineAt: timestamp(value.deadlineAt, 'request.deadlineAt'),
  })
  if (hash(value.actionHash, 'request.actionHash') !== request.actionHash) {
    throw new TypeError('request.actionHash does not match request.action')
  }
  return request
}

/** Parse the only model-owned terminal payload accepted by the plugin. */
export function parseApprovalDecision(input: unknown): ApprovalDecision {
  const value = record(input, 'decision')
  exactKeys(
    value,
    ['protocolVersion', 'reviewId', 'parentSessionId', 'reviewerSessionId', 'generation', 'actionHash', 'decision', 'risk', 'categories', 'userAuthorization', 'rationale'],
    [],
    'decision',
  )
  if (value.protocolVersion !== APPROVAL_PROTOCOL_VERSION) {
    throw new TypeError(`decision.protocolVersion must be ${APPROVAL_PROTOCOL_VERSION}`)
  }
  if (!Array.isArray(value.categories) || value.categories.length > 16) {
    throw new TypeError('decision.categories must be an array with at most 16 entries')
  }
  const categories = Object.freeze(value.categories.map((category, index) =>
    identifier(category, `decision.categories[${index}]`)))
  return Object.freeze({
    protocolVersion: APPROVAL_PROTOCOL_VERSION,
    reviewId: identifier(value.reviewId, 'decision.reviewId'),
    parentSessionId: identifier(value.parentSessionId, 'decision.parentSessionId'),
    reviewerSessionId: identifier(value.reviewerSessionId, 'decision.reviewerSessionId'),
    generation: identifier(value.generation, 'decision.generation'),
    actionHash: hash(value.actionHash, 'decision.actionHash'),
    decision: member(value.decision, DECISIONS, 'decision.decision'),
    risk: member(value.risk, RISKS, 'decision.risk'),
    categories,
    userAuthorization: member(value.userAuthorization, AUTHORIZATIONS, 'decision.userAuthorization'),
    rationale: boundedString(value.rationale, 'decision.rationale', 4096),
  })
}

/** Build the complete next-turn payload delivered through the managed Controller. */
export function approvalRequestContent(request: ApprovalRequest): readonly ReviewerTextBlock[] {
  return Object.freeze([Object.freeze({
    type: 'text' as const,
    text: [
      'Review the following immutable approval request.',
      'Return exactly one terminal result through the approval decision tool.',
      canonicalJson(request),
    ].join('\n'),
  })])
}

/** Map a validated Reviewer decision to the DSH answerer behavior. */
export function resolveApprovalDecision(decision: ApprovalDecision, mode: ReviewMode): ApprovalResolution {
  switch (decision.decision) {
    case 'allow': return { kind: 'outcome', outcome: 'allowed-once' }
    case 'deny': return { kind: 'outcome', outcome: 'rejected' }
    case 'human_review': return mode === 'auto-then-user'
      ? { kind: 'delegate' }
      : { kind: 'outcome', outcome: 'rejected' }
  }
}
