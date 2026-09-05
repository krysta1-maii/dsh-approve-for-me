/**
 * WP8-b: read-only ledger-health transport (server half).
 *
 * Presentational visibility for the seal chain and the authorization drawer
 * (including the extractor watermark = max committed checkpoint throughSeq).
 * Hard constraints, mirroring the WP8-a reason-code route:
 *  - Read-only and non-authorizing: the response never influences any Gate
 *    result; a failing/unavailable store degrades to an omitted segment, and
 *    any internal failure still answers 200 with a degraded body.
 *  - Closed output set: only bounded non-negative integer counts and a
 *    nullable seq scalar may leave the process — never ids, hashes, session
 *    identifiers, quotes, or text content (plan §2 L26, §7 L140).
 *  - GET only; no parameters; Cache-Control: no-store.
 *  - No DSH types and no node:http types: the handler is written against the
 *    minimal structural request/response pair below so it is unit-testable in
 *    isolation (the plugin adapts the host webServer structurally).
 */

/** Exact route path registered on the host webServer (when present). */
export const LEDGER_HEALTH_ROUTE_PATH = '/dsh-approve-for-me/v1/ledger-health'

/** Minimal structural view of an IncomingMessage (zero node:http dependency). */
export interface LedgerHealthRouteRequest {
  readonly method?: string
}

/** Minimal structural view of a ServerResponse (zero node:http dependency). */
export interface LedgerHealthRouteResponse {
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** Bounded seal-chain statistics read from the sealed-facts domain. */
export interface LedgerHealthSealStats {
  readonly chains: number
  readonly sealedFacts: number
}

/** Bounded authorization-drawer statistics read from the authorization domain. */
export interface LedgerHealthAuthorizationStats {
  readonly entries: number
  readonly checkpoints: number
  /** Extractor watermark: max committed checkpoint throughSeq; null when none. */
  readonly maxThroughSeq: number | null
}

export type LedgerHealthSealRead = () => Promise<LedgerHealthSealStats | undefined>
export type LedgerHealthAuthorizationRead = () => Promise<LedgerHealthAuthorizationStats | undefined>
/** Injected clock for generatedAt (tests inject a deterministic value). */
export type LedgerHealthClock = () => number

export interface LedgerHealthRouteInput {
  readonly seal?: LedgerHealthSealRead
  readonly authorization?: LedgerHealthAuthorizationRead
  readonly clock?: LedgerHealthClock
}

export interface LedgerHealthRouteDecision {
  readonly status: number
  readonly body: Readonly<Record<string, unknown>>
}

const HEALTH_COUNT_MAX = 0x7fffffff

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= HEALTH_COUNT_MAX
}

/**
 * Defense-in-depth closed-set normalization of whatever a store read returned.
 * Anything malformed is treated as unavailable (segment omitted), so a buggy
 * reader can never widen the wire shape.
 */
export function normalizeLedgerHealthSealStats(value: unknown): LedgerHealthSealStats | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isCount(row.chains) || !isCount(row.sealedFacts)) return undefined
  return Object.freeze({ chains: row.chains, sealedFacts: row.sealedFacts })
}

export function normalizeLedgerHealthAuthorizationStats(value: unknown): LedgerHealthAuthorizationStats | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isCount(row.entries) || !isCount(row.checkpoints)) return undefined
  if (row.maxThroughSeq !== null && !isCount(row.maxThroughSeq)) return undefined
  return Object.freeze({ entries: row.entries, checkpoints: row.checkpoints, maxThroughSeq: row.maxThroughSeq })
}

/** Resolve the injected clock to a safe generatedAt scalar; never throws. */
function resolveGeneratedAt(clock: LedgerHealthClock | undefined): number {
  try {
    const value = clock === undefined ? Date.now() : clock()
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  } catch { /* fall through to the next source */ }
  try {
    const fallback = Date.now()
    if (Number.isSafeInteger(fallback) && fallback >= 0) return fallback
  } catch { /* ignore */ }
  return 0
}

/**
 * Decided purely: given the raw store values and the resolved timestamp,
 * produce the exact closed-set response body. Segments are present only when
 * their store answered with well-formed statistics; anything else is omitted
 * (never a false/available field).
 */
export function decideLedgerHealthRoute(
  seal: unknown,
  authorization: unknown,
  generatedAt: number,
): LedgerHealthRouteDecision {
  const body: Record<string, unknown> = { version: 1 }
  if (seal !== undefined) body.seal = seal
  if (authorization !== undefined) body.authorization = authorization
  body.generatedAt = generatedAt
  return { status: 200, body: Object.freeze(body) }
}

function respond(res: LedgerHealthRouteResponse, decision: LedgerHealthRouteDecision): void {
  res.writeHead(decision.status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(decision.body))
}

/**
 * Build the route handler for the host webServer register() call. The handler
 * never throws into the server: every failure mode is answered on the wire as
 * a 200 degraded body with the offending segment omitted.
 */
export function createLedgerHealthRouteHandler(input: LedgerHealthRouteInput) {
  return async function ledgerHealthRouteHandler(
    req: LedgerHealthRouteRequest,
    res: LedgerHealthRouteResponse,
  ): Promise<void> {
    try {
      if (req.method !== 'GET') {
        respond(res, { status: 405, body: { version: 1, error: 'bad-request' } })
        return
      }
      const generatedAt = resolveGeneratedAt(input.clock)
      let seal: LedgerHealthSealStats | undefined
      let authorization: LedgerHealthAuthorizationStats | undefined
      try {
        seal = normalizeLedgerHealthSealStats(input.seal === undefined ? undefined : await input.seal())
      } catch {
        // A failing store read is indistinguishable from an unavailable one.
        seal = undefined
      }
      try {
        authorization = normalizeLedgerHealthAuthorizationStats(
          input.authorization === undefined ? undefined : await input.authorization(),
        )
      } catch {
        authorization = undefined
      }
      respond(res, decideLedgerHealthRoute(seal, authorization, generatedAt))
    } catch {
      // Last-resort fence: even a broken response sink must not escape as an
      // unhandled rejection from the host server.
      try {
        respond(res, decideLedgerHealthRoute(undefined, undefined, resolveGeneratedAt(input.clock)))
      } catch { /* nothing left to answer with */ }
    }
  }
}
