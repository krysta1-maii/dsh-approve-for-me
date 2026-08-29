import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryDossierCompilationMetrics,
  InstrumentedDossierCompiler,
} from '../../src/index.js'
import type {
  DossierCompilationResultV1,
  GuardianDossierCompiler,
  ParentSessionFactSnapshotV1,
} from '../../src/index.js'

const metrics = {
  dossierVersion: 1 as const,
  delegationClassificationCatalogFingerprint: 'sha256:catalog',
  bytes: 100,
  characters: 100,
  sections: [{ name: 'environment' as const, bytes: 10, characters: 10 }],
  eventCount: 1,
  includedEventCount: 1,
  excludedEventCount: 0,
  delegationEntryCount: 0,
  attemptCount: 1,
  totalBytes: 0,
}

function compiler(result: DossierCompilationResultV1): GuardianDossierCompiler {
  return { compile: vi.fn(() => result) }
}

const facts = {} as ParentSessionFactSnapshotV1

describe('InstrumentedDossierCompiler', () => {
  it('records duration and bounded outcome aggregates without changing results', () => {
    let time = 10
    const collector = new InMemoryDossierCompilationMetrics()
    const result = { kind: 'incomplete' as const, reason: 'budget-overflow' as const, metrics }
    const wrapped = new InstrumentedDossierCompiler(compiler(result), collector, () => time++)
    expect(wrapped.compile({ facts })).toBe(result)
    const snapshot = collector.snapshot()
    expect(snapshot).toMatchObject({ attempts: 1, overflow: 1, overflowRate: 1, durationMs: { sum: 1, max: 1 } })
    expect(snapshot.sections.environment).toEqual({ count: 1, bytesSum: 10, bytesMax: 10, charactersSum: 10, charactersMax: 10 })
  })

  it('records incomplete and thrown attempts while isolating sink failures', () => {
    const collector = new InMemoryDossierCompilationMetrics()
    const incomplete = new InstrumentedDossierCompiler(compiler({ kind: 'incomplete', reason: 'aborted' }), collector, () => 1)
    expect(incomplete.compile({ facts })).toEqual({ kind: 'incomplete', reason: 'aborted' })
    const throwing: GuardianDossierCompiler = { compile: () => { throw new Error('boom') } }
    expect(() => new InstrumentedDossierCompiler(throwing, collector, () => 1).compile({ facts })).toThrow('boom')
    const isolated = new InstrumentedDossierCompiler(compiler({ kind: 'incomplete', reason: 'aborted' }), { observe: () => { throw new Error('telemetry') } })
    expect(isolated.compile({ facts })).toEqual({ kind: 'incomplete', reason: 'aborted' })
    expect(collector.snapshot()).toMatchObject({ attempts: 2, incomplete: 1, errors: 1, overflowRate: 0 })
  })
})
