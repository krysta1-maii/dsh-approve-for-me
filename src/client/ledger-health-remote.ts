/**
 * WP8-b: browser half of the ledger-health transport.
 *
 * Fetches the read-only server route (GET /dsh-approve-for-me/v1/ledger-health)
 * for the settings card's "ledger health" section. Purely presentational: any
 * failure mode (network error, non-200, malformed JSON, body outside the
 * closed set) settles to undefined, which the card renders as a muted
 * unavailable line. No exception ever escapes to the UI and authorization is
 * never touched.
 */

/** Exact route path registered by the host plugin's webServer (when present). */
export const LEDGER_HEALTH_REMOTE_PATH = '/dsh-approve-for-me/v1/ledger-health'

/** Decoded, closed-set view of the route body. */
export interface LedgerHealthViewModel {
  readonly version: 1
  readonly seal?: {
    readonly chains: number
    readonly sealedFacts: number
  }
  readonly authorization?: {
    readonly entries: number
    readonly checkpoints: number
    /** Extractor watermark; null when no checkpoint has been committed. */
    readonly maxThroughSeq: number | null
  }
  readonly generatedAt: number
}

const HEALTH_COUNT_MAX = 0x7fffffff

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= HEALTH_COUNT_MAX
}

/** generatedAt is a millisecond epoch, so it gets the wider safe-integer range. */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const INVALID = Symbol('invalid')
type Invalid = typeof INVALID

function decodeSeal(value: unknown): LedgerHealthViewModel['seal'] | undefined | Invalid {
  if (value === undefined) return undefined
  if (!isRecord(value)) return INVALID
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('chains') || !keys.includes('sealedFacts')) return INVALID
  if (!isCount(value.chains) || !isCount(value.sealedFacts)) return INVALID
  return Object.freeze({ chains: value.chains, sealedFacts: value.sealedFacts })
}

function decodeAuthorization(value: unknown): LedgerHealthViewModel['authorization'] | undefined | Invalid {
  if (value === undefined) return undefined
  if (!isRecord(value)) return INVALID
  const keys = Object.keys(value)
  if (keys.length !== 3 || !keys.includes('entries') || !keys.includes('checkpoints') || !keys.includes('maxThroughSeq')) {
    return INVALID
  }
  if (!isCount(value.entries) || !isCount(value.checkpoints)) return INVALID
  if (value.maxThroughSeq !== null && !isCount(value.maxThroughSeq)) return INVALID
  return Object.freeze({ entries: value.entries, checkpoints: value.checkpoints, maxThroughSeq: value.maxThroughSeq })
}

/**
 * Closed-set decode of the route body: exactly {version:1, seal?, authorization?,
 * generatedAt} with bounded scalar leaves. Unknown fields, missing/extra keys,
 * or wrong leaf types all reject (return undefined) so a widened or corrupted
 * response can never reach the renderer.
 */
export function decodeLedgerHealth(body: unknown): LedgerHealthViewModel | undefined {
  if (!isRecord(body)) return undefined
  const keys = Object.keys(body)
  const allowed = ['version', 'seal', 'authorization', 'generatedAt']
  if (keys.length < 2 || keys.length > allowed.length || keys.some(key => !allowed.includes(key))) return undefined
  if (body.version !== 1) return undefined
  if (!isTimestamp(body.generatedAt)) return undefined
  const seal = decodeSeal(body.seal)
  if (seal === INVALID) return undefined
  const authorization = decodeAuthorization(body.authorization)
  if (authorization === INVALID) return undefined
  return Object.freeze({
    version: 1,
    generatedAt: body.generatedAt,
    ...(seal === undefined ? {} : { seal }),
    ...(authorization === undefined ? {} : { authorization }),
  })
}

export interface LedgerHealthRemoteOptions {
  /** Fetch implementation (injectable for tests); defaults to global fetch. */
  readonly fetch?: (input: string) => Promise<{
    readonly ok: boolean
    json(): Promise<unknown>
  }>
  /** Route path override (tests). Defaults to LEDGER_HEALTH_REMOTE_PATH. */
  readonly path?: string
}

/**
 * Fetch and decode the route. Returns undefined for every failure mode
 * (no fetch implementation, network error, non-200, unparseable body, or a
 * body outside the closed set); it never rejects.
 */
export async function fetchLedgerHealth(options: LedgerHealthRemoteOptions = {}): Promise<LedgerHealthViewModel | undefined> {
  const fetchImpl = options.fetch ?? (typeof fetch === 'function'
    ? (input: string) => fetch(input)
    : undefined)
  if (fetchImpl === undefined) return undefined
  try {
    const response = await fetchImpl(options.path ?? LEDGER_HEALTH_REMOTE_PATH)
    if (!response.ok) return undefined
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return undefined
    }
    return decodeLedgerHealth(body)
  } catch {
    return undefined
  }
}
