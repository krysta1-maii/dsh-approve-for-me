import type { DossierMetricsV1 } from '../domain/dossier.js'

/** Non-sensitive observation of one dossier compilation attempt. */
export interface DossierCompilationObservationV1 {
  readonly outcome: 'ready' | 'budget-overflow' | 'incomplete' | 'error'
  readonly reason?: string
  readonly durationMs: number
  readonly metrics?: DossierMetricsV1
}

/** Best-effort telemetry seam; failures must never affect authorization. */
export interface DossierCompilationMetricsSink {
  observe(observation: DossierCompilationObservationV1): void
}

export interface DossierSectionAggregateV1 {
  readonly count: number
  readonly bytesSum: number
  readonly bytesMax: number
  readonly charactersSum: number
  readonly charactersMax: number
}

/** Bounded aggregate suitable for in-process baseline measurement. */
export interface DossierCompilationMetricsSnapshotV1 {
  readonly attempts: number
  readonly ready: number
  readonly overflow: number
  readonly incomplete: number
  readonly errors: number
  readonly overflowRate: number
  readonly durationMs: { readonly sum: number; readonly max: number }
  readonly sections: Readonly<Record<string, DossierSectionAggregateV1>>
}
