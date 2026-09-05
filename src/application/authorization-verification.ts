import { parseAuthorizationEntryV1 } from '../domain/authorization-ledger.js'
import type { AuthorizationEntryV1 } from '../domain/authorization-ledger.js'
import { extractUserText } from './recent-excerpts.js'

/**
 * WP7-a Host-side verification for the authorization drawer (plan §5: "Host
 * 必须从 live Session 的 exact sourceSeq 取得原文并逐字匹配引用,否则该条目不
 * 存在"). The same functions guard both directions:
 *
 * - WRITE: an extractor-submitted batch is only persisted after every entry's
 *   quote is re-verified verbatim against the live Session (the extractor is a
 *   parser, never a fact source);
 * - READ: every drawer row entering a hot packet is re-bound to the exact live
 *   Session event, mirroring the sealed ledger's live re-bind rule (the disk
 *   chain alone is never trusted).
 *
 * Verification is all-or-nothing per call: a single unverifiable entry poisons
 * the whole batch/read so a tampered drawer can never shed its incriminating
 * rows and keep the rest.
 */

export interface AuthorizationLiveEventView {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}

export type AuthorizationEventAt = (seq: number) => AuthorizationLiveEventView | undefined

/**
 * Re-bind one parsed entry to its exact live Session event. Returns the parsed
 * entry on success, undefined when the event is missing, is not a direct human
 * user message, carries a different time, or its extracted text does not
 * contain the quote verbatim. Never throws: malformed rows and hostile event
 * shapes both degrade to undefined (missing).
 */
export function verifyAuthorizationEntryLiveV1(entry: unknown, eventAt: AuthorizationEventAt): AuthorizationEntryV1 | undefined {
  try {
    const parsed = parseAuthorizationEntryV1(entry)
    const event = eventAt(parsed.sourceSeq)
    if (event === undefined || event.seq !== parsed.sourceSeq || event.type !== 'user/message' || event.time !== parsed.occurredAt) return undefined
    const text = extractUserText(event.data)
    if (text === undefined || !text.includes(parsed.quote)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Re-bind a whole drawer read/batch. Returns undefined (missing) when any row
 * fails; the caller maps that to the pollution path (storage read) or drops the
 * batch (extractor write path).
 */
export function verifyAuthorizationEntriesLiveV1(entries: readonly unknown[], eventAt: AuthorizationEventAt): readonly AuthorizationEntryV1[] | undefined {
  const verified: AuthorizationEntryV1[] = []
  for (const entry of entries) {
    const parsed = verifyAuthorizationEntryLiveV1(entry, eventAt)
    if (parsed === undefined) return undefined
    verified.push(parsed)
  }
  return Object.freeze(verified)
}

export interface AuthorizationInputItemV1 {
  readonly seq: number
  readonly occurredAt: number
  readonly text: string
}

export interface AuthorizationInputWindowV1 {
  readonly items: readonly AuthorizationInputItemV1[]
  /** Newest-consumed seq; the next checkpoint's throughSeq. Equals throughSeq when empty. */
  readonly throughSeq: number
  /** Candidate messages dropped for the event/byte budgets (keep-newest). */
  readonly truncated: number
}

export const DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS = 256
const DEFAULT_MAX_AUTHORIZATION_WINDOW_BYTES = 24_000

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

function itemBytes(item: AuthorizationInputItemV1): number {
  return new TextEncoder().encode(item.text).byteLength + 24
}

/**
 * Collect the deterministic, bounded user-message window for one incremental
 * extraction: direct human user/message events in (afterSeq, throughSeq],
 * ordered ascending, keep-newest under the event and byte budgets. Dropped
 * messages are never extracted (the drawer simply stays silent about them --
 * the fail-safe direction). Total function: any live-eventAt misbehavior
 * degrades to an empty window.
 */
export function collectAuthorizationInputWindow(input: {
  readonly afterSeq: number
  readonly throughSeq: number
  readonly eventAt: AuthorizationEventAt
  readonly maxEvents?: number
  readonly maxWindowBytes?: number
}): AuthorizationInputWindowV1 {
  const maxEvents = input.maxEvents ?? DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS
  const maxWindowBytes = input.maxWindowBytes ?? DEFAULT_MAX_AUTHORIZATION_WINDOW_BYTES
  if (!nonNegativeSafeInteger(input.afterSeq) || !nonNegativeSafeInteger(input.throughSeq)
    || input.throughSeq <= input.afterSeq || !nonNegativeSafeInteger(maxEvents) || maxEvents < 1
    || !nonNegativeSafeInteger(maxWindowBytes) || maxWindowBytes < 1) {
    return { items: Object.freeze([]), throughSeq: input.throughSeq, truncated: 0 }
  }
  const candidates: AuthorizationInputItemV1[] = []
  try {
    for (let seq = input.afterSeq + 1; seq <= input.throughSeq; seq += 1) {
      const event = input.eventAt(seq)
      if (event === undefined || event.type !== 'user/message' || event.seq !== seq) continue
      if (!nonNegativeSafeInteger(event.time)) continue
      const text = extractUserText(event.data)
      if (text === undefined) continue
      candidates.push(Object.freeze({ seq, occurredAt: event.time, text }))
    }
  } catch {
    return { items: Object.freeze([]), throughSeq: input.throughSeq, truncated: 0 }
  }
  const selected: AuthorizationInputItemV1[] = []
  let total = 0
  let truncated = 0
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index]!
    const bytes = itemBytes(item)
    if (selected.length >= maxEvents || bytes > maxWindowBytes || total + bytes > maxWindowBytes) {
      truncated += 1
      continue
    }
    selected.push(item)
    total += bytes
  }
  selected.reverse()
  return Object.freeze({
    items: Object.freeze(selected),
    throughSeq: input.throughSeq,
    truncated,
  })
}
