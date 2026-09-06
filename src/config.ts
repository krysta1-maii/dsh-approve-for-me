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
import { fingerprintApprovalToolCatalogV1 } from './approval-gate/catalog.js'
import type { ApprovalToolCatalog } from './approval-gate/catalog.js'
import { DEFAULT_MAX_SEALED_HISTORY_WINDOW } from './domain/sealed-facts.js'
import { DEFAULT_MAX_AUTHORIZATION_ENTRIES } from './domain/authorization-ledger.js'
import { DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS } from './application/authorization-verification.js'
import { validateCaseCaptureConfig } from './domain/records.js'
import type { GuardianCaseCaptureConfigV1 } from './domain/records.js'

const TRUST_ENVELOPE_TOOLS: readonly TrustEnvelopeToolFamily[] = [
  'bash', 'filesystem', 'patch', 'network', 'process', 'mcp', 'other',
]

/** Stable Cordis plugin identity. */
export const name = 'dsh-approve-for-me'

/** User-settings namespace surfaced by the AFM plugin configuration card. */
export const APPROVE_FOR_ME_SETTINGS_NAMESPACE = 'dsh-approve-for-me'

/** The currently user-configurable Reviewer route. */
export interface ApproveForMeSettings {
  readonly reviewer: {
    readonly provider: string
    readonly model: string
  }
}

/** Wire-visible settings schema; private deployment policy stays in loader config. */
export const ApproveForMeSettings: z<ApproveForMeSettings> = z.object({
  reviewer: z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
  }).required(),
})

/** Project the loader entry onto the subset users may edit live. */
export function reviewerSettingsFromConfig(config: Config): ApproveForMeSettings {
  return Object.freeze({
    reviewer: Object.freeze({
      provider: config.reviewer.provider,
      model: config.reviewer.model,
    }),
  })
}

/**
 * Apply a settings-selected route without carrying an incompatible deployment
 * reasoning effort onto a different model. Returning to the deployment route
 * restores its configured effort.
 */
export function configWithReviewerSettings(
  config: Config,
  settings: ApproveForMeSettings,
): Config {
  const sameDeploymentRoute = settings.reviewer.provider === config.reviewer.provider
    && settings.reviewer.model === config.reviewer.model
  const { reasoningEffort: deploymentEffort, ...reviewer } = config.reviewer
  return {
    ...config,
    reviewer: {
      ...reviewer,
      provider: settings.reviewer.provider,
      model: settings.reviewer.model,
      ...sameDeploymentRoute && deploymentEffort !== undefined
        ? { reasoningEffort: deploymentEffort }
        : {},
    },
  }
}

/**
 * Cordis service injects. Every listed service is REQUIRED: a missing service
 * means this plugin cannot mount, never a silently degraded Reviewer.
 */
export const inject = ['agents', 'managedAgents', 'tools', 'systemPrompt', 'approval', 'storageDomain', 'llm'] as const

/**
 * Serializable plugin configuration (YAML/JSON-loader expressible). Code-level
 * behavior such as the permission projector stays out of this schema and is
 * supplied through the programmatic install port.
 */
export interface Config {
  readonly mode?: 'auto' | 'auto-then-user'
  readonly timeoutMs?: number
  readonly maxDeliveryAttemptsPerChild?: number
  /** Maximum UTF-8 bytes of a complete serialized Guardian dossier. */
  readonly maxDossierBytes?: number
  /** Maximum unanchored sealed events admitted to an approval hot path (default matches the ledger gate at 256; WP6-b4). */
  readonly maxSealedTailEvents?: number
  /** Maximum ledger entries admitted to an approval hot packet (default matches the sealed tail window at 256; WP6-b4). */
  readonly maxLedgerEntries?: number
  /** Maximum bytes of the recent transcript excerpt admitted to an approval hot packet. */
  readonly maxRecentExcerptBytes?: number
  /** Maximum bytes of a prebuilt approval hot packet. */
  readonly maxHotPacketBytes?: number
  /**
   * Idle authorization-extractor switch (WP7 decision 6). `enabled: false`
   * disables idle extraction only; the approval-time synchronous tail
   * extraction still runs.
   */
  readonly authorizationExtractor?: { readonly enabled?: boolean }
  /** Maximum authorization drawer entries admitted to an approval hot packet (default 64; WP7-c2a). */
  readonly maxAuthorizationEntries?: number
  /** Maximum user/message events consumed by one incremental authorization extraction (default 256; WP7 decision 6). */
  readonly maxAuthorizationExtractionEvents?: number
  /**
   * Phase-three background-once seal backfill (WP8-c). When true, an idle root
   * session (turn/end observed, no in-flight approval run) triggers one
   * backfill attempt per lifecycle per process; it re-runs the full
   * wire/catalog/projector verification and stops on the first failure, so an
   * unbackfilled lifecycle simply stays unsealed (fail closed). It never makes
   * an unsealed session automatically approvable. Default false.
   */
  readonly sealBackfill?: boolean
  /**
   * WP9-b fact retention (default true). When enabled, a bounded sweep prunes
   * fact rows of ended session lifecycles once their grace window closes.
   * The audit spine (sealed ledger, authorization drawer, decision records)
   * is never pruned, and every doubt skips (fail closed).
   */
  readonly factRetention?: boolean
  /** WP9-b: retention grace measured from the observed lifecycle end (default 24h). */
  readonly factRetentionGraceMs?: number
  /** WP9-b: maximum lifecycles examined by one sweep, oldest ended first (default 8). */
  readonly factRetentionSweepLimit?: number
  readonly trustEnvelope?: Partial<TrustEnvelopeConfigV1>
  readonly toolCatalog?: ApprovalToolCatalog
  readonly caseCapture?: GuardianCaseCaptureConfigV1
  /**
   * WP10-a genesis first-approval review (default true). When enabled, a sealed
   * ledger whose lifecycle was never initialized (zero chain rows) reads as a
   * legal genesis state and the first approval goes to machine review with an
   * empty sealed history. When false, the legacy behavior is preserved
   * byte-for-byte: an empty ledger surfaces sealed-current-missing and routes
   * to the human waterfall in auto-then-user mode (rollback channel).
   */
  readonly genesisReview?: boolean
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
  maxDeliveryAttemptsPerChild: z.number().min(1),
  maxDossierBytes: z.number().min(1),
  maxSealedTailEvents: z.number().min(1),
  maxLedgerEntries: z.number().min(1),
  maxRecentExcerptBytes: z.number().min(1),
  maxHotPacketBytes: z.number().min(1).max(256_000),
  // Structural validation lives in normalizeConfig; keep the loader schema
  // permissive so YAML partials remain expressible.
  authorizationExtractor: z.any(),
  maxAuthorizationEntries: z.number().min(1),
  maxAuthorizationExtractionEvents: z.number().min(1),
  sealBackfill: z.boolean(),
  factRetention: z.boolean(),
  factRetentionGraceMs: z.number().min(1),
  factRetentionSweepLimit: z.number().min(1),
  // Full structural schema is enforced in normalizeConfig/TrustEnvelopeConfigV1;
  // keep the loader schema permissive so YAML partials remain expressible.
  trustEnvelope: z.any(),
  toolCatalog: z.any(),
  caseCapture: z.any(),
  genesisReview: z.boolean(),
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
  readonly maxDeliveryAttemptsPerChild: number
  readonly maxDossierBytes: number
  readonly maxSealedTailEvents: number
  readonly maxLedgerEntries: number
  readonly maxRecentExcerptBytes: number
  readonly maxHotPacketBytes: number
  readonly authorizationExtractorEnabled: boolean
  readonly maxAuthorizationEntries: number
  readonly maxAuthorizationExtractionEvents: number
  readonly sealBackfill: boolean
  readonly factRetention: boolean
  readonly factRetentionGraceMs: number
  readonly factRetentionSweepLimit: number
  readonly trustEnvelope: TrustEnvelopeConfigV1
  readonly toolCatalog: ApprovalToolCatalog
  readonly caseCapture: GuardianCaseCaptureConfigV1
  readonly genesisReview: boolean
  readonly preset: ReviewerProviderDataV1
}

const DEFAULT_MAX_DELIVERY_ATTEMPTS_PER_CHILD = 64
/** Conservative envelope for the serialized full v1 dossier; deployments may lower it. */
const DEFAULT_MAX_DOSSIER_BYTES = 256_000
// WP6-b4: the sealed-tail read window and the sealed-ledger row gate MUST agree
// so the resolver never reads more history than the compiler can gate (b1 measured
// the 512>256 default split). Both defaults resolve to the single source below.
const DEFAULT_MAX_SEALED_TAIL_EVENTS = DEFAULT_MAX_SEALED_HISTORY_WINDOW
const DEFAULT_MAX_LEDGER_ENTRIES = DEFAULT_MAX_SEALED_HISTORY_WINDOW
const DEFAULT_MAX_RECENT_EXCERPT_BYTES = 24_000
const DEFAULT_MAX_HOT_PACKET_BYTES = 96_000
// WP7-c2a: the reader validates the entire drawer and the dossier-compiler
// authorization row gate fails closed (ledger-budget-overflow) above this
// bound — never a silent truncation. The default resolves to the domain
// single source.
const DEFAULT_MAX_AUTHORIZATION_DRAWER_ENTRIES = DEFAULT_MAX_AUTHORIZATION_ENTRIES
// WP7 decision 6: one incremental extraction consumes at most this many
// user/message events; single-sourced with authorization-verification.ts.
const DEFAULT_AUTHORIZATION_EXTRACTION_EVENTS = DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS
// WP9-b: a lifecycle ended longer than this ago (and carrying no doubt)
// becomes eligible for the fact-retention prune.
const DEFAULT_FACT_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000
// WP9-b: one sweep examines at most this many lifecycles, oldest ended first.
const DEFAULT_FACT_RETENTION_SWEEP_LIMIT = 8

const DEFAULT_TOOL_CATALOG: ApprovalToolCatalog = (() => {
  const unsealed = {
    version: 1 as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: '',
    descriptors: Object.freeze([]),
  }
  return Object.freeze({ ...unsealed, fingerprint: fingerprintApprovalToolCatalogV1(unsealed)! })
})()

const DEFAULT_CASE_CAPTURE: Readonly<GuardianCaseCaptureConfigV1> = Object.freeze({
  mode: 'off',
  maxCases: 100,
  maxArtifactBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
  retentionDays: 30,
})

function normalizeCaseCapture(input?: GuardianCaseCaptureConfigV1): GuardianCaseCaptureConfigV1 {
  const config = input ?? DEFAULT_CASE_CAPTURE
  validateCaseCaptureConfig(config)
  return Object.freeze({ ...config })
}

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
    if (typeof descriptor.actionSemanticsFamily !== 'string' || descriptor.actionSemanticsFamily.length === 0) {
      throw new TypeError('toolCatalog descriptor.actionSemanticsFamily must be a non-empty string')
    }
    if (typeof descriptor.actionProjectorId !== 'string' || descriptor.actionProjectorId.length === 0) {
      throw new TypeError('toolCatalog descriptor.actionProjectorId must be a non-empty string')
    }
  }
  const normalized = {
    version: 1 as const,
    argumentSemanticsId: input.argumentSemanticsId,
    fingerprint: input.fingerprint,
    descriptors: Object.freeze(input.descriptors.map(descriptor => Object.freeze({
      toolName: descriptor.toolName,
      toolSchemaFingerprint: descriptor.toolSchemaFingerprint,
      classification: descriptor.classification,
      actionSemanticsFamily: descriptor.actionSemanticsFamily,
      actionProjectorId: descriptor.actionProjectorId,
    }))),
  }
  const expectedFingerprint = fingerprintApprovalToolCatalogV1(normalized)
  if (expectedFingerprint === undefined || input.fingerprint !== expectedFingerprint) {
    throw new TypeError('toolCatalog.fingerprint must match the canonical catalog commitment')
  }
  return Object.freeze(normalized)
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
  const maxDeliveryAttemptsPerChild = config.maxDeliveryAttemptsPerChild ?? DEFAULT_MAX_DELIVERY_ATTEMPTS_PER_CHILD
  if (!Number.isSafeInteger(maxDeliveryAttemptsPerChild) || maxDeliveryAttemptsPerChild < 1) {
    throw new TypeError('maxDeliveryAttemptsPerChild must be a positive safe integer')
  }
  const maxDossierBytes = config.maxDossierBytes ?? DEFAULT_MAX_DOSSIER_BYTES
  if (!Number.isSafeInteger(maxDossierBytes) || maxDossierBytes < 1) {
    throw new TypeError('maxDossierBytes must be a positive safe integer')
  }
  if (Object.hasOwn(config as object, 'maxSourceEvents')) {
    throw new TypeError('maxSourceEvents has been removed; the approval hot path is protected by sealed-tail and ledger budgets')
  }
  const maxSealedTailEvents = config.maxSealedTailEvents ?? DEFAULT_MAX_SEALED_TAIL_EVENTS
  if (!Number.isSafeInteger(maxSealedTailEvents) || maxSealedTailEvents < 1) {
    throw new TypeError('maxSealedTailEvents must be a positive safe integer')
  }
  const maxLedgerEntries = config.maxLedgerEntries ?? DEFAULT_MAX_LEDGER_ENTRIES
  if (!Number.isSafeInteger(maxLedgerEntries) || maxLedgerEntries < 1) {
    throw new TypeError('maxLedgerEntries must be a positive safe integer')
  }
  const maxRecentExcerptBytes = config.maxRecentExcerptBytes ?? DEFAULT_MAX_RECENT_EXCERPT_BYTES
  if (!Number.isSafeInteger(maxRecentExcerptBytes) || maxRecentExcerptBytes < 1) {
    throw new TypeError('maxRecentExcerptBytes must be a positive safe integer')
  }
  const maxHotPacketBytes = config.maxHotPacketBytes ?? DEFAULT_MAX_HOT_PACKET_BYTES
  if (!Number.isSafeInteger(maxHotPacketBytes) || maxHotPacketBytes < 1 || maxHotPacketBytes > DEFAULT_MAX_DOSSIER_BYTES) {
    throw new TypeError(`maxHotPacketBytes must be a positive safe integer no greater than ${DEFAULT_MAX_DOSSIER_BYTES}`)
  }
  const extractorConfig = config.authorizationExtractor
  if (extractorConfig !== undefined
    && (extractorConfig === null || typeof extractorConfig !== 'object' || Array.isArray(extractorConfig))) {
    throw new TypeError('authorizationExtractor must be an object')
  }
  const authorizationExtractorEnabled = extractorConfig?.enabled ?? true
  if (typeof authorizationExtractorEnabled !== 'boolean') {
    throw new TypeError('authorizationExtractor.enabled must be a boolean')
  }
  const maxAuthorizationEntries = config.maxAuthorizationEntries ?? DEFAULT_MAX_AUTHORIZATION_DRAWER_ENTRIES
  if (!Number.isSafeInteger(maxAuthorizationEntries) || maxAuthorizationEntries < 1) {
    throw new TypeError('maxAuthorizationEntries must be a positive safe integer')
  }
  const maxAuthorizationExtractionEvents = config.maxAuthorizationExtractionEvents ?? DEFAULT_AUTHORIZATION_EXTRACTION_EVENTS
  if (!Number.isSafeInteger(maxAuthorizationExtractionEvents) || maxAuthorizationExtractionEvents < 1) {
    throw new TypeError('maxAuthorizationExtractionEvents must be a positive safe integer')
  }
  // WP8-c: sealBackfill unfreezes into a real boolean (default false). The
  // loader schema already enforces z.boolean(); normalize repeats the check
  // for programmatic compositions.
  const sealBackfill = config.sealBackfill ?? false
  if (typeof sealBackfill !== 'boolean') {
    throw new TypeError('sealBackfill must be a boolean')
  }
  // WP9-b: fact retention knobs, fail-closed validated. An invalid value must
  // never silently disable (or unboundedly enable) pruning.
  const factRetention = config.factRetention ?? true
  if (typeof factRetention !== 'boolean') {
    throw new TypeError('factRetention must be a boolean')
  }
  const factRetentionGraceMs = config.factRetentionGraceMs ?? DEFAULT_FACT_RETENTION_GRACE_MS
  if (!Number.isSafeInteger(factRetentionGraceMs) || factRetentionGraceMs < 1) {
    throw new TypeError('factRetentionGraceMs must be a positive safe integer')
  }
  const factRetentionSweepLimit = config.factRetentionSweepLimit ?? DEFAULT_FACT_RETENTION_SWEEP_LIMIT
  if (!Number.isSafeInteger(factRetentionSweepLimit) || factRetentionSweepLimit < 1) {
    throw new TypeError('factRetentionSweepLimit must be a positive safe integer')
  }
  // WP10-a: genesis first-approval review, fail-closed validated. An invalid
  // value must never silently flip the first-approval safety boundary.
  const genesisReview = config.genesisReview ?? true
  if (typeof genesisReview !== 'boolean') {
    throw new TypeError('genesisReview must be a boolean')
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
    maxDeliveryAttemptsPerChild,
    maxDossierBytes,
    maxSealedTailEvents,
    maxLedgerEntries,
    maxRecentExcerptBytes,
    maxHotPacketBytes,
    authorizationExtractorEnabled,
    maxAuthorizationEntries,
    maxAuthorizationExtractionEvents,
    sealBackfill,
    factRetention,
    factRetentionGraceMs,
    factRetentionSweepLimit,
    trustEnvelope: normalizeTrustEnvelope(config.trustEnvelope),
    toolCatalog: normalizeToolCatalog(config.toolCatalog),
    caseCapture: normalizeCaseCapture(config.caseCapture),
    genesisReview,
    preset: createReviewerProviderData(reviewerConfig),
  })
}
