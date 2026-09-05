import {
  GATE_FAILURE_CODES,
} from './gate-failure.js'
import type { GateFailureCode } from './gate-failure.js'
import type {
  GateFailureMetricsObservationV1,
  GateFailureMetricsSink,
  GateFailureMetricsSnapshotV1,
} from '../ports/gate-failure-metrics.js'

/** Bounded scalar-only aggregate; it retains no requests, identities, or content. */
export class InMemoryGateFailureMetrics implements GateFailureMetricsSink {
  private total = 0
  private unavailable = 0
  private delegates = 0
  private readonly failures: Record<GateFailureCode, number> =
    Object.fromEntries(GATE_FAILURE_CODES.map(code => [code, 0])) as Record<GateFailureCode, number>

  observe(observation: GateFailureMetricsObservationV1): void {
    this.total += 1
    if (observation.outcome === 'unavailable') this.unavailable += 1
    else this.delegates += 1
    this.failures[observation.code] += 1
  }

  snapshot(): GateFailureMetricsSnapshotV1 {
    return Object.freeze({
      total: this.total,
      unavailable: this.unavailable,
      delegates: this.delegates,
      failures: Object.freeze({ ...this.failures }),
    })
  }
}
