import z from '@deepseek-ai/schemastery'
import { createReviewerProviderData } from './domain/protocol.js'
import type {
  ReviewMode,
  ReviewerConfiguration,
  ReviewerProviderDataV1,
} from './domain/protocol.js'
import type {
  TrustEnvelopeConfigV1,
  TrustEnvelopeToolFamily,
} from './approval-gate/trust-envelope.js'
import type { ApprovalToolCatalog } from './approval-gate/catalog.js'

const TRUST_ENVELOPE_TOOLS: readonly TrustEnvelopeToolFamily[] = [
  'bash', 'filesystem', 'patch', 'network', 'process', 'mcp', 'other',
]

/** Stable Cordis plugin identity. */
export const name = 'dsh-approve-for-me'

/**
 * Cordis service injects. All four services are REQUIRED: a missing service
 * means this plugin cannot mount, never a silently degraded Reviewer.
 */
export const inject = ['managedAgents', 'tools', 'systemPrompt', 'approval'] as const

/**
 * Serializable plugin configuration (YAML/JSON-loader expressible). Code-level
 * behavior such as the permission projector stays out of this schema and is
 * supplied through the programmatic install port.
 */
export interface Config {
  readonly mode?: 'auto' | 'auto-then-user'
  readonly timeoutMs?: number
  readonly maxReviewsPerChild?: number
  readonly trustEnvelope?: Partial<TrustEnvelopeConfigV1>
  readonly toolCatalog?: ApprovalToolCatalog
  readonly reviewer: {
    readonly generation: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly policyVersion: string
    readonly toolsetVersion: 1
  }
}

export const Config: z<Config> = z.object({
  mode: z.union(['auto', 'auto-then-user'] as const).default('auto'),
  timeoutMs: z.number().default(30_000),
  maxReviewsPerChild: z.number().min(1),
  // Full structural schema is enforced in normalizeConfig/TrustEnvelopeConfigV1;
  // keep the loader schema permissive so YAML partials remain expressible.
  trustEnvelope: z.any(),
  toolCatalog: z.any(),
  reviewer: z.object({
    generation: z.string().min(1).required(),
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    // Schemastery object properties are optional by default; only optional
    // fields are declared without `.required()`.
    reasoningEffort: z.string(),
    policyVersion: z.string().min(1).required(),
    toolsetVersion: z.const(1).required(),
  }),
})

export interface NormalizedConfig {
  readonly mode: ReviewMode
  readonly timeoutMs: number
  readonly maxReviewsPerChild: number
  readonly trustEnvelope: TrustEnvelopeConfigV1
  readonly toolCatalog: ApprovalToolCatalog
  readonly preset: ReviewerProviderDataV1
}

const DEFAULT_MAX_REVIEWS_PER_CHILD = 64

const ZERO_HASH = `sha256:${'0'.repeat(64)}`

const DEFAULT_TOOL_CATALOG: ApprovalToolCatalog = Object.freeze({
  version: 1,
  argumentSemanticsId: 'default-v1',
  fingerprint: ZERO_HASH,
  descriptors: Object.freeze([]),
})

function normalizeToolCatalog(input?: ApprovalToolCatalog): ApprovalToolCatalog {
  if (input === undefined) return DEFAULT_TOOL_CATALOG
  if (input.version !== 1) throw new TypeError('toolCatalog.version must be 1')
  if (!Array.isArray(input.descriptors)) throw new TypeError('toolCatalog.descriptors must be an array')
  const names = new Set<string>()
  for (const descriptor of input.descriptors) {
    if (typeof descriptor.toolName !== 'string' || descriptor.toolName.length === 0) {
      throw new TypeError('toolCatalog descriptor.toolName must be a non-empty string')
    }
    if (names.has(descriptor.toolName)) throw new TypeError(`duplicate toolCatalog descriptor "${descriptor.toolName}"`)
    names.add(descriptor.toolName)
    if (typeof descriptor.toolSchemaFingerprint !== 'string' || descriptor.toolSchemaFingerprint.length === 0) {
      throw new TypeError('toolCatalog descriptor.toolSchemaFingerprint must be a non-empty string')
    }
  }
  return Object.freeze({
    version: 1,
    argumentSemanticsId: input.argumentSemanticsId,
    fingerprint: input.fingerprint,
    descriptors: Object.freeze([...input.descriptors]),
  })
}

const DEFAULT_TRUST_ENVELOPE: Readonly<TrustEnvelopeConfigV1> = Object.freeze({
  version: 1,
  enabled: false,
  tools: Object.freeze([]),
  maxRequestedMode: 'read-only',
  workspaceOnly: true,
  requireJustification: false,
  requireStrictWidening: false,
})

function normalizeTrustEnvelope(input?: Partial<TrustEnvelopeConfigV1>): TrustEnvelopeConfigV1 {
  const enabled = input?.enabled ?? DEFAULT_TRUST_ENVELOPE.enabled
  const tools = input?.tools ?? DEFAULT_TRUST_ENVELOPE.tools
  const maxRequestedMode = input?.maxRequestedMode ?? DEFAULT_TRUST_ENVELOPE.maxRequestedMode
  const workspaceOnly = input?.workspaceOnly ?? DEFAULT_TRUST_ENVELOPE.workspaceOnly
  const requireJustification = input?.requireJustification ?? DEFAULT_TRUST_ENVELOPE.requireJustification
  const requireStrictWidening = input?.requireStrictWidening ?? DEFAULT_TRUST_ENVELOPE.requireStrictWidening
  if (typeof enabled !== 'boolean') throw new TypeError('trustEnvelope.enabled must be a boolean')
  if (typeof workspaceOnly !== 'boolean') throw new TypeError('trustEnvelope.workspaceOnly must be a boolean')
  if (typeof requireJustification !== 'boolean') throw new TypeError('trustEnvelope.requireJustification must be a boolean')
  if (typeof requireStrictWidening !== 'boolean') throw new TypeError('trustEnvelope.requireStrictWidening must be a boolean')
  if (maxRequestedMode !== 'read-only' && maxRequestedMode !== 'workspace-write') {
    throw new TypeError('trustEnvelope.maxRequestedMode must be "read-only" or "workspace-write"')
  }
  if (!Array.isArray(tools) || tools.some(tool => !TRUST_ENVELOPE_TOOLS.includes(tool))) {
    throw new TypeError('trustEnvelope.tools contains an unknown tool family')
  }
  return Object.freeze({
    version: 1,
    enabled,
    tools: Object.freeze([...tools]),
    maxRequestedMode,
    workspaceOnly,
    requireJustification,
    requireStrictWidening,
  })
}

/** Validate and normalize loader config before any provider registration. */
export function normalizeConfig(config: Config): NormalizedConfig {
  const mode = config.mode ?? 'auto'
  if (mode !== 'auto' && mode !== 'auto-then-user') {
    throw new TypeError('mode must be "auto" or "auto-then-user"')
  }
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer')
  }
  const maxReviewsPerChild = config.maxReviewsPerChild ?? DEFAULT_MAX_REVIEWS_PER_CHILD
  if (!Number.isSafeInteger(maxReviewsPerChild) || maxReviewsPerChild < 1) {
    throw new TypeError('maxReviewsPerChild must be a positive safe integer')
  }
  const reviewerConfig: ReviewerConfiguration = {
    generation: config.reviewer.generation,
    modelRoute: {
      providerId: config.reviewer.provider,
      modelId: config.reviewer.model,
      ...config.reviewer.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: config.reviewer.reasoningEffort },
    },
    policyVersion: config.reviewer.policyVersion,
    toolsetVersion: config.reviewer.toolsetVersion,
  }
  return Object.freeze({
    mode,
    timeoutMs,
    maxReviewsPerChild,
    trustEnvelope: normalizeTrustEnvelope(config.trustEnvelope),
    toolCatalog: normalizeToolCatalog(config.toolCatalog),
    preset: createReviewerProviderData(reviewerConfig),
  })
}
