import { describe, expect, it, vi } from 'vitest'
import {
  DefaultGatePipeline,
  GateFailure,
  InMemoryExactDenialBreaker,
  InMemorySealedDispositionRegistry,
  createActionSnapshot,
  assessVerifiedActionV1,
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
  breaker?: GatePipelineDependencies['breaker']
  allowHit?: boolean
  preReview?: GatePreReview
  records?: GateDecisionRecordStore
  now?: () => number
  reviewerTelemetry?: GatePipelineDependencies['reviewerTelemetry']
} = {}) {
  const seals = new InMemorySealedDispositionRegistry()
  const records = overrides.records ?? recordsStub()
  const preReview = overrides.preReview ?? { preReview: vi.fn(async () => sealed('allow')) }
  const factsResolver = { resolve: vi.fn(async () => overrides.factsResult === undefined ? facts(
    overrides.trustInside === undefined ? {} : {
      trustEnvelope: {
        toolFamily: 'bash', effectiveMode: 'read-only', workspaceRoot: '/workspace', targets: [],
      },
    },
  ) : overrides.factsResult) }
  const evaluate = vi.fn((_input: TrustEnvelopeInputV1): TrustEnvelopeEvaluationV1 =>
    overrides.trustInside === true
      ? { kind: 'inside' }
      : { kind: 'outside', reason: 'tool-family-not-covered' })
  const deps: GatePipelineDependencies = {
    classifier: { classify: vi.fn() },
    trustEnvelope: { evaluate },
    breaker: overrides.breaker ?? {
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
    ...overrides.reviewerTelemetry === undefined ? {} : { reviewerTelemetry: overrides.reviewerTelemetry },
  }
  return { pipeline: new DefaultGatePipeline(deps), seals, records, preReview, factsResolver, deps }
}

describe('DefaultGatePipeline', () => {
  it('fails closed in every mode when requestId or callId is missing', async () => {
    const auto = makePipeline()
    await expect(auto.pipeline.decide(request('auto', false))).resolves.toBe('unavailable')
    const user = makePipeline({ mode: 'auto-then-user' })
    await expect(user.pipeline.decide(request('auto-then-user', false))).resolves.toBe('unavailable')
    const withoutRequestId = request('auto-then-user') as { requestId?: string } & Omit<GateMachineRequestV1, 'requestId'>
    delete withoutRequestId.requestId
    await expect(user.pipeline.decide(withoutRequestId)).resolves.toBe('unavailable')
    expect(user.factsResolver.resolve).not.toHaveBeenCalled()
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
    expect(records.createConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      version: 1, route: 'trust-envelope', normalizedDecision: 'allow', pluginDisposition: 'allow',
    }))
  })

  it('routes an unknown R4 assessment to Guardian instead of a fast-path grant', async () => {
    const assessed = action()
    const preReview = { preReview: vi.fn(async () => sealed('human')) }
    const { pipeline, records } = makePipeline({
      trustInside: true,
      preReview,
      factsResult: facts({ action: assessed, assessment: assessVerifiedActionV1(assessed, [2]) }),
    })
    await expect(pipeline.decide(request())).resolves.toBe('rejected')
    expect(preReview.preReview).toHaveBeenCalledOnce()
    expect(records.createConfirmed).not.toHaveBeenCalled()
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

  it('does not allow when the request aborts during trust-envelope confirmation', async () => {
    const abort = new AbortController()
    const records = recordsStub({
      createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => {
        abort.abort()
        return 'confirmed'
      }),
    })
    const { pipeline, deps } = makePipeline({ trustInside: true, records })
    await expect(pipeline.decide({ ...request(), signal: abort.signal })).resolves.toBe('cancelled')
    expect(deps.allowCache.recordGuardianAllow).not.toHaveBeenCalled()
  })

  it('confirms each cached allow without a Guardian review', async () => {
    const { pipeline, preReview, records } = makePipeline({ allowHit: true })
    await expect(pipeline.decide(request())).resolves.toBe('allowed-once')
    expect(preReview.preReview).not.toHaveBeenCalled()
    expect(records.createConfirmed).toHaveBeenCalledOnce()
    expect(records.createConfirmed).toHaveBeenCalledWith(expect.objectContaining({ route: 'allow-cache' }))
  })

  it('does not allow a cached decision without durable confirmation', async () => {
    const { pipeline, preReview } = makePipeline({
      allowHit: true,
      records: recordsStub({ createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => 'unavailable') }),
      mode: 'auto-then-user',
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
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

  it('requires durable confirmation for a replayed sealed allow', async () => {
    const records = recordsStub({ createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => 'unavailable') })
    const { pipeline, preReview, seals } = makePipeline({ records, mode: 'auto-then-user' })
    seals.seal(sealed('allow'))
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    expect(preReview.preReview).not.toHaveBeenCalled()
    expect(records.createConfirmed).toHaveBeenCalledOnce()
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

  it('suppresses a later exact action after Guardian deny without re-reviewing it', async () => {
    const breaker = new InMemoryExactDenialBreaker()
    const preReview = { preReview: vi.fn(async () => sealed('deny')) }
    const { pipeline } = makePipeline({ breaker, preReview })

    await expect(pipeline.decide(request())).resolves.toBe('rejected')
    await expect(pipeline.decide({ ...request(), requestId: 'ask-2', callId: 'call-2' })).resolves.toBe('rejected')

    expect(preReview.preReview).toHaveBeenCalledOnce()
  })

  it('preserves non-allow outcomes when best-effort audit storage fails', async () => {
    const records = recordsStub({ recordBestEffort: vi.fn(async () => { throw new Error('storage down') }) })
    const deny = makePipeline({ records, preReview: { preReview: vi.fn(async () => sealed('deny')) } })
    await expect(deny.pipeline.decide(request())).resolves.toBe('rejected')

    const human = makePipeline({
      records,
      mode: 'auto-then-user',
      preReview: { preReview: vi.fn(async () => sealed('human')) },
    })
    await expect(human.pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    expect(records.recordBestEffort).toHaveBeenCalledTimes(2)
  })

  it('observes only final user fallbacks and ignores telemetry failure', async () => {
    const observe = vi.fn()
    const telemetry = { observe }
    const delegated = makePipeline({
      mode: 'auto-then-user', reviewerTelemetry: telemetry,
      preReview: { preReview: vi.fn(async () => sealed('human')) },
    })
    await expect(delegated.pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    expect(observe).toHaveBeenCalledWith({ kind: 'fallback' })

    const throwing = makePipeline({
      mode: 'auto-then-user', reviewerTelemetry: { observe: () => { throw new Error('telemetry down') } },
      preReview: { preReview: vi.fn(async () => sealed('human')) },
    })
    await expect(throwing.pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')

    const rejected = makePipeline({ reviewerTelemetry: telemetry, preReview: { preReview: vi.fn(async () => sealed('deny')) } })
    await expect(rejected.pipeline.decide(request())).resolves.toBe('rejected')
    expect(observe).toHaveBeenCalledOnce()
  })

  it('does not replay an expired sealed disposition', async () => {
    const { pipeline, preReview, seals } = makePipeline({ now: () => 300 })
    seals.seal({ ...sealed('allow'), deadlineAt: 200 })
    await expect(pipeline.decide(request())).resolves.toBe('unavailable')
    expect(preReview.preReview).not.toHaveBeenCalled()
  })

  it('does not confirm or cache an expired initial Guardian disposition', async () => {
    const preReview = { preReview: vi.fn(async () => ({ ...sealed('allow'), deadlineAt: 200 })) }
    const { pipeline, records, deps } = makePipeline({ preReview, now: () => 201 })
    await expect(pipeline.decide(request())).resolves.toBe('unavailable')
    expect(records.createConfirmed).not.toHaveBeenCalled()
    expect(deps.allowCache.recordGuardianAllow).not.toHaveBeenCalled()
  })

  it('does not allow when durable confirmation crosses the review deadline', async () => {
    let now = 199
    const records = recordsStub({
      createConfirmed: vi.fn(async (): Promise<GateDecisionRecordResult> => {
        now = 200
        return 'confirmed'
      }),
    })
    const preReview = { preReview: vi.fn(async () => ({ ...sealed('allow'), deadlineAt: 200 })) }
    const { pipeline, deps } = makePipeline({ preReview, records, now: () => now })
    await expect(pipeline.decide(request())).resolves.toBe('unavailable')
    expect(records.createConfirmed).toHaveBeenCalledOnce()
    expect(deps.allowCache.recordGuardianAllow).not.toHaveBeenCalled()
  })

  it('maps Guardian allow/deny/human and records accordingly', async () => {
    const allow = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('allow')) } })
    await expect(allow.pipeline.decide(request())).resolves.toBe('allowed-once')
    expect(allow.records.createConfirmed).toHaveBeenCalledOnce()
    expect(allow.records.createConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      version: 1, route: 'guardian', normalizedDecision: 'allow', pluginDisposition: 'allow', reviewRunId: 'run-1',
    }))

    const deny = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('deny')) } })
    await expect(deny.pipeline.decide(request())).resolves.toBe('rejected')
    expect(deny.records.recordBestEffort).toHaveBeenCalledOnce()

    const human = makePipeline({ preReview: { preReview: vi.fn(async () => sealed('human')) } })
    await expect(human.pipeline.decide(request())).resolves.toBe('rejected')
    expect(human.deps.breaker.recordGuardianDeny).not.toHaveBeenCalled()

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

  it('delegates only explicit retryable pre-review failures', async () => {
    const retryable = { preReview: vi.fn(async () => { throw new GateFailure('retryable-capability', 'reviewer temporarily unavailable') }) }
    const auto = makePipeline({ preReview: retryable, mode: 'auto' })
    await expect(auto.pipeline.decide(request())).resolves.toBe('unavailable')
    const user = makePipeline({ preReview: retryable, mode: 'auto-then-user' })
    await expect(user.pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
  })

  it('keeps integrity failures and aborts out of the human waterfall', async () => {
    const integrity = makePipeline({
      mode: 'auto-then-user',
      preReview: { preReview: vi.fn(async () => { throw new GateFailure('integrity', 'dossier mismatch') }) },
    })
    await expect(integrity.pipeline.decide(request('auto-then-user'))).resolves.toBe('unavailable')
    const abort = new AbortController()
    abort.abort()
    await expect(integrity.pipeline.decide({ ...request('auto-then-user'), signal: abort.signal })).resolves.toBe('cancelled')
  })
})
