import { describe, expect, it } from 'vitest'
import {
  DefaultDossierCompiler,
  createActionSnapshot,
  recomputeDossierHash,
  sealSourceVerifiedDossier,
} from '../../src/index.js'
import type {
  GuardianDossierCompilerDependencies,
  ParentSessionFactSnapshotV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

const session = {
  sessionId: 'parent-1',
  sessionFormatVersion: 0,
  createdAt: 1_000,
  effectiveDelegationDepth: 0,
}

function catalog() {
  return {
    version: 1 as const,
    eventProjectionPolicyId: 'dsh-session-facts-v1' as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: hash('c'),
    descriptors: [
      { classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' },
    ],
  }
}

function facts(overrides: Partial<ParentSessionFactSnapshotV1> = {}): ParentSessionFactSnapshotV1 {
  const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
  return {
    version: 1,
    session,
    eventProjection: { policyId: 'dsh-session-facts-v1', classificationCatalog: catalog() },
    approvalBinding: {
      event: { seq: 5, type: 'approval/asked', turn: 1, step: 0 },
      approvalRequestId: 'ask-1',
      callId: 'call-1',
      toolName: 'bash',
    },
    throughSeq: 5,
    events: [],
    delegationReceipts: [],
    executionFacts: [{
      version: 1,
      session,
      request: { kind: 'model-tool-call', eventSeq: 5, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      toolClassification: {
        classificationCatalogFingerprint: hash('c'),
        descriptor: { classification: 'ordinary', toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' },
      },
      projection: { projectorId: 'default-v1', action, actionHash: hash('a'), observedAt: 1 },
    }],
    approvalSnapshots: [{
      version: 1,
      session,
      approvalRequestId: 'ask-1',
      approvalAskedSeq: 5,
      environment: { version: 1, sessionId: 'parent-1' },
    }],
    ...overrides,
  }
}

const deps: GuardianDossierCompilerDependencies = {
  delegationProjector: {
    catalog: catalog(),
    project() {
      return { kind: 'invalid', reason: 'not-used' }
    },
  },
}

describe('DefaultDossierCompiler', () => {
  it('returns ready for a principal execution fact with approval snapshot', () => {
    const compiler = new DefaultDossierCompiler(deps)
    const result = compiler.compile({ facts: facts() })
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.verified.dossier.freeze.throughSeq).toBe(5)
    expect(result.verified.dossier.freeze.frozenAt).toBe(0)
    expect((result.verified.dossier.completeness as { ready: boolean; missing: string[] }).ready).toBe(false)
    expect(result.verified.dossierHash).toBe(recomputeDossierHash(result.verified.dossier))
    expect(result.metrics.eventCount).toBe(0)
  })

  it('is deterministic for the same frozen facts (stable dossier hash)', () => {
    const compiler = new DefaultDossierCompiler(deps)
    const first = compiler.compile({ facts: facts() })
    const second = compiler.compile({ facts: facts() })
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected ready')
    expect(first.verified.dossierHash).toBe(second.verified.dossierHash)
    expect(first.verified.dossier).toEqual(second.verified.dossier)
  })

  it('returns incomplete for delegated requester, missing call id, and missing execution fact', () => {
    const compiler = new DefaultDossierCompiler(deps)
    expect(compiler.compile({
      facts: facts({ session: { ...session, effectiveDelegationDepth: 1 } }),
    }).kind).toBe('incomplete')
    expect(compiler.compile({
      facts: facts({ approvalBinding: { ...facts().approvalBinding, callId: '' } }),
    }).kind).toBe('incomplete')
    expect(compiler.compile({
      facts: facts({ executionFacts: [] }),
    }).kind).toBe('incomplete')
  })

  it('seals a source-verified dossier with the module brand available through the compiler output', () => {
    const compiler = new DefaultDossierCompiler(deps)
    const result = compiler.compile({ facts: facts() })
    if (result.kind !== 'ready') throw new Error('expected ready')
    const resealed = sealSourceVerifiedDossier(result.verified.dossier)
    expect(resealed.dossierHash).toBe(result.verified.dossierHash)
  })
})
