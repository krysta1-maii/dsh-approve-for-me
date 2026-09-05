import { describe, expect, it, vi } from 'vitest'
import {
  createReasonCodeRouteHandler,
  decideReasonCodeRoute,
  parseReasonCodeRequestId,
  REASON_CODE_ROUTE_MAX_REQUEST_ID,
  REASON_CODE_ROUTE_PATH,
  type ReasonCodeRouteRequest,
  type ReasonCodeRouteResponse,
} from '../../src/application/reason-code-route.js'

interface CapturedResponse {
  status: number | undefined
  headers: Record<string, string> | undefined
  body: string | undefined
}

function sink(): { res: ReasonCodeRouteResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: undefined, headers: undefined, body: undefined }
  const res: ReasonCodeRouteResponse = {
    writeHead(status, headers) { captured.status = status; captured.headers = { ...headers } },
    end(body) { captured.body = body },
  }
  return { res, captured }
}

async function run(
  handler: ReturnType<typeof createReasonCodeRouteHandler>,
  req: ReasonCodeRouteRequest,
): Promise<CapturedResponse> {
  const { res, captured } = sink()
  await handler(req, res)
  return captured
}

describe('reason-code route handler (WP8-a)', () => {
  it('answers a known code with 200 and the closed-set value', async () => {
    const handler = createReasonCodeRouteHandler(async () => 'sealed-current-missing' as const)
    const captured = await run(handler, { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` })
    expect(captured.status).toBe(200)
    expect(captured.headers).toEqual({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, reasonCode: 'sealed-current-missing' })
  })

  it('answers a miss with a bare {version:1}', async () => {
    const handler = createReasonCodeRouteHandler(async () => undefined)
    const captured = await run(handler, { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1 })
  })

  it('suppresses a code outside the closed set', async () => {
    const handler = createReasonCodeRouteHandler(async () => 'not-a-real-code' as never)
    const captured = await run(handler, { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1 })
  })

  it('400s a missing, empty, oversized or duplicated requestId', async () => {
    const read = vi.fn(async () => undefined)
    const handler = createReasonCodeRouteHandler(read)
    for (const url of [
      REASON_CODE_ROUTE_PATH,
      `${REASON_CODE_ROUTE_PATH}?requestId=`,
      `${REASON_CODE_ROUTE_PATH}?requestId=${'x'.repeat(REASON_CODE_ROUTE_MAX_REQUEST_ID + 1)}`,
      `${REASON_CODE_ROUTE_PATH}?requestId=a&requestId=b`,
      `${REASON_CODE_ROUTE_PATH}?other=1`,
    ]) {
      const captured = await run(handler, { method: 'GET', url })
      expect(captured.status, url).toBe(400)
      expect(JSON.parse(captured.body!)).toEqual({ version: 1, error: 'bad-request' })
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('accepts a requestId at exactly the length bound', async () => {
    const id = 'x'.repeat(REASON_CODE_ROUTE_MAX_REQUEST_ID)
    const read = vi.fn(async () => 'integrity' as const)
    const handler = createReasonCodeRouteHandler(read)
    const captured = await run(handler, { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=${id}` })
    expect(captured.status).toBe(200)
    expect(read).toHaveBeenCalledWith(id)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, reasonCode: 'integrity' })
  })

  it('405s any non-GET method without touching the store', async () => {
    const read = vi.fn(async () => 'integrity' as const)
    const handler = createReasonCodeRouteHandler(read)
    const captured = await run(handler, { method: 'POST', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` })
    expect(captured.status).toBe(405)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, error: 'bad-request' })
    expect(read).not.toHaveBeenCalled()
  })

  it('degrades an internal read failure to a 200 miss', async () => {
    const handler = createReasonCodeRouteHandler(async () => { throw new Error('storage down') })
    const captured = await run(handler, { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` })
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1 })
  })

  it('never throws even when the response sink is broken', async () => {
    const handler = createReasonCodeRouteHandler(async () => 'integrity' as const)
    const res: ReasonCodeRouteResponse = {
      writeHead() { throw new Error('socket gone') },
      end() { throw new Error('socket gone') },
    }
    await expect(handler({ method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` }, res)).resolves.toBeUndefined()
  })

  it('url-decodes the requestId before reading', async () => {
    const read = vi.fn(async () => undefined)
    const handler = createReasonCodeRouteHandler(read)
    await run(handler, { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask%2F42+plus` })
    expect(read).toHaveBeenCalledWith('ask/42 plus')
  })
})

describe('parseReasonCodeRequestId', () => {
  it('rejects non-string and query-less urls', () => {
    expect(parseReasonCodeRequestId(undefined)).toBeUndefined()
    expect(parseReasonCodeRequestId('')).toBeUndefined()
    expect(parseReasonCodeRequestId(REASON_CODE_ROUTE_PATH)).toBeUndefined()
  })
})

describe('decideReasonCodeRoute', () => {
  it('omits non-closed-set and non-string values', () => {
    expect(decideReasonCodeRoute('a', 'abort').body).toEqual({ version: 1, reasonCode: 'abort' })
    expect(decideReasonCodeRoute('a', 'budget-overflow').body).toEqual({ version: 1 })
    expect(decideReasonCodeRoute('a', 42).body).toEqual({ version: 1 })
    expect(decideReasonCodeRoute('a', undefined).body).toEqual({ version: 1 })
  })
})
