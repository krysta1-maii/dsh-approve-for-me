import { GATE_FAILURE_CODES } from './gate-failure.js'
import type { GateFailureCode } from './gate-failure.js'

/**
 * WP8-a: read-only reason-code renderer transport (server half).
 *
 * The decided Chat node carries the authoritative 'outcome' and its event shape
 * is closed ({id, outcome}); the Gate failure reason code lives in a
 * metadata-only decision sidecar. This route is the single, non-authorizing
 * channel through which the browser renderer can read it. Hard constraints:
 *  - Read-only and presentational: the response never influences the Gate
 *    result; a miss (absent/unknown/unreadable code) is a 200 with
 *    {version:1} and the renderer keeps the generic safe line.
 *  - Closed output set: only a value in GATE_FAILURE_CODES may leave the
 *    process; anything else is omitted from the body.
 *  - Fail-closed degradation: any internal read failure still answers 200
 *    {version:1}; only a malformed request earns a 400.
 *  - No DSH types and no node:http types: the handler is written against the
 *    minimal structural request/response pair below so it is unit-testable in
 *    isolation (the plugin adapts the host webServer's IncomingMessage /
 *    ServerResponse structurally).
 */

/** Exact route path registered on the host webServer (when present). */
export const REASON_CODE_ROUTE_PATH = '/dsh-approve-for-me/v1/reason-code'

/** requestId length bound; longer or empty ids are malformed. */
export const REASON_CODE_ROUTE_MAX_REQUEST_ID = 256

/** Minimal structural view of an IncomingMessage (zero node:http dependency). */
export interface ReasonCodeRouteRequest {
  readonly method?: string
  readonly url?: string
}

/** Minimal structural view of a ServerResponse (zero node:http dependency). */
export interface ReasonCodeRouteResponse {
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** The read-only sidecar query the route answers (records store reasonCode index). */
export type ReasonCodeRouteRead = (requestId: string) => Promise<GateFailureCode | undefined>

const GATE_FAILURE_CODE_SET: ReadonlySet<string> = new Set(GATE_FAILURE_CODES)

interface RouteDecision {
  readonly status: number
  readonly body: Readonly<Record<string, unknown>>
}

function respond(res: ReasonCodeRouteResponse, decision: RouteDecision): void {
  res.writeHead(decision.status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(decision.body))
}

function badRequest(): RouteDecision {
  return { status: 400, body: { version: 1, error: 'bad-request' } }
}

function miss(): RouteDecision {
  return { status: 200, body: { version: 1 } }
}

/**
 * Validate the requestId query parameter: it must be present exactly once,
 * a non-empty string of at most REASON_CODE_ROUTE_MAX_REQUEST_ID characters.
 * Returns 'undefined' for a malformed query (the caller answers 400).
 */
export function parseReasonCodeRequestId(url: string | undefined): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined
  let query: string
  const queryStart = url.indexOf('?')
  query = queryStart >= 0 ? url.slice(queryStart + 1) : ''
  if (query.length === 0) return undefined
  let requestId: string | undefined
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq >= 0 ? pair.slice(0, eq) : pair
    if (key !== 'requestId') continue
    if (requestId !== undefined) return undefined // duplicated parameter
    const raw = eq >= 0 ? pair.slice(eq + 1) : ''
    let decoded: string
    try {
      decoded = decodeURIComponent(raw.replace(/\+/g, ' '))
    } catch {
      return undefined
    }
    requestId = decoded
  }
  if (typeof requestId !== 'string') return undefined
  if (requestId.length === 0 || requestId.length > REASON_CODE_ROUTE_MAX_REQUEST_ID) return undefined
  return requestId
}

/**
 * Decided purely: given a validated requestId and the raw sidecar value,
 * produce the exact response. Split out so the wire shape is unit-testable
 * without any store.
 */
export function decideReasonCodeRoute(requestId: string, value: unknown): RouteDecision {
  if (typeof value === 'string' && GATE_FAILURE_CODE_SET.has(value)) {
    return { status: 200, body: { version: 1, reasonCode: value } }
  }
  return miss()
}

/**
 * Build the route handler for the host webServer register() call. The handler
 * never throws into the server: every failure mode is answered on the wire.
 */
export function createReasonCodeRouteHandler(read: ReasonCodeRouteRead) {
  return async function reasonCodeRouteHandler(
    req: ReasonCodeRouteRequest,
    res: ReasonCodeRouteResponse,
  ): Promise<void> {
    try {
      if (req.method !== 'GET') {
        respond(res, { status: 405, body: { version: 1, error: 'bad-request' } })
        return
      }
      const requestId = parseReasonCodeRequestId(req.url)
      if (requestId === undefined) {
        respond(res, badRequest())
        return
      }
      let value: GateFailureCode | undefined
      try {
        value = await read(requestId)
      } catch {
        // Miss semantics: a failing sidecar read is indistinguishable from an
        // absent code on this channel.
        value = undefined
      }
      respond(res, decideReasonCodeRoute(requestId, value))
    } catch {
      // Last-resort fence: even a broken response sink must not escape as an
      // unhandled rejection from the host server.
      try { respond(res, miss()) } catch { /* nothing left to answer with */ }
    }
  }
}
