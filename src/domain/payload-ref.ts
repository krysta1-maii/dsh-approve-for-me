import { createHash } from 'node:crypto'
import { canonicalJson, freezeJson, snapshotJson } from './json.js'
import type { JsonValue } from './json.js'

/**
 * WP9-a: bounded payload references for durable fact records.
 *
 * Tool arguments and other unbounded payloads are stored either inline (when
 * their canonical JSON is small) or as a sha256 digest over the COMPLETE
 * canonical JSON plus a bounded UTF-8-safe prefix preview. This replaces the
 * v1 practice of storing full payload copies (and a second full canonical
 * copy as a row-level tamper check), which made every execution record
 * ~2x its payload size.
 *
 * Anti-tamper equivalence (WP9 invariant 1): every place that compared a
 * stored full payload against live data byte-for-byte now compares
 * sha256(canonicalJson(live)) against the stored digest, which is
 * byte-for-byte equivalent up to sha256 collision resistance; an inline ref
 * still compares canonical JSON directly.
 */

/** Canonical UTF-8 bytes at or below which a payload is stored inline. */
export const PAYLOAD_REF_INLINE_MAX_BYTES = 8192
/**
 * Canonical UTF-8 bytes retained as a human-readable prefix for digest refs.
 * Kept well below the inline threshold so that a record carrying several
 * digest references (action arguments + code-dispatch request arguments)
 * stays inside the WP9 invariant-5 durable size bound (~16KB per record).
 */
export const PAYLOAD_REF_PREVIEW_MAX_BYTES = 2048

const SHA256_REF_PATTERN = /^sha256:[0-9a-f]{64}$/

export interface PayloadRefInlineV1 {
  readonly kind: 'inline'
  readonly value: JsonValue
}

export interface PayloadRefDigestV1 {
  readonly kind: 'digest'
  /** 'sha256:' + 64 lowercase hex chars over the complete canonical JSON. */
  readonly sha256: string
  /** UTF-8 byte length of the complete canonical JSON. */
  readonly bytes: number
  /** First previewMaxBytes (default 2048) UTF-8 bytes of the canonical JSON. */
  readonly preview: string
  readonly truncated: true
}

export type PayloadRefV1 = PayloadRefInlineV1 | PayloadRefDigestV1

export interface PayloadRefOptions {
  readonly inlineMaxBytes?: number
  readonly previewMaxBytes?: number
}

function sha256HexCanonical(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/**
 * Digest of the canonical JSON of a value, for hash-compare equivalence with
 * former byte-for-byte stored/live comparisons. Throws on non-lossless-JSON
 * input (callers on hot paths catch and fail closed).
 */
export function canonicalSha256(value: unknown): string {
  return sha256HexCanonical(canonicalJson(value))
}

/** Truncate a string to at most maxBytes UTF-8 bytes without splitting a code point. */
function utf8SafePrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * Build a payload reference: canonical bytes <= inlineMaxBytes (default 8192)
 * stay inline; anything larger becomes a digest over the complete canonical
 * JSON with a bounded prefix preview. Throws when the value is not lossless
 * JSON.
 */
export function toPayloadRef(value: unknown, options: PayloadRefOptions = {}): PayloadRefV1 {
  const inlineMaxBytes = options.inlineMaxBytes ?? PAYLOAD_REF_INLINE_MAX_BYTES
  const previewMaxBytes = options.previewMaxBytes ?? PAYLOAD_REF_PREVIEW_MAX_BYTES
  if (!Number.isSafeInteger(inlineMaxBytes) || inlineMaxBytes < 0
    || !Number.isSafeInteger(previewMaxBytes) || previewMaxBytes < 0) {
    throw new TypeError('payload ref thresholds must be non-negative safe integers')
  }
  const canonical = canonicalJson(value)
  const bytes = Buffer.byteLength(canonical, 'utf8')
  const snapshot = freezeJson(snapshotJson(value)) as JsonValue
  if (bytes <= inlineMaxBytes) return Object.freeze({ kind: 'inline', value: snapshot })
  return Object.freeze({
    kind: 'digest',
    sha256: sha256HexCanonical(canonical),
    bytes,
    preview: utf8SafePrefix(canonical, previewMaxBytes),
    truncated: true,
  })
}

/**
 * Closed-set parse: discriminates on kind, enforces the sha256 reference
 * format, a non-negative safe byte count, and truncated === true for digest
 * refs. Shape violations make the enclosing record invalid (fail closed).
 */
export function isPayloadRefV1(value: unknown): value is PayloadRefV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  if (ref.kind === 'inline') {
    if (Object.keys(ref).length !== 2) return false
    try {
      snapshotJson(ref.value)
      return true
    } catch {
      return false
    }
  }
  if (ref.kind !== 'digest' || Object.keys(ref).length !== 5) return false
  return typeof ref.sha256 === 'string' && SHA256_REF_PATTERN.test(ref.sha256)
    && Number.isSafeInteger(ref.bytes) && (ref.bytes as number) >= 0 && !Object.is(ref.bytes, -0)
    && typeof ref.preview === 'string'
    && ref.truncated === true
}

/**
 * Byte-for-byte equivalence with the v1 stored-vs-live canonical comparison:
 * inline refs compare canonical JSON directly; digest refs require the live
 * canonical digest AND byte count to match the stored ref. Any non-JSON live
 * value or shape problem is a mismatch (fail closed), never a throw.
 */
export function payloadRefMatchesLive(ref: PayloadRefV1, liveValue: unknown): boolean {
  try {
    const canonical = canonicalJson(liveValue)
    if (ref.kind === 'inline') return canonicalJson(ref.value) === canonical
    return ref.sha256 === sha256HexCanonical(canonical)
      && ref.bytes === Buffer.byteLength(canonical, 'utf8')
  } catch {
    return false
  }
}
