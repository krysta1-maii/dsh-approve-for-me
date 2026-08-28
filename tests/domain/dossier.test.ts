import { describe, expect, it } from 'vitest'
import {
  assertDossierShape,
  recomputeDossierHash,
} from '../../src/index.js'
import type { GuardianDossierV1 } from '../../src/index.js'

function dossier(): GuardianDossierV1 {
  return {
    version: 1,
    kind: 'guardian-dossier',
    freeze: {
      parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 },
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
    completeness: { ready: true, missing: [] },
  }
}

describe('Guardian dossier shape', () => {
  it('validates and freezes a well-formed dossier', () => {
    const parsed = assertDossierShape(dossier())
    expect(parsed.version).toBe(1)
    expect(parsed.freeze.parent.sessionId).toBe('parent-1')
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
  })

  it('rejects sections that are not canonical JSON', () => {
    expect(() => assertDossierShape({
      ...dossier(),
      environment: { bad: () => 1 },
    } as never)).toThrow()
  })
})
