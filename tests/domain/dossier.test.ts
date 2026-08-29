import { describe, expect, it } from 'vitest'
import * as publicApi from '../../src/index.js'
import {
  assertDossierShape,
  recomputeDossierHash,
} from '../../src/index.js'
import { sealSourceVerifiedDossier } from '../../src/domain/dossier.js'
import type { GuardianDossierV1 } from '../../src/index.js'

function dossier(): GuardianDossierV1 {
  return {
    version: 1,
    kind: 'guardian-dossier',
    freeze: {
      parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000, cwd: '/workspace' },
      throughSeq: 10,
      currentTurn: 2,
      currentStep: 1,
      frozenAt: 2_000,
    },
    environment: { version: 1, sessionId: 'parent-1' },
    instructions: { version: 1, files: [] },
    interaction: { version: 1, userMessages: [] },
    currentTurnTools: { version: 1, attempts: [] },
    pendingApproval: { version: 1, callId: 'call-1' },
    completeness: { complete: true, sourceThroughSeq: 10, omissions: [] },
  }
}

describe('Guardian dossier shape', () => {
  it('validates and freezes a well-formed dossier', () => {
    const parsed = assertDossierShape(dossier())
    expect(parsed.version).toBe(1)
    expect(parsed.freeze.parent.sessionId).toBe('parent-1')
    expect(parsed.freeze.parent.cwd).toBe('/workspace')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(recomputeDossierHash(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects missing/incorrect discriminators and malformed freeze counters', () => {
    expect(() => assertDossierShape({ ...dossier(), version: 2 })).toThrow(/version/)
    expect(() => assertDossierShape({ ...dossier(), kind: 'other' })).toThrow(/kind/)
    expect(() => assertDossierShape({
      ...dossier(),
      freeze: { ...dossier().freeze, throughSeq: -1 },
    })).toThrow(/throughSeq/)
    expect(() => assertDossierShape({
      ...dossier(),
      completeness: { complete: true, sourceThroughSeq: 9, omissions: [] },
    })).toThrow(/completeness/)
    expect(() => assertDossierShape({
      ...dossier(),
      freeze: { ...dossier().freeze, parent: { ...dossier().freeze.parent, cwd: '' } },
    })).toThrow(/cwd/)
    expect(() => assertDossierShape({
      ...dossier(),
      freeze: { ...dossier().freeze, parent: { ...dossier().freeze.parent, sessionFormatVersion: -1 } },
    })).toThrow(/parent/)
    expect(() => assertDossierShape({
      ...dossier(),
      freeze: { ...dossier().freeze, parent: { ...dossier().freeze.parent, createdAt: 1.5 } },
    })).toThrow(/parent/)
  })

  it('rejects sections that are not canonical JSON', () => {
    expect(() => assertDossierShape({
      ...dossier(),
      environment: { bad: () => 1 },
    } as never)).toThrow()
  })

  it('does not expose source-verification sealing through the package API', () => {
    expect('sealSourceVerifiedDossier' in publicApi).toBe(false)
  })

  it('validates a dossier before sealing the source-verified wrapper', () => {
    expect(() => sealSourceVerifiedDossier({
      ...dossier(),
      freeze: { ...dossier().freeze, parent: { ...dossier().freeze.parent, sessionId: '' } },
    })).toThrow(/parent/)
  })
})
