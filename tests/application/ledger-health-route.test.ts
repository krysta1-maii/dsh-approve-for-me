import { describe, expect, it, vi } from 'vitest'
import {
  createLedgerHealthRouteHandler,
  decideLedgerHealthRoute,
  LEDGER_HEALTH_ROUTE_PATH,
  normalizeLedgerHealthAuthorizationStats,
  normalizeLedgerHealthSealStats,
  type LedgerHealthRouteRequest,
  type LedgerHealthRouteResponse,
} from '../../src/application/ledger-health-route.js'

interface CapturedResponse {
  status: number | undefined
  headers: Record<string, string> | undefined
  body: string | undefined
}

function sink(): { res: LedgerHealthRouteResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: undefined, headers: undefined, body: undefined }
  const res: LedgerHealthRouteResponse = {
    writeHead(status, headers) { captured.status = status; captured.headers = { ...headers } },
    end(body) { captured.body = body },
  }
  return { res, captured }
}

async function run(
  handler: ReturnType<typeof createLedgerHealthRouteHandler>,
  req: LedgerHealthRouteRequest,
): Promise<CapturedResponse> {
  const { res, captured } = sink()
  await handler(req, res)
  return captured
}

const SEAL = Object.freeze({ chains: 2, sealedFacts: 7 })
const AUTH = Object.freeze({ entries: 3, checkpoints: 2, maxThroughSeq: 50615 })

describe('ledger-health route handler (WP8-b)', () => {
  it('answers a fully healthy ledger with both segments and the injected clock', async () => {
    const handler = createLedgerHealthRouteHandler({
      seal: async () => SEAL,
      authorization: async () => AUTH,
      clock: () => 1725500000000,
    })
    const captured = await run(handler, { method: 'GET' })
    expect(captured.status).toBe(200)
    expect(captured.headers).toEqual({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    expect(JSON.parse(captured.body!)).toEqual({
      version: 1,
      seal: { chains: 2, sealedFacts: 7 },
      authorization: { entries: 3, checkpoints: 2, maxThroughSeq: 50615 },
      generatedAt: 1725500000000,
    })
  })

  it('omits only the unavailable segment (seal down)', async () => {
    const handler = createLedgerHealthRouteHandler({
      seal: async () => undefined,
      authorization: async () => AUTH,
      clock: () => 1,
    })
    const captured = await run(handler, { method: 'GET' })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({
      version: 1,
      authorization: { entries: 3, checkpoints: 2, maxThroughSeq: 50615 },
      generatedAt: 1,
    })
  })

  it('omits only the unavailable segment (authorization down)', async () => {
    const handler = createLedgerHealthRouteHandler({
      seal: async () => SEAL,
      authorization: async () => undefined,
      clock: () => 1,
    })
    const captured = await run(handler, { method: 'GET' })
    expect(JSON.parse(captured.body!)).toEqual({
      version: 1,
      seal: { chains: 2, sealedFacts: 7 },
      generatedAt: 1,
    })
  })

  it('degrades to a bare degraded body when every store is unavailable', async () => {
    const handler = createLedgerHealthRouteHandler({
      seal: async () => undefined,
      authorization: async () => undefined,
      clock: () => 42,
    })
    const captured = await run(handler, { method: 'GET' })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, generatedAt: 42 })
  })

  it('works without any reader registered (degraded body, never 500)', async () => {
    const handler = createLedgerHealthRouteHandler({ clock: () => 42 })
    const captured = await run(handler, { method: 'GET' })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, generatedAt: 42 })
  })

  it('treats an internal store throw exactly like unavailability (200 degraded)', async () => {
    const handler = createLedgerHealthRouteHandler({
      seal: async () => { throw new Error('storage down') },
      authorization: async () => { throw new Error('storage down') },
      clock: () => 7,
    })
    const captured = await run(handler, { method: 'GET' })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, generatedAt: 7 })
  })

  it('suppresses malformed store values instead of widening the wire shape', async () => {
    const handler = createLedgerHealthRouteHandler({
      seal: async () => ({ chains: -1, sealedFacts: 7 }) as never,
      authorization: async () => ({ entries: 3, checkpoints: 2, maxThroughSeq: '50615' }) as never,
      clock: () => 7,
    })
    const captured = await run(handler, { method: 'GET' })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, generatedAt: 7 })
  })

  it('405s any non-GET method without touching the stores', async () => {
    const seal = vi.fn(async () => SEAL)
    const authorization = vi.fn(async () => AUTH)
    const handler = createLedgerHealthRouteHandler({ seal, authorization, clock: () => 1 })
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const captured = await run(handler, { method })
      expect(captured.status, method).toBe(405)
      expect(JSON.parse(captured.body!)).toEqual({ version: 1, error: 'bad-request' })
    }
    expect(seal).not.toHaveBeenCalled()
    expect(authorization).not.toHaveBeenCalled()
  })

  it('falls back to Date.now and then 0 when the injected clock is broken', async () => {
    const broken = createLedgerHealthRouteHandler({ clock: () => { throw new Error('clock gone') } })
    const captured = await run(broken, { method: 'GET' })
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body!) as { generatedAt: number }
    expect(Number.isSafeInteger(body.generatedAt)).toBe(true)
    expect(body.generatedAt).toBeGreaterThan(0)
    const weird = createLedgerHealthRouteHandler({ clock: () => -5 })
    const capturedWeird = await run(weird, { method: 'GET' })
    expect(Number.isSafeInteger((JSON.parse(capturedWeird.body!) as { generatedAt: number }).generatedAt)).toBe(true)
  })

  it('never throws even when the response sink is broken', async () => {
    const handler = createLedgerHealthRouteHandler({ seal: async () => SEAL, clock: () => 1 })
    const res: LedgerHealthRouteResponse = {
      writeHead() { throw new Error('socket gone') },
      end() { throw new Error('socket gone') },
    }
    await expect(handler({ method: 'GET' }, res)).resolves.toBeUndefined()
  })
})

describe('decideLedgerHealthRoute', () => {
  it('builds the exact closed-set body with optional segments', () => {
    expect(decideLedgerHealthRoute(SEAL, AUTH, 9).body).toEqual({
      version: 1,
      seal: { chains: 2, sealedFacts: 7 },
      authorization: { entries: 3, checkpoints: 2, maxThroughSeq: 50615 },
      generatedAt: 9,
    })
    expect(decideLedgerHealthRoute(undefined, undefined, 0).body).toEqual({ version: 1, generatedAt: 0 })
  })
})

describe('normalizeLedgerHealth*Stats', () => {
  it('accepts only bounded non-negative integer counts and a nullable watermark', () => {
    expect(normalizeLedgerHealthSealStats({ chains: 0, sealedFacts: 0 })).toEqual({ chains: 0, sealedFacts: 0 })
    expect(normalizeLedgerHealthSealStats({ chains: 1.5, sealedFacts: 0 })).toBeUndefined()
    expect(normalizeLedgerHealthSealStats({ chains: -1, sealedFacts: 0 })).toBeUndefined()
    expect(normalizeLedgerHealthSealStats({ chains: 0x7fffffff + 1, sealedFacts: 0 })).toBeUndefined()
    expect(normalizeLedgerHealthSealStats('nope')).toBeUndefined()
    expect(normalizeLedgerHealthSealStats(null)).toBeUndefined()
    expect(normalizeLedgerHealthAuthorizationStats({ entries: 1, checkpoints: 1, maxThroughSeq: null })).toEqual({ entries: 1, checkpoints: 1, maxThroughSeq: null })
    expect(normalizeLedgerHealthAuthorizationStats({ entries: 1, checkpoints: 1, maxThroughSeq: 12 })).toEqual({ entries: 1, checkpoints: 1, maxThroughSeq: 12 })
    expect(normalizeLedgerHealthAuthorizationStats({ entries: 1, checkpoints: 1, maxThroughSeq: -1 })).toBeUndefined()
    expect(normalizeLedgerHealthAuthorizationStats({ entries: 1, checkpoints: 1, maxThroughSeq: 1.2 })).toBeUndefined()
    expect(normalizeLedgerHealthAuthorizationStats({ entries: Number.NaN, checkpoints: 1, maxThroughSeq: null })).toBeUndefined()
  })
})
