/** Scalar-only Reviewer telemetry. Observation is strictly best-effort. */
export type ReviewerTelemetryFailureV1 =
  | 'invalid-result'
  | 'timed-out'
  | 'aborted'
  | 'disposed'
  | 'delivery-failed'
  | 'infrastructure'

export type ReviewerTelemetryObservationV1 =
  | {
      readonly kind: 'review'
      readonly outcome: 'allow' | 'deny' | 'human' | 'error'
      readonly durationMs: number
      readonly attempts: number
      readonly contaminatedRotationAttempts: number
      readonly contaminatedRotations: number
      readonly failure?: ReviewerTelemetryFailureV1
    }
  | { readonly kind: 'fallback' }

/** Telemetry is observational: an exception here must never alter authorization. */
export interface ReviewerTelemetrySink {
  observe(observation: ReviewerTelemetryObservationV1): void
}

export interface ReviewerTelemetrySnapshotV1 {
  readonly reviews: number
  readonly allow: number
  readonly deny: number
  readonly human: number
  readonly errors: number
  readonly fallbacks: number
  readonly attempts: number
  readonly contaminatedRotationAttempts: number
  readonly contaminatedRotations: number
  readonly durationMs: { readonly sum: number; readonly max: number }
  readonly failures: Readonly<Record<ReviewerTelemetryFailureV1, number>>
}
