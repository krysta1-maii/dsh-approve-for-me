import { describe, expect, it, vi } from 'vitest'
import {
  DefaultGatePipeline,
  InMemorySealedDispositionRegistry,
  createActionSnapshot,
} from '../../src/index.js'
import type {
  GateActionFacts,
  GateDecisionRecordResult,
  GateDecisionRecordStore,
  GateMachineRequestV1,
  GatePipelineDependencies,
  GatePreReview,
  SealedDispositionV1,
  TrustEnvelopeEvaluationV1,
  TrustEnvelopeInputV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

const action = () => createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })

function request(mode: 'auto' | 'auto-then-user' = 'auto', withCallId = true): GateMachineRequestV1 {
  const base = {
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    toolName: 'bash',
    actionHash: hash('a'),
    mode,
  }
  return withCallId ? { ...base, callId: 'call-1' } : base
}

function facts(overrides: Partial<GateActionFacts> = {}): GateActionFacts {
  return {
    action: action(),
    toolSchemaFingerprint: hash('bash'),
    classification: { kind: 'classified', classification: 'body-escalation' },
    breakerKey: { parentLifecycleFingerprint: 'life-1', turn: 1, directUserFrontierSeq: 2, actionHash: hash('a') },
    allowCacheKey: {
      parentLifecycleFingerprint: 'life-1',
      turn: 1,
      directUserFrontierSeq: 2,
      actionHash: hash('a'),
      configurationFingerprint: hash('cfg'),
      generation: 'generation-1',
    },
    rootRequester: true,
    directChildOrigin: false,
    generation: 'generation-1',
    configurationFingerprint: hash('cfg'),
    ...overrides,
  }
}

function sealed(disposition: SealedDispositionV1['disposition']): SealedDispositionV1 {
  return {
    version: 1,
    reviewRunId: 'run-1',
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    callId: 'call-1',
    actionHash: hash('a'),
    generation: 'generation-1',
    configurationFingerprint: hash('cfg'),
    disposition,
    issuedAt: 100,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    replayable: true,
  }
}

function recordsStub(overrides: Partial<GateDecisionRecordStore> = {}): GateDecisionRecordStore {
  return {
    createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => 'confirmed'),
    recordBestEffort: vi.fn(async () => {}),
    ...overrides,
  }
}

function makePipeline(overrides: {
  mode?: 'auto' | 'auto-then-user'
  factsResult?: GateActionFacts | undefined
  trustInside?: boolean
  breakerHit?: boolean
  allowHit?: boolean
  preReview?: GatePreReview
  records?: GateDecisionRecordStore
  now?: () => number
} = {}) {
  const seals = new InMemorySealedDispositionRegistry()
  const records = overrides.records ?? recordsStub()
  const preReview = overrides.preReview ?? { preReview: vi.fn(async () => sealed('allow')) }
  const factsResolver = { resolve: vi.fn(async () => overrides.factsResult === undefined ? facts() : overrides.factsResult) }
  const evaluate = vi.fn((_input: TrustEnvelopeInputV1): TrustEnvelopeEvaluationV1 =>
    overrides.trustInside === true
      ? { kind: 'inside' }
      : { kind: 'outside', reason: 'tool-family-not-covered' })
  const deps: GatePipelineDependencies = {
    classifier: { classify: vi.fn() },
    trustEnvelope: { evaluate },
    breaker: {
      lookup: vi.fn(() => overrides.breakerHit === true),
      recordGuardianDeny: vi.fn(),
      clearParent: vi.fn(),
    },
    allowCache: {
      lookup: vi.fn(() => overrides.allowHit === true),
      recordGuardianAllow: vi.fn(),
      clearParent: vi.fn(),
    },
    seals,
    facts: factsResolver,
    preReview,
    records,
    mode: overrides.mode ?? 'auto',
    ...overrides.now === undefined ? {} : { now: overrides.now },
  }
  return { pipeline: new DefaultGatePipeline(deps), seals, records, preReview, factsResolver, deps }
}

describe('DefaultGatePipeline', () => {
  it('fails closed / delegates when callId is missing', async () => {
    const auto = makePipeline()
    await expect(auto.pipeline.decide(request('auto', false))).resolves.toBe('unavailable')
    const user = makePipeline({ mode: 'auto-then-user' })
    await expect(user.pipeline.decide(request('auto-then-user', false))).resolves.toBe('delegate')
  })

  it('never delegates on direct child origin or missing root requester', async () => {
    const direct = makePipeline({ factsResult: facts({ directChildOrigin: true }) })
    await expect(direct.pipeline.decide(request('auto-then-user'))).resolves.toBe('unavailable')

    const nonRoot = makePipeline({ factsResult: facts({ rootRequester: false }) })
    await expect(nonRoot.pipeline.decide(request('auto-then-user'))).resolves.toBe('unavailable')
  })

  it('rejects immediately on a breaker hit', async () => {
    const { pipeline, preReview } = makePipeline({ breakerHit: true })
    await expect(pipeline.decide(request())).resolves.toBe('rejected')
    expect(preReview.preReview).not.toHaveBeenCalled()
  })

  it('allows through the trust envelope only after a confirmed record', async () => {
    const { pipeline, records } = makePipeline({ trustInside: true })
    await expect(pipeline.decide(request())).resolves.toBe('allowed-once')
    expect(records.createConfirmed).toHaveBeenCalledOnce()
  })

  it('maps an unconfirmed trust-envelope allow to delegate in auto-then-user', async () => {
    const { pipeline } = makePipeline({
      trustInside: true,
      records: recordsStub({
        createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => 'unavailable'),
      }),
      mode: 'auto-then-user',
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
  })

  it('returns a cached allow without a Guardian review', async () => {
    const { pipeline, preReview } = makePipeline({ allowHit: true })
    await expect(pipeline.decide(request())).resolves.toBe('allowed-once')
    expect(preReview.preReview).not.toHaveBeenCalled()
  })

  it('replays a sealed disposition once instead of reviewing again', async () => {
    const { pipeline, preReview, seals } = makePipeline()
    seals.seal(sealed('deny'))
    await expect(pipeline.decide(request())).resolves.toBe('rejected')
    expect(preReview.preReview).not.toHaveBeenCalled()
    // The same ask identity is consumed after replay, not endlessly replayable.
    await expect(pipeline.decide(request())).resolves.toBe('unavailable')
    expect(seals.lookup('ask-1', 'call-1', hash('a')).kind).toBe('consumed')
  })

  it('records guardian deny/allow into the exact breaker and allow cache', async () => {
    const allow = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('allow')) } })
    await allow.pipeline.decide(request())
    expect(allow.deps.allowCache.recordGuardianAllow).toHaveBeenCalledWith(facts().allowCacheKey)

    const deny = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('deny')) } })
    await deny.pipeline.decide(request())
    expect(deny.deps.breaker.recordGuardianDeny).toHaveBeenCalledWith(facts().breakerKey)
  })

  it('does not replay an expired sealed disposition', async () => {
    const { pipeline, preReview, seals } = makePipeline({ now: () => 300 })
    seals.seal({ ...sealed('allow'), deadlineAt: 200 })
    await expect(pipeline.decide(request())).resolves.toBe('unavailable')
    expect(preReview.preReview).not.toHaveBeenCalled()
  })

  it('maps Guardian allow/deny/human and records accordingly', async () => {
    const allow = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('allow')) } })
    await expect(allow.pipeline.decide(request())).resolves.toBe('allowed-once')
    expect(allow.records.createConfirmed).toHaveBeenCalledOnce()

    const deny = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('deny')) } })
    await expect(deny.pipeline.decide(request())).resolves.toBe('rejected')
    expect(deny.records.recordBestEffort).toHaveBeenCalledOnce()

    const human = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('human')) } })
    await expect(human.pipeline.decide(request())).resolves.toBe('rejected')

    const humanUser = makePipeline({
      mode: 'auto-then-user',
      preReview: { preReview: vi.fn(async () => sealed('human')) },
    })
    await expect(humanUser.pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
  })

  it('does not allow when the decision record conflicts', async () => {
    const { pipeline } = makePipeline({
      records: recordsStub({
        createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => 'conflict'),
      }),
      mode: 'auto-then-user',
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('unavailable')
  })
})
