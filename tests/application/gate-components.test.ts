import { describe, expect, it } from 'vitest'
import {
  InMemoryAllowCache,
  InMemoryExactDenialBreaker,
  InMemorySealedDispositionRegistry,
  createToolApprovalClassifier,
  createTrustEnvelopeEvaluator,
} from '../../src/index.js'
import type { SealedDispositionV1 } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function denyKey(overrides: Partial<Parameters<InMemoryExactDenialBreaker['lookup']>[0]> = {}) {
  return {
    parentLifecycleFingerprint: 'parent-a',
    turn: 1,
    directUserFrontierSeq: 2,
    actionHash: hash('a'),
    ...overrides,
  }
}

function allowKey(overrides: Partial<Parameters<InMemoryAllowCache['lookup']>[0]> = {}) {
  return {
    ...denyKey(),
    configurationFingerprint: hash('b'),
    generation: 'generation-1',
    ...overrides,
  }
}

function sealed(overrides: Partial<SealedDispositionV1> = {}): SealedDispositionV1 {
  return {
    version: 1,
    reviewRunId: 'run-1',
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    callId: 'call-1',
    actionHash: hash('a'),
    generation: 'generation-1',
    configurationFingerprint: hash('b'),
    disposition: 'allow',
    issuedAt: 100,
    deadlineAt: 200,
    replayable: true,
    ...overrides,
  }
}

describe('InMemoryExactDenialBreaker', () => {
  it('records and clears exact denial keys with turn and frontier scoping', () => {
    const breaker = new InMemoryExactDenialBreaker()
    expect(breaker.lookup(denyKey())).toBe(false)
    breaker.recordGuardianDeny(denyKey())
    expect(breaker.lookup(denyKey())).toBe(true)
    expect(breaker.lookup(denyKey({ actionHash: hash('b') }))).toBe(false)
    expect(breaker.lookup(denyKey({ turn: 2 }))).toBe(false)
    breaker.clearParent('parent-a')
    expect(breaker.lookup(denyKey())).toBe(false)
  })
})

describe('InMemoryAllowCache', () => {
  it('records exact allows scoped by configuration and generation', () => {
    const cache = new InMemoryAllowCache()
    expect(cache.lookup(allowKey())).toBe(false)
    cache.recordGuardianAllow(allowKey())
    expect(cache.lookup(allowKey())).toBe(true)
    expect(cache.lookup(allowKey({ generation: 'generation-2' }))).toBe(false)
    expect(cache.lookup(allowKey({ configurationFingerprint: hash('c') }))).toBe(false)
    cache.clearParent('parent-a')
    expect(cache.lookup(allowKey())).toBe(false)
  })
})

describe('InMemorySealedDispositionRegistry', () => {
  it('seals, replays, rejects mismatches, and consumes exactly once', () => {
    const registry = new InMemorySealedDispositionRegistry()
    registry.seal(sealed())
    expect(registry.lookup('ask-1', 'call-1', hash('a'))).toEqual({ kind: 'sealed', disposition: sealed() })
    expect(registry.lookup('ask-1', 'call-other', hash('a')).kind).toBe('mismatch')
    expect(registry.lookup('ask-1', 'call-1', hash('c')).kind).toBe('mismatch')
    expect(registry.lookup('ask-missing', 'call-1', hash('a')).kind).toBe('missing')
    expect(registry.consume('ask-1', 'call-1')).toBe(true)
    expect(registry.consume('ask-1', 'call-1')).toBe(false)
    expect(registry.lookup('ask-1', 'call-1', hash('a')).kind).toBe('consumed')
  })

  it('rejects duplicate seals and clears one parent only', () => {
    const registry = new InMemorySealedDispositionRegistry()
    registry.seal(sealed())
    expect(() => registry.seal(sealed())).toThrow(/already exists/)
    registry.seal(sealed({ requestId: 'ask-2', parentSessionId: 'parent-2' }))
    registry.clearParent('parent-1')
    expect(registry.lookup('ask-1', 'call-1', hash('a')).kind).toBe('missing')
    expect(registry.lookup('ask-2', 'call-1', hash('a')).kind).toBe('sealed')
  })
})

describe('createToolApprovalClassifier', () => {
  const catalog = {
    version: 1 as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: hash('f'),
    descriptors: [
      { toolName: 'bash', toolSchemaFingerprint: hash('bash'), classification: 'body-escalation' as const },
      { toolName: 'read', toolSchemaFingerprint: hash('read'), classification: 'ordinary' as const },
    ],
  }

  it('classifies exact matches, reports unclassified and fingerprint mismatch', () => {
    const classifier = createToolApprovalClassifier(catalog)
    expect(classifier.classify({ toolName: 'bash', toolSchemaFingerprint: hash('bash') })).toEqual({
      kind: 'classified',
      classification: 'body-escalation',
    })
    expect(classifier.classify({ toolName: 'missing', toolSchemaFingerprint: hash('x') })).toEqual({ kind: 'unclassified' })
    expect(classifier.classify({ toolName: 'bash', toolSchemaFingerprint: hash('drift') })).toEqual({
      kind: 'catalog-mismatch',
    })
  })
})

describe('createTrustEnvelopeEvaluator', () => {
  const config = {
    version: 1 as const,
    enabled: true,
    tools: ['bash' as const, 'filesystem' as const],
    maxRequestedMode: 'workspace-write' as const,
    workspaceOnly: true,
    requireJustification: false,
    requireStrictWidening: false,
  }

  const baseInput = {
    toolFamily: 'bash' as const,
    effectiveMode: 'read-only' as const,
    workspaceRoot: '/work',
    targets: ['/work/src'],
  }

  it('admits an in-workspace read-only bash call', () => {
    const evaluator = createTrustEnvelopeEvaluator(config)
    expect(evaluator.evaluate(baseInput)).toEqual({ kind: 'inside' })
  })

  it('rejects disabled envelopes, uncovered families, and mode above ceiling', () => {
    const evaluator = createTrustEnvelopeEvaluator({ ...config, enabled: false })
    expect(evaluator.evaluate(baseInput).kind).toBe('outside')

    const uncovered = createTrustEnvelopeEvaluator(config)
    expect(uncovered.evaluate({ ...baseInput, toolFamily: 'network' }).kind).toBe('outside')

    const aboveCeiling = createTrustEnvelopeEvaluator({ ...config, maxRequestedMode: 'read-only' })
    expect(aboveCeiling.evaluate({ ...baseInput, requestedMode: 'workspace-write' }).kind).toBe('outside')
  })

  it('rejects outside-workspace targets and missing required justification', () => {
    const evaluator = createTrustEnvelopeEvaluator(config)
    expect(evaluator.evaluate({ ...baseInput, targets: ['/etc/passwd'] })).toEqual({
      kind: 'outside',
      reason: 'outside-workspace',
    })

    const strictJustification = createTrustEnvelopeEvaluator({ ...config, requireJustification: true })
    expect(strictJustification.evaluate(baseInput)).toEqual({
      kind: 'outside',
      reason: 'missing-justification',
    })
    expect(strictJustification.evaluate({ ...baseInput, justification: 'needed' })).toEqual({ kind: 'inside' })
  })

  it('accepts only strict ladder widening when strict widening is required', () => {
    const evaluator = createTrustEnvelopeEvaluator({
      ...config,
      requireStrictWidening: true,
    })
    // read-only -> workspace-write is exactly one strict step.
    expect(evaluator.evaluate({
      ...baseInput,
      requestedMode: 'workspace-write',
    })).toEqual({ kind: 'inside' })
    // Same level is not a widening.
    expect(evaluator.evaluate({
      ...baseInput,
      effectiveMode: 'workspace-write',
      requestedMode: 'workspace-write',
    })).toEqual({
      kind: 'outside',
      reason: 'not-strictly-wider',
    })
  })
})
