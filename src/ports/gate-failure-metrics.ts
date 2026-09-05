import type { GateFailureCode } from '../application/gate-failure.js'

/**
 * Scalar-only Gate failure telemetry (WP5-a §4.4). Observation is strictly
 * best-effort and never authorizing. It retains only a typed reason code and the
 * gate outcome, never request identity, packet, rationale or content.
 */
export interface GateFailureMetricsObservationV1 {
  readonly code: GateFailureCode
  readonly outcome: 'unavailable' | 'delegate'
}

export interface GateFailureMetricsSink {
  observe(observation: GateFailureMetricsObservationV1): void
}

export interface GateFailureMetricsSnapshotV1 {
  readonly total: number
  readonly unavailable: number
  readonly delegates: number
  readonly failures: Readonly<Record<GateFailureCode, number>>
}
