import { createHash } from 'node:crypto'
import { canonicalJson } from './json.js'
import { MAX_AUTHORIZATION_QUOTE_BYTES, MAX_AUTHORIZATION_SUMMARY_BYTES } from './authorization-ledger.js'
import type { AuthorizationCoverageV1, AuthorizationEffectV1 } from './authorization-ledger.js'
import type { ReviewerModelRoute } from './protocol.js'

/**
 * WP7-b extraction protocol: the authorization extractor is a managed child
 * with Reviewer-level isolation whose ONLY output channel is one typed
 * submission tool. The LLM is a parser over a Host-assembled verbatim window;
 * the Host remains the sole ledger writer and re-verifies every quoted line
 * against the live Session before anything is persisted
 * (authorization-verification.ts).
 */

export const EXTRACTION_PROVIDER = 'dsh-approve-for-me/authorization-extractor'
export const AUTHORIZATION_EXTRACTOR_VERSION = 'authorization-extractor-v1'
export const EXTRACTION_PROTOCOL_VERSION = 1 as const

const EXTRACTOR_CONFIG_HASH_DOMAIN = 'dsh-approve-for-me/extractor-configuration/v1\0'
const HASH = /^sha256:[0-9a-f]{64}$/

export interface ExtractorProviderDataV1 {
  readonly version: 1
  readonly role: 'extractor'
  readonly generation: string
  readonly configurationFingerprint: string
  readonly extractorVersion: string
  readonly modelRoute: ReviewerModelRoute
}

function record(input: unknown, name: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(name)
  return input as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], name: string) {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(name + '.' + key + ' is required')
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new TypeError(name + '.' + key + ' is not supported')
}

/**
 * Extractor-authored version constants arrive over an LLM tool-call boundary:
 * both weak and strong models have been observed emitting `"1"` (string) for
 * an integer const. Coerce that one exact spelling; anything else still fails
 * closed. Host-authored structures (providerData) stay strict.
 */
function versionConstant(input: unknown, label: string): 1 {
  if (input === 1 || input === '1') return 1
  throw new TypeError(label + ' must be 1')
}

function identifier(input: unknown, name: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new TypeError(name + ' must be a non-empty string')
  return input
}

function parseRoute(input: unknown): ReviewerModelRoute {
  const value = record(input, 'extractorProviderData.modelRoute')
  exactKeys(value, ['providerId', 'modelId'], ['reasoningEffort'], 'extractorProviderData.modelRoute')
  return Object.freeze({
    providerId: identifier(value.providerId, 'extractorProviderData.modelRoute.providerId'),
    modelId: identifier(value.modelId, 'extractorProviderData.modelRoute.modelId'),
    ...value.reasoningEffort === undefined ? {} : { reasoningEffort: identifier(value.reasoningEffort, 'extractorProviderData.modelRoute.reasoningEffort') },
  })
}

/** Compute the immutable extractor composition fingerprint excluding the instance generation. */
export function fingerprintExtractorConfiguration(config: { readonly modelRoute: ReviewerModelRoute; readonly extractorVersion: string }): string {
  return 'sha256:' + createHash('sha256').update(EXTRACTOR_CONFIG_HASH_DOMAIN).update(canonicalJson({ version: 1, ...config })).digest('hex')
}

/** Build trusted descriptor data for a new extractor child. */
export function createExtractorProviderData(config: {
  readonly generation: string
  readonly modelRoute: ReviewerModelRoute
  readonly extractorVersion: string
}): ExtractorProviderDataV1 {
  const generation = identifier(config.generation, 'extractorProviderData.generation')
  const modelRoute = parseRoute(config.modelRoute)
  const extractorVersion = identifier(config.extractorVersion, 'extractorProviderData.extractorVersion')
  return Object.freeze({
    version: 1,
    role: 'extractor',
    generation,
    configurationFingerprint: fingerprintExtractorConfiguration({ modelRoute, extractorVersion }),
    extractorVersion,
    modelRoute,
  })
}

/** Parse untrusted descriptor data supplied by the Managed Runtime. */
export function parseExtractorProviderData(input: unknown): ExtractorProviderDataV1 {
  const value = record(input, 'extractorProviderData')
  exactKeys(value, ['version', 'role', 'generation', 'configurationFingerprint', 'extractorVersion', 'modelRoute'], [], 'extractorProviderData')
  if (value.version !== 1) throw new TypeError('extractorProviderData.version must be 1')
  if (value.role !== 'extractor') throw new TypeError('extractorProviderData.role must be \'extractor\'')
  const parsed = createExtractorProviderData({
    generation: identifier(value.generation, 'extractorProviderData.generation'),
    modelRoute: parseRoute(value.modelRoute),
    extractorVersion: identifier(value.extractorVersion, 'extractorProviderData.extractorVersion'),
  })
  const supplied = value.configurationFingerprint
  if (typeof supplied !== 'string' || !HASH.test(supplied)) throw new TypeError('extractorProviderData.configurationFingerprint must be a sha256 digest')
  if (supplied !== parsed.configurationFingerprint) throw new TypeError('extractorProviderData.configurationFingerprint does not match the composition')
  return parsed
}

/** One extractor-proposed drawer row before Host verification (no time, no hashes, no lifecycle). */
export interface ExtractedAuthorizationCandidateV1 {
  readonly sourceSeq: number
  readonly quote: string
  readonly effect: AuthorizationEffectV1
  readonly coverage: AuthorizationCoverageV1
  readonly summary: string
}

/** The single structured submission the extractor child may ever produce. */
export interface AuthorizationExtractionSubmissionV1 {
  readonly protocolVersion: 1
  readonly extractionId: string
  readonly parentSessionId: string
  readonly extractorSessionId: string
  readonly generation: string
  readonly extractorVersion: string
  /** The window boundary the Host asked to be covered; submissions with any other value are rejected. */
  readonly throughSeq: number
  readonly entries: readonly ExtractedAuthorizationCandidateV1[]
}

const MAX_EXTRACTION_ENTRIES = 64
const EFFECTS: readonly string[] = ['grant', 'deny']
const COVERAGES: readonly string[] = ['action', 'turn', 'session']

function boundedText(input: unknown, name: string, maxBytes: number): string {
  const value = identifier(input, name)
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw new TypeError(name + ' exceeds ' + maxBytes + ' bytes')
  return value
}

function parseCandidate(input: unknown, index: number): ExtractedAuthorizationCandidateV1 {
  const name = 'submission.entries[' + index + ']'
  const value = record(input, name)
  exactKeys(value, ['sourceSeq', 'quote', 'effect', 'coverage', 'summary'], [], name)
  if (!Number.isSafeInteger(value.sourceSeq) || (value.sourceSeq as number) < 0) throw new TypeError(name + '.sourceSeq must be a non-negative safe integer')
  if (!EFFECTS.includes(value.effect as string)) throw new TypeError(name + '.effect is invalid')
  if (!COVERAGES.includes(value.coverage as string)) throw new TypeError(name + '.coverage is invalid')
  return Object.freeze({
    sourceSeq: value.sourceSeq as number,
    quote: boundedText(value.quote, name + '.quote', MAX_AUTHORIZATION_QUOTE_BYTES),
    effect: value.effect as AuthorizationEffectV1,
    coverage: value.coverage as AuthorizationCoverageV1,
    summary: boundedText(value.summary, name + '.summary', MAX_AUTHORIZATION_SUMMARY_BYTES),
  })
}

export function parseAuthorizationExtractionSubmissionV1(input: unknown): AuthorizationExtractionSubmissionV1 {
  const value = record(input, 'submission')
  exactKeys(value, ['protocolVersion', 'extractionId', 'parentSessionId', 'extractorSessionId', 'generation', 'extractorVersion', 'throughSeq', 'entries'], [], 'submission')
  versionConstant(value.protocolVersion, 'submission.protocolVersion')
  if (!Number.isSafeInteger(value.throughSeq) || (value.throughSeq as number) < 0) throw new TypeError('submission.throughSeq must be a non-negative safe integer')
  if (!Array.isArray(value.entries) || value.entries.length > MAX_EXTRACTION_ENTRIES) throw new TypeError('submission.entries must be an array of at most 64 items')
  return Object.freeze({
    protocolVersion: 1,
    extractionId: identifier(value.extractionId, 'submission.extractionId'),
    parentSessionId: identifier(value.parentSessionId, 'submission.parentSessionId'),
    extractorSessionId: identifier(value.extractorSessionId, 'submission.extractorSessionId'),
    generation: identifier(value.generation, 'submission.generation'),
    extractorVersion: identifier(value.extractorVersion, 'submission.extractorVersion'),
    throughSeq: value.throughSeq as number,
    entries: Object.freeze(value.entries.map((entry, index) => parseCandidate(entry, index))),
  })
}
