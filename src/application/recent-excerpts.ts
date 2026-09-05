import { canonicalJson } from '../domain/json.js'

/**
 * Bounded recent-transcript excerpt channel (WP4-b4-2a).
 *
 * A Reviewer needs to see the human intent behind an approval ask, but the
 * sealed ledger deliberately carries no user text. This module assembles a
 * bounded, deterministic, seq-ordered list of recent human `user/message`
 * excerpts around the ask. It is an *intent-understanding aid* only: it never
 * replaces the current action facts, never carries tool-result content, LLM
 * output, or resolvable event/session IDs, and a missing or over-budget
 * excerpt set simply degrades to no excerpts (never a failed authorization).
 *
 * Placement mirrors `sealedCurrentCatalogInForce` (a pure, bounded,
 * eventAt-driven function) so it stays unit-testable without a live Session.
 */

/** One ordered recent human user-excerpt; `text` is user-authored natural language only. */
export interface RecentExcerptV1 {
  readonly seq: number
  readonly text: string
}

/** The minimal session-event view the assembler needs (the DSH adapter's eventAt view). */
export interface RecentExcerptEventView {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}

export interface RecentExcerptsResult {
  /** Ordered ascending by seq, each under the byte budget, keep-newest semantics. */
  readonly excerpts: readonly RecentExcerptV1[]
  /** # candidate human-user excerpts dropped for the byte budget (keep-newest). */
  readonly truncated: number
  /** # user/message events rejected as non-human source or with no extractable text. */
  readonly stripped: number
}

export interface AssembleRecentExcerptsInput {
  /** The event seq of the approval/asked boundary; only events before it are scanned. */
  readonly askedSeq: number
  /** Total UTF-8 byte budget for the assembled excerpt set (config `maxRecentExcerptBytes`). */
  readonly maxRecentExcerptBytes: number
  /** Bounded back-scan window upper bound; defaults to `DEFAULT_MAX_RECENT_EXCERPT_EVENTS`. */
  readonly maxRecentExcerptEvents?: number
  readonly eventAt: (seq: number) => RecentExcerptEventView | undefined
}

/**
 * The back-scan window upper bound, defaulting to the same order as
 * `maxSealedTailEvents`. It is deliberately an independent parameter: excerpt
 * intent retention is a Reviewer-visibility tuning knob, not seal-tail
 * capacity, so it can be changed without affecting the seal budget (or vice
 * versa). 512 events is the same conservative order as the seal tail and keeps
 * a single approval hot path to an O(window) scan.
 */
export const DEFAULT_MAX_RECENT_EXCERPT_EVENTS = 512

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

/** Strip ASCII C0 control characters (except whitespace) and DEL for safe text. */
function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
}

/** Deterministic UTF-8 bytes of the projected `{seq, text}` excerpt entry. */
function excerptBytes(entry: RecentExcerptV1): number {
  return new TextEncoder().encode(canonicalJson(entry)).byteLength
}

/**
 * Extract the human-user natural-language text from a `user/message` event, or
 * undefined when the event is not a direct human user message (tool, model,
 * plugin / instructions injection) or yields no extractable text. Only `text`
 * content blocks are read: tool-result bodies, tool-call argument JSON, LLM
 * reasoning, IDs (message.id, data.id, callId, sessionId) are never copied.
 */
export function extractUserText(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const payload = data as Record<string, unknown>
  const source = payload.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  if ((source as Record<string, unknown>).kind !== 'user') return undefined
  const content = payload.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const candidate = block as Record<string, unknown>
    if (candidate.type !== 'text') continue
    if (typeof candidate.text !== 'string') continue
    const piece = sanitizeText(candidate.text)
    if (piece.length === 0) continue
    parts.push(piece)
  }
  if (parts.length === 0) return undefined
  return parts.join(' ')
}

/**
 * Assemble the bounded recent-transcript excerpt set for one ask. Deterministic:
 * the same `eventAt` mapping yields the same output. Total (never throws) so a
 * malformed Session never escapes the hot path — any unexpected shape yields an
 * empty result. Budget enforcement follows keep-newest semantics over the total
 * byte budget: the newest excerpt is retained first and the oldest that do not
 * fit are dropped (counted in `truncated`). Dropping is safe because an excerpt
 * is an intent aid, not an authorization fact — it cannot amplify permissions.
 */
export function assembleRecentExcerpts(input: AssembleRecentExcerptsInput): RecentExcerptsResult {
  const { askedSeq, maxRecentExcerptBytes, eventAt } = input
  const window = input.maxRecentExcerptEvents ?? DEFAULT_MAX_RECENT_EXCERPT_EVENTS
  if (!nonNegativeSafeInteger(askedSeq) || !nonNegativeSafeInteger(maxRecentExcerptBytes)
    || !nonNegativeSafeInteger(window) || typeof eventAt !== 'function') {
    return { excerpts: Object.freeze([]), truncated: 0, stripped: 0 }
  }
  const start = Math.max(0, askedSeq - window)
  const candidates: RecentExcerptV1[] = []
  let stripped = 0
  try {
    for (let seq = start; seq < askedSeq; seq += 1) {
      const event = eventAt(seq)
      if (event === undefined || event.type !== 'user/message') continue
      const text = extractUserText(event.data)
      if (text === undefined) {
        stripped += 1
        continue
      }
      candidates.push(Object.freeze({ seq, text }))
    }
  } catch {
    // A live eventAt must never break the approval hot path; degrade to empty.
    return { excerpts: Object.freeze([]), truncated: 0, stripped: 0 }
  }
  const selected: RecentExcerptV1[] = []
  let total = 0
  let truncated = 0
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index]!
    const bytes = excerptBytes(entry)
    if (bytes > maxRecentExcerptBytes || total + bytes > maxRecentExcerptBytes) {
      truncated += 1
      continue
    }
    selected.push(entry)
    total += bytes
  }
  selected.reverse()
  return { excerpts: Object.freeze(selected), truncated, stripped }
}
