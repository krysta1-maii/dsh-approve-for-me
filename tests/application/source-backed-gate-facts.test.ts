import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParentAuthority } from '../../src/ports/managed-reviewer.js'
import {
  DossierGateFactProjector,
  SourceBackedGateFactResolver,
  fingerprintGateConfigurationV1,
} from '../../src/application/source-backed-gate-facts.js'
import { createSealedDossierCompiler } from '../../src/application/sealed-dossier-compiler.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import { createActionSnapshot, hashAction } from '../../src/domain/protocol.js'
import type { SealedDossierCurrentFactsV1, CompileSealed } from '../../src/application/sealed-dossier-compiler.js'
import type { SealedParentSessionFactsV1, SealedFactsReadResult } from '../../src/dsh/parent-session-fact-source.js'

const agent = { id: 'session-1', session: { id: 'session-1' } } as unknown as Agent
const authority = { sessionId: 'session-1' } as unknown as ParentAuthority<Agent, string>
const reviewerConfigurationFingerprint = `sha256:${'9'.repeat(64)}`
const lifecycleFingerprint = 'lifecycle-1'
const hash = (char: string) => `sha256:${char.repeat(64)}`
const catalogCommitmentFingerprint = hash('c')
const classificationCatalogFingerprint = hash('a')

function baseAction() {
  return createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
}

function currentFacts(overrides: Partial<SealedDossierCurrentFactsV1> = {}): SealedDossierCurrentFactsV1 {
  const action = baseAction()
  return {
    action,
    classification: 'body-escalation',
    classificationCatalogFingerprint,
    approvalRequestId: 'ask-1',
    callId: 'call-1',
    toolName: 'bash',
    requestEventSeq: 5,
    approvalAsked: { seq: 6, type: 'approval/asked', turn: 1, step: 0 },
    freeze: {
      parent: { sessionId: 'session-1', sessionFormatVersion: 0, createdAt: 1_000, cwd: '/workspace' },
      throughSeq: 6,
      currentTurn: 1,
      currentStep: 0,
      frozenAt: 1_007,
    },
    ...overrides,
  }
}

function packet(overrides: Partial<SealedParentSessionFactsV1> = {}): SealedParentSessionFactsV1 {
  return {
    version: 1,
    lifecycleFingerprint,
    seals: [],
    activities: [],
    catalogEpochs: [{ epoch: 0, headerEventSeq: 3, commitment: catalogCommitmentFingerprint }],
    ...overrides,
  }
}

function compileSealed(budget = 256_000): CompileSealed {
  return createSealedDossierCompiler({ maxHotPacketBytes: budget })
}

function sealedDossier() {
  const facts = packet()
  const compile = compileSealed()
  const result = compile({ packet: facts, current: currentFacts() })
  if (result.kind !== 'ready') throw new Error('expected a ready sealed dossier')
  return { facts, verified: result.verified }
}

const request = {
  requestId: 'ask-1', parentSessionId: 'session-1', callId: 'call-1',
  toolName: 'bash', actionHash: hashAction(baseAction()), deadlineAt: Number.MAX_SAFE_INTEGER, mode: 'auto' as const,
}

function pending() {
  return { ...request, actionHash: hashAction(baseAction()), agent, authority }
}

function carrier() {
  return {
    toolSchemaFingerprint: 'bash-fingerprint',
    requester: { effectiveDelegationDepth: 0 },
    frontierSeq: 6,
    catalogCommitmentFingerprint,
  }
}

function validAskInput(userAgent: Agent = agent) {
  const action = baseAction()
  const schemas = [{ name: 'bash', description: 'bash schema', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
  const effective = createDshAlpha2EffectiveCatalog(schemas)
  const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
  const session = { sessionId: 'session-1', sessionFormatVersion: 0, createdAt: 1_000, cwd: '/workspace' }
  const executionFact = {
    version: 1 as const,
    catalogCommitment: commitment,
    session,
    request: { kind: 'model-tool-call' as const, eventSeq: 5, eventType: 'tool/call' as const, callId: 'call-1', toolName: 'bash' },
    toolClassification: { classificationCatalogFingerprint, descriptor: effective.dossier.descriptors[0]! },
    projection: { projectorId: action.projectorId, action, actionHash: hashAction(action), observedAt: 1_000 },
  }
  const approvalSnapshot = {
    version: 1 as const,
    session,
    approvalRequestId: 'ask-1',
    approvalAskedSeq: 6,
    execution: { requestEventSeq: 5, callId: 'call-1', toolName: 'bash', actionHash: hashAction(action), classificationCatalogFingerprint, projectorId: action.projectorId },
    environment: { version: 1 as const, kind: 'native-header-only' as const },
  }
  const freeze = {
    parent: { sessionId: 'session-1', sessionFormatVersion: 0, createdAt: 1_000, cwd: '/workspace' },
    throughSeq: 6,
    currentTurn: 1,
    currentStep: 0,
    frozenAt: 1_007,
  }
  return { agent: userAgent, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash', executionFact, approvalSnapshot, approvalAsked: { seq: 6, type: 'approval/asked', turn: 1, step: 0 }, freeze, requester: { effectiveDelegationDepth: 0 } }
}

function resolver() {
  const read = vi.fn(async (): Promise<SealedFactsReadResult> => ({ kind: 'ok', facts: packet() }))
  const compile = vi.fn(compileSealed())
  const snapshotInput = vi.fn()
  const project = vi.fn()
  return {
    read,
    compile,
    snapshotInput,
    project,
    resolver: new SourceBackedGateFactResolver({
      sealedFacts: { read },
      compileSealed: compile,
      maxSealedTailEvents: 512,
      projector: { project },
      snapshotInput,
    }),
  }
}

describe('DossierGateFactProjector (sealed)', () => {
  it('rebuilds gate keys from the branded sealed dossier and provenance frontier only', () => {
    const { facts, verified } = sealedDossier()
    const projector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v2')
    const got = projector.project({ request, pending: pending(), facts, sealedCurrent: carrier(), verifiedDossier: verified })
    expect(got).toMatchObject({
      rootRequester: true,
      breakerKey: { parentLifecycleFingerprint: lifecycleFingerprint, turn: 1, directUserFrontierSeq: 6, actionHash: request.actionHash },
      policyVersion: 'policy-v2',
    })
    expect(got?.classification).toEqual({ kind: 'classified', classification: 'body-escalation' })
    expect(got?.configurationFingerprint).toBe(fingerprintGateConfigurationV1(reviewerConfigurationFingerprint, catalogCommitmentFingerprint))
    expect(got?.assessment).toMatchObject({ authorization: { level: 'unknown' } })
  })

  it('rejects an action binding that does not match the pending ask', () => {
    const { facts, verified } = sealedDossier()
    const projector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v2')
    const ask = { ...pending(), actionHash: hash('f') }
    expect(projector.project({ request: { ...request, actionHash: hash('f') }, pending: ask, facts, sealedCurrent: carrier(), verifiedDossier: verified })).toBeUndefined()
  })

  it('fails closed on a non-closed-set classification string', () => {
    const facts = packet()
    const compile = compileSealed()
    const result = compile({ packet: facts, current: currentFacts({ classification: 'class-1' }) })
    if (result.kind !== 'ready') throw new Error('expected ready')
    const projector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v2')
    expect(projector.project({ request, pending: pending(), facts, sealedCurrent: carrier(), verifiedDossier: result.verified })).toBeUndefined()
  })

  it('reports a non-root requester when delegation depth or parent session is set', () => {
    const { facts, verified } = sealedDossier()
    const projector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v2')
    const got = projector.project({
      request, pending: pending(), facts, verifiedDossier: verified,
      sealedCurrent: { ...carrier(), requester: { effectiveDelegationDepth: 1, parentSessionId: 'parent-1' } },
    })
    expect(got?.rootRequester).toBe(false)
  })
})

describe('SourceBackedGateFactResolver (sealed channel)', () => {
  it('does not consult a source without the complete exact ask correlation', async () => {
    const subject = resolver()
    const { requestId: _requestId, ...withoutRequestId } = request
    await expect(subject.resolver.resolve(withoutRequestId)).resolves.toBeUndefined()
    await expect(subject.resolver.resolve({ ...request, actionHash: hash('f') })).resolves.toBeUndefined()
    expect(subject.snapshotInput).not.toHaveBeenCalled()
    expect(subject.read).not.toHaveBeenCalled()
  })

  it('registration is metadata only and rejects conflicting replacement', () => {
    const subject = resolver()
    const p = pending()
    subject.resolver.register(p)
    expect(subject.resolver.authorityFor('session-1')).toBe(authority)
    expect(() => subject.resolver.register({ ...p })).toThrow(/already registered/)
  })

  it('routes a sealed unavailable result to undefined (no delegate, no compile)', async () => {
    const subject = resolver()
    subject.resolver.register(pending())
    subject.snapshotInput.mockResolvedValue({ agent, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' })
    subject.read.mockResolvedValue({ kind: 'unavailable', reason: 'chain-discontinuity' })
    await expect(subject.resolver.resolve(request)).resolves.toBeUndefined()
    expect(subject.compile).not.toHaveBeenCalled()
  })

  it('routes a sealed tail-budget overflow to the explicit typed reason code', async () => {
    const subject = resolver()
    subject.resolver.register(pending())
    subject.snapshotInput.mockResolvedValue({ agent, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' })
    subject.read.mockResolvedValue({ kind: 'tail-budget-overflow', sealedCount: 600, maxSealedTailEvents: 512 })
    await expect(subject.resolver.resolve(request)).rejects.toMatchObject({ code: 'tail-budget-overflow' })
  })

  it('routes an empty ledger to the explicit sealed-current-missing code', async () => {
    const subject = resolver()
    subject.resolver.register(pending())
    subject.snapshotInput.mockResolvedValue({ agent, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' })
    subject.read.mockResolvedValue({ kind: 'empty-ledger' })
    await expect(subject.resolver.resolve(request)).rejects.toMatchObject({ code: 'sealed-current-missing' })
  })

  it('requires the exact snapshot input before compiling the sealed packet', async () => {
    const subject = resolver()
    subject.resolver.register(pending())
    subject.snapshotInput.mockResolvedValue({ agent, approvalRequestId: 'ask-1', callId: 'wrong', toolName: 'bash' })
    subject.read.mockResolvedValue({ kind: 'ok', facts: packet() })
    await expect(subject.resolver.resolve(request)).resolves.toBeUndefined()
    expect(subject.compile).not.toHaveBeenCalled()
  })

  it('resolves through the sealed reader + sealed compiler only, never a full session snapshot', async () => {
    const snapshotEvents = vi.fn(() => [])
    const spyAgent = { id: 'session-1', session: { id: 'session-1', snapshotEvents } } as unknown as Agent
    const subject = resolver()
    subject.resolver.register({ ...pending(), agent: spyAgent, authority })
    subject.snapshotInput.mockResolvedValue(validAskInput(spyAgent))
    subject.read.mockResolvedValue({ kind: 'ok', facts: packet() })
    const facts = { action: baseAction(), toolSchemaFingerprint: 'f', classification: { kind: 'classified', classification: 'body-escalation' }, breakerKey: { parentLifecycleFingerprint: lifecycleFingerprint, turn: 1, directUserFrontierSeq: 6, actionHash: request.actionHash }, allowCacheKey: { parentLifecycleFingerprint: lifecycleFingerprint, turn: 1, directUserFrontierSeq: 6, actionHash: request.actionHash, generation: 'g', configurationFingerprint: 'c' }, rootRequester: true, directChildOrigin: false, generation: 'g', configurationFingerprint: 'c', policyVersion: 'p' } as never
    subject.project.mockReturnValue(facts)
    await expect(subject.resolver.resolve(request)).resolves.toBe(facts)
    expect(subject.read).toHaveBeenCalledTimes(1)
    expect(subject.compile).toHaveBeenCalledTimes(1)
    // The hot path never materializes the full session log: only eventAt reads.
    expect(snapshotEvents).not.toHaveBeenCalled()
  })
})
