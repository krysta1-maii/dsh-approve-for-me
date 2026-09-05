import { describe, expect, it } from 'vitest'
import {
  AUTHORIZATION_EXTRACTOR_VERSION,
  EXTRACTION_PROVIDER,
  EXTRACTION_PROTOCOL_VERSION,
  createExtractorProviderData,
  fingerprintExtractorConfiguration,
  parseAuthorizationExtractionSubmissionV1,
  parseExtractorProviderData,
} from '../../src/index.js'
import type { ReviewerModelRoute } from '../../src/index.js'

const ROUTE: ReviewerModelRoute = { providerId: 'deepseek', modelId: 'deepseek-chat', reasoningEffort: 'high' }

function validProviderData() {
  return createExtractorProviderData({ generation: 'gen-1', modelRoute: ROUTE, extractorVersion: AUTHORIZATION_EXTRACTOR_VERSION })
}

function validSubmission() {
  return {
    protocolVersion: 1,
    extractionId: 'ext-1',
    parentSessionId: 'parent-1',
    extractorSessionId: 'extractor-1',
    generation: 'gen-1',
    extractorVersion: AUTHORIZATION_EXTRACTOR_VERSION,
    throughSeq: 42,
    entries: [
      { sourceSeq: 10, quote: 'please allow this', effect: 'grant', coverage: 'action', summary: 'user grants action' },
    ],
  }
}

describe('EXTRACTION_PROVIDER constant', () => {
  it('has the expected stable name', () => {
    expect(EXTRACTION_PROVIDER).toBe('dsh-approve-for-me/authorization-extractor')
  })
})

describe('createExtractorProviderData', () => {
  it('builds a frozen v1 descriptor with a matching fingerprint', () => {
    const data = validProviderData()
    expect(data.version).toBe(1)
    expect(data.role).toBe('extractor')
    expect(data.generation).toBe('gen-1')
    expect(data.extractorVersion).toBe(AUTHORIZATION_EXTRACTOR_VERSION)
    expect(data.modelRoute).toEqual(ROUTE)
    expect(data.configurationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(data)).toBe(true)
  })

  it('produces identical fingerprints for identical composition', () => {
    const a = createExtractorProviderData({ generation: 'gen-a', modelRoute: ROUTE, extractorVersion: 'v1' })
    const b = createExtractorProviderData({ generation: 'gen-b', modelRoute: ROUTE, extractorVersion: 'v1' })
    expect(a.configurationFingerprint).toBe(b.configurationFingerprint)
  })

  it('produces different fingerprints for different routes or versions', () => {
    const base = createExtractorProviderData({ generation: 'gen-1', modelRoute: ROUTE, extractorVersion: 'v1' })
    const differentRoute = createExtractorProviderData({ generation: 'gen-1', modelRoute: { providerId: 'other', modelId: 'model' }, extractorVersion: 'v1' })
    const differentVersion = createExtractorProviderData({ generation: 'gen-1', modelRoute: ROUTE, extractorVersion: 'v2' })
    expect(base.configurationFingerprint).not.toBe(differentRoute.configurationFingerprint)
    expect(base.configurationFingerprint).not.toBe(differentVersion.configurationFingerprint)
  })
})

describe('fingerprintExtractorConfiguration', () => {
  it('is stable and deterministic', () => {
    const fp1 = fingerprintExtractorConfiguration({ modelRoute: ROUTE, extractorVersion: 'v1' })
    const fp2 = fingerprintExtractorConfiguration({ modelRoute: ROUTE, extractorVersion: 'v1' })
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('parseExtractorProviderData', () => {
  it('round-trips valid provider data', () => {
    const data = validProviderData()
    const parsed = parseExtractorProviderData({ ...data })
    expect(parsed).toEqual(data)
  })

  it('rejects a tampered fingerprint', () => {
    const data = validProviderData()
    expect(() => parseExtractorProviderData({ ...data, configurationFingerprint: 'sha256:' + '0'.repeat(64) }))
      .toThrow(/does not match/)
  })

  it('rejects an unknown field', () => {
    const data = validProviderData()
    expect(() => parseExtractorProviderData({ ...data, extra: 1 })).toThrow(/not supported/)
  })

  it('rejects a missing required field', () => {
    const data = validProviderData()
    const { configurationFingerprint: _, ...withoutFingerprint } = data
    expect(() => parseExtractorProviderData(withoutFingerprint)).toThrow(/required/)
  })

  it('rejects a wrong role', () => {
    const data = validProviderData()
    expect(() => parseExtractorProviderData({ ...data, role: 'primary' })).toThrow(/role must be/)
  })

  it('rejects a non-extractor role even with matching fingerprint', () => {
    const data = validProviderData()
    expect(() => parseExtractorProviderData({ ...data, role: 'reviewer' as never })).toThrow(/role must be/)
  })

  it('rejects version other than 1', () => {
    const data = validProviderData()
    expect(() => parseExtractorProviderData({ ...data, version: 2 })).toThrow(/version must be 1/)
  })

  it('rejects an invalid sha256 fingerprint format', () => {
    const data = validProviderData()
    expect(() => parseExtractorProviderData({ ...data, configurationFingerprint: 'md5:abc' })).toThrow(/sha256 digest/)
  })
})

describe('parseAuthorizationExtractionSubmissionV1', () => {
  it('accepts a fully valid submission', () => {
    const s = validSubmission()
    const parsed = parseAuthorizationExtractionSubmissionV1(s)
    expect(parsed.protocolVersion).toBe(1)
    expect(parsed.extractionId).toBe('ext-1')
    expect(parsed.throughSeq).toBe(42)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]!.quote).toBe('please allow this')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.entries)).toBe(true)
  })

  it('accepts string spelling "1" for protocolVersion from models', () => {
    const s = validSubmission()
    const parsed = parseAuthorizationExtractionSubmissionV1({ ...s, protocolVersion: '1' as unknown as number })
    expect(parsed.protocolVersion).toBe(1)
  })

  it('rejects protocolVersion other than 1 or "1"', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, protocolVersion: 2 })).toThrow(/must be 1/)
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, protocolVersion: '2' as unknown as number })).toThrow(/must be 1/)
  })

  it('rejects unknown top-level fields', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, extraField: true })).toThrow(/not supported/)
  })

  it('rejects unknown entry fields', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 10, quote: 'x', effect: 'grant', coverage: 'action', summary: 'y', extra: 1 }],
    })).toThrow(/not supported/)
  })

  it('rejects effect outside closed set', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 10, quote: 'x', effect: 'maybe', coverage: 'action', summary: 'y' }],
    })).toThrow(/effect is invalid/)
  })

  it('rejects coverage outside closed set', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 10, quote: 'x', effect: 'grant', coverage: 'forever', summary: 'y' }],
    })).toThrow(/coverage is invalid/)
  })

  it('rejects more than 64 entries', () => {
    const s = validSubmission()
    const entries = Array.from({ length: 65 }, (_, i) => ({
      sourceSeq: i,
      quote: 'q',
      effect: 'grant' as const,
      coverage: 'action' as const,
      summary: 's',
    }))
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, entries })).toThrow(/at most 64/)
  })

  it('accepts exactly 64 entries', () => {
    const s = validSubmission()
    const entries = Array.from({ length: 64 }, (_, i) => ({
      sourceSeq: i,
      quote: 'q',
      effect: 'grant' as const,
      coverage: 'action' as const,
      summary: 's',
    }))
    const parsed = parseAuthorizationExtractionSubmissionV1({ ...s, entries })
    expect(parsed.entries).toHaveLength(64)
  })

  it('rejects a quote exceeding 2000 bytes', () => {
    const s = validSubmission()
    const longQuote = 'x'.repeat(2001)
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 1, quote: longQuote, effect: 'grant', coverage: 'action', summary: 's' }],
    })).toThrow(/exceeds 2000 bytes/)
  })

  it('rejects a summary exceeding 500 bytes', () => {
    const s = validSubmission()
    const longSummary = 'x'.repeat(501)
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 1, quote: 'q', effect: 'grant', coverage: 'action', summary: longSummary }],
    })).toThrow(/exceeds 500 bytes/)
  })

  it('accepts quote and summary at exact byte limits', () => {
    const s = validSubmission()
    const quote = 'x'.repeat(2000)
    const summary = 'y'.repeat(500)
    const parsed = parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 1, quote, effect: 'grant', coverage: 'action', summary }],
    })
    expect(parsed.entries[0]!.quote).toBe(quote)
    expect(parsed.entries[0]!.summary).toBe(summary)
  })

  it('rejects negative throughSeq', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, throughSeq: -1 })).toThrow(/non-negative/)
  })

  it('rejects non-integer throughSeq', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, throughSeq: 3.14 })).toThrow(/non-negative/)
  })

  it('rejects negative sourceSeq', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: -1, quote: 'x', effect: 'grant', coverage: 'action', summary: 'y' }],
    })).toThrow(/non-negative/)
  })

  it('rejects non-integer sourceSeq', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({
      ...s,
      entries: [{ sourceSeq: 1.5, quote: 'x', effect: 'grant', coverage: 'action', summary: 'y' }],
    })).toThrow(/non-negative/)
  })

  it('rejects empty strings for identifiers', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, extractionId: '' })).toThrow(/non-empty string/)
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, parentSessionId: '' })).toThrow(/non-empty string/)
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, extractorSessionId: '' })).toThrow(/non-empty string/)
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, generation: '' })).toThrow(/non-empty string/)
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, extractorVersion: '' })).toThrow(/non-empty string/)
  })

  it('rejects non-array entries', () => {
    const s = validSubmission()
    expect(() => parseAuthorizationExtractionSubmissionV1({ ...s, entries: 'none' as unknown as [] })).toThrow(/must be an array/)
  })

  it('accepts empty entries array', () => {
    const s = validSubmission()
    const parsed = parseAuthorizationExtractionSubmissionV1({ ...s, entries: [] })
    expect(parsed.entries).toHaveLength(0)
  })
})
