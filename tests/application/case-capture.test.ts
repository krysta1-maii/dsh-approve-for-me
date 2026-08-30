import { describe, expect, it } from 'vitest'
import { InMemoryCaseCaptureSink } from '../../src/index.js'
import type { GuardianCaseArtifactV1 } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function artifact(id: string): GuardianCaseArtifactV1 {
  return {
    version: 1,
    artifactId: id,
    session: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 },
    approval: { askedEventSeq: 5, callId: 'call-1', toolName: 'bash' },
    reviewRunId: 'run-1',
    configurationFingerprint: hash('a'),
    reviewerPolicy: {
      version: 1,
      policyVersion: 'policy-v1',
      policyArtifactFingerprint: hash('b'),
      systemPrompt: 'system',
      decisionToolName: 'submit_decision',
      decisionToolSchema: { type: 'object' },
      decisionSchemaFingerprint: hash('c'),
      toolsetVersion: 1,
    },
    attempts: [],
    recoveries: [],
    pluginDisposition: 'allow',
    capturedAt: 1_000,
    expiresAt: 2_000,
  }
}

function config(overrides: Partial<ConstructorParameters<typeof InMemoryCaseCaptureSink>[0]> = {}) {
  return {
    mode: 'full' as const,
    maxCases: 10,
    maxArtifactBytes: 100_000,
    maxTotalBytes: 1_000_000,
    retentionDays: 30,
    ...overrides,
  }
}

describe('InMemoryCaseCaptureSink', () => {
  it('skips when mode is off or an artifact exceeds a single-item limit', () => {
    const off = new InMemoryCaseCaptureSink(config({ mode: 'off' }))
    off.enqueue(artifact('a'))
    expect(off.stats()).toMatchObject({ mode: 'off', count: 0, skipped: 1 })

    const constrained = new InMemoryCaseCaptureSink(config({ maxArtifactBytes: 10 }))
    constrained.enqueue(artifact('a'))
    expect(constrained.stats()).toMatchObject({ count: 0, skipped: 1 })
  })

  it('does not retain expired artifacts and evicts retained artifacts at expiry', () => {
    let now = 1_500
    const sink = new InMemoryCaseCaptureSink(config(), () => now)
    sink.enqueue({ ...artifact('expired'), expiresAt: 1_500 })
    expect(sink.stats()).toMatchObject({ count: 0, skipped: 1 })

    sink.enqueue({ ...artifact('live'), expiresAt: 2_000 })
    expect(sink.stats()).toMatchObject({ count: 1, evicted: 0 })
    now = 2_000
    expect(sink.stats()).toMatchObject({ count: 0, evicted: 1 })
  })

  it('retains qualified artifacts and evicts the oldest over maxCases', () => {
    const sink = new InMemoryCaseCaptureSink(config({ maxCases: 1, maxTotalBytes: 1_000_000 }), () => 1_000)
    sink.enqueue(artifact('a'))
    sink.enqueue(artifact('b'))
    const stats = sink.stats()
    expect(stats.count).toBe(1)
    expect(stats.evicted).toBe(1)
    expect(stats.totalBytes).toBeLessThan(1_000_000)
  })

  it('drains without work when in-memory', async () => {
    const sink = new InMemoryCaseCaptureSink(config())
    await expect(sink.drain()).resolves.toBeUndefined()
  })
})
