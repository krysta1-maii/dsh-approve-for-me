import type {
  DossierCompilationResultV1,
  GuardianDossierCompiler,
  ParentSessionFactSnapshotV1,
} from '../domain/dossier.js'
import type {
  DossierCompilationMetricsSink,
  DossierCompilationMetricsSnapshotV1,
  DossierCompilationObservationV1,
  DossierSectionAggregateV1,
} from '../ports/dossier-compilation-metrics.js'

function observationFor(result: DossierCompilationResultV1, durationMs: number): DossierCompilationObservationV1 {
  if (result.kind === 'ready') return Object.freeze({ outcome: 'ready', durationMs, metrics: result.metrics })
  if (result.reason === 'budget-overflow' && 'metrics' in result) {
    return Object.freeze({ outcome: 'budget-overflow', reason: result.reason, durationMs, metrics: result.metrics })
  }
  return Object.freeze({ outcome: 'incomplete', reason: result.reason, durationMs })
}

/** Adds best-effort timing/aggregate observation without changing compiler semantics. */
export class InstrumentedDossierCompiler implements GuardianDossierCompiler {
  constructor(
    private readonly delegate: GuardianDossierCompiler,
    private readonly sink: DossierCompilationMetricsSink,
    private readonly now: () => number = Date.now,
  ) {}

  compile(input: { readonly facts: ParentSessionFactSnapshotV1; readonly signal?: AbortSignal }): DossierCompilationResultV1 {
    const started = this.now()
    try {
      const result = this.delegate.compile(input)
      this.observe(observationFor(result, this.durationSince(started)))
      return result
    } catch (error) {
      this.observe(Object.freeze({ outcome: 'error', durationMs: this.durationSince(started) }))
      throw error
    }
  }

  private durationSince(started: number): number {
    const elapsed = this.now() - started
    return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0
  }

  private observe(observation: DossierCompilationObservationV1): void {
    try { this.sink.observe(observation) } catch { /* telemetry is never authorizing */ }
  }
}

/** In-memory aggregate collector that never retains dossier payloads or identities. */
export class InMemoryDossierCompilationMetrics implements DossierCompilationMetricsSink {
  private attempts = 0
  private ready = 0
  private overflow = 0
  private incomplete = 0
  private errors = 0
  private durationSum = 0
  private durationMax = 0
  private readonly sections = new Map<string, { count: number; bytesSum: number; bytesMax: number; charactersSum: number; charactersMax: number }>()

  observe(observation: DossierCompilationObservationV1): void {
    this.attempts += 1
    if (observation.outcome === 'ready') this.ready += 1
    else if (observation.outcome === 'budget-overflow') this.overflow += 1
    else if (observation.outcome === 'incomplete') this.incomplete += 1
    else this.errors += 1
    this.durationSum += observation.durationMs
    this.durationMax = Math.max(this.durationMax, observation.durationMs)
    for (const section of observation.metrics?.sections ?? []) {
      const aggregate = this.sections.get(section.name) ?? { count: 0, bytesSum: 0, bytesMax: 0, charactersSum: 0, charactersMax: 0 }
      aggregate.count += 1
      aggregate.bytesSum += section.bytes
      aggregate.bytesMax = Math.max(aggregate.bytesMax, section.bytes)
      aggregate.charactersSum += section.characters
      aggregate.charactersMax = Math.max(aggregate.charactersMax, section.characters)
      this.sections.set(section.name, aggregate)
    }
  }

  snapshot(): DossierCompilationMetricsSnapshotV1 {
    const sections: Record<string, DossierSectionAggregateV1> = {}
    for (const [name, aggregate] of this.sections) sections[name] = Object.freeze({ ...aggregate })
    return Object.freeze({
      attempts: this.attempts,
      ready: this.ready,
      overflow: this.overflow,
      incomplete: this.incomplete,
      errors: this.errors,
      overflowRate: this.attempts === 0 ? 0 : this.overflow / this.attempts,
      durationMs: Object.freeze({ sum: this.durationSum, max: this.durationMax }),
      sections: Object.freeze(sections),
    })
  }
}
