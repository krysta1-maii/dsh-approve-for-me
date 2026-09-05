/**
 * WP8-a: browser half of the reason-code renderer transport.
 *
 * Fetches the read-only server route (GET /dsh-approve-for-me/v1/reason-code)
 * for decided approval rows whose Chat node has no reasonCode yet. Purely
 * presentational: every failure mode (network error, non-200, malformed JSON,
 * unknown code) settles the cache to null, which the renderer shows as the
 * generic safe line. No exception ever escapes to the UI and authorization is
 * never touched.
 *
 * Shape: resolve(requestId) reads the settled cache synchronously (the seam
 * createServerBackedReasonCodeReader stays synchronous for buildViewNode);
 * request(requestId) triggers an async fill and resolves once it has settled.
 * Concurrent requests for one id share a single fetch; the settled cache is
 * bounded and evicts keep-newest.
 */

import { readReasonCode, type ApprovalReasonCodeServerBridge, type ReasonCode } from './reason-code.js'

export const REASON_CODE_REMOTE_PATH = '/dsh-approve-for-me/v1/reason-code'

/** Default settled-cache bound; the newest entries survive eviction. */
export const REASON_CODE_REMOTE_MAX_ENTRIES = 256

export interface ReasonCodeRemoteBridge extends ApprovalReasonCodeServerBridge {
  /** Synchronous settled-cache read; undefined while unsettled or a miss. */
  readonly resolve: (requestId: string) => ReasonCode | undefined
  /**
   * Trigger an async fetch+fill for a request id. Returns a promise that
   * settles when the cache entry is final; it never rejects. Concurrent calls
   * for one id share one fetch; a settled entry is never re-fetched.
   */
  readonly request: (requestId: string) => Promise<void>
  /** Drop all settled/in-flight state (plugin unload, tests). */
  readonly reset: () => void
}

export interface ReasonCodeRemoteBridgeOptions {
  /** Fetch implementation (injectable for tests); defaults to global fetch. */
  readonly fetch?: (input: string) => Promise<{
    readonly ok: boolean
    json(): Promise<unknown>
  }>
  /** Route path override (tests). Defaults to REASON_CODE_REMOTE_PATH. */
  readonly path?: string
  /** Settled-cache bound. Defaults to REASON_CODE_REMOTE_MAX_ENTRIES. */
  readonly maxEntries?: number
}

export function createReasonCodeRemoteBridge(options: ReasonCodeRemoteBridgeOptions = {}): ReasonCodeRemoteBridge {
  const fetchImpl = options.fetch ?? (typeof fetch === 'function'
    ? (input: string) => fetch(input)
    : undefined)
  const path = options.path ?? REASON_CODE_REMOTE_PATH
  const maxEntries = options.maxEntries ?? REASON_CODE_REMOTE_MAX_ENTRIES
  // Insertion order == settlement order; eviction drops the oldest keys.
  const settled = new Map<string, ReasonCode | null>()
  const inFlight = new Map<string, Promise<void>>()

  function settle(requestId: string, code: ReasonCode | null): void {
    // Refresh recency on re-settle so hot ids survive eviction.
    settled.delete(requestId)
    settled.set(requestId, code)
    while (settled.size > maxEntries) {
      const oldest = settled.keys().next().value
      if (oldest === undefined) break
      settled.delete(oldest)
    }
  }

  function request(requestId: string): Promise<void> {
    if (settled.has(requestId)) {
      // Cache hit: refresh recency so hot ids survive keep-newest eviction.
      settle(requestId, settled.get(requestId) ?? null)
      return Promise.resolve()
    }
    const pending = inFlight.get(requestId)
    if (pending !== undefined) return pending
    if (fetchImpl === undefined) {
      settle(requestId, null)
      return Promise.resolve()
    }
    const run = (async () => {
      try {
        const url = path + '?requestId=' + encodeURIComponent(requestId)
        const response = await fetchImpl(url)
        if (!response.ok) {
          settle(requestId, null)
          return
        }
        let body: unknown
        try {
          body = await response.json()
        } catch {
          settle(requestId, null)
          return
        }
        const value = typeof body === 'object' && body !== null
          ? (body as Readonly<Record<string, unknown>>)['reasonCode']
          : undefined
        settle(requestId, readReasonCode(value) ?? null)
      } catch {
        // Network/parse failure == miss: cache null, never surface to the UI.
        settle(requestId, null)
      } finally {
        inFlight.delete(requestId)
      }
    })()
    inFlight.set(requestId, run)
    return run
  }

  return {
    resolve(requestId) {
      const cached = settled.get(requestId)
      // Decode defensively: only closed-set codes may leave the bridge.
      return cached === undefined || cached === null ? undefined : readReasonCode(cached)
    },
    request,
    reset() {
      settled.clear()
      inFlight.clear()
    },
  }
}

/**
 * The plugin-wide bridge the client plugin installs into the WP5-c seam. Using
 * one shared bridge keeps in-flight dedupe and the settled cache global across
 * every Chat row.
 */
let sharedBridge: ReasonCodeRemoteBridge | undefined

/** The shared bridge, created lazily against the browser-global fetch. */
export function getReasonCodeRemoteBridge(): ReasonCodeRemoteBridge {
  sharedBridge ??= createReasonCodeRemoteBridge()
  return sharedBridge
}

/** Drop the shared bridge (client plugin unload). */
export function resetReasonCodeRemoteBridge(): void {
  sharedBridge?.reset()
  sharedBridge = undefined
}
