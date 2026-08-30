import type {
  ReviewerTelemetryFailureV1,
  ReviewerTelemetryObservationV1,
  ReviewerTelemetrySink,
  ReviewerTelemetrySnapshotV1,
} from '../ports/reviewer-telemetry.js'

const FAILURE_KINDS: readonly ReviewerTelemetryFailureV1[] = [
  'invalid-result', 'timed-out', 'aborted', 'disposed', 'delivery-failed', 'infrastructure',
]

/** Bounded scalar-only aggregate; it retains no requests, identities, or content. */
export class InMemoryReviewerTelemetry implements ReviewerTelemetrySink {
  private reviews = 0
  private allow = 0
  private deny = 0
  private human = 0
  private errors = 0
  private fallbacks = 0
  private attempts = 0
  private rotationAttempts = 0
  private rotations = 0
  private durationSum = 0
  private durationMax = 0
  private readonly failures: Record<ReviewerTelemetryFailureV1, number> = {
    'invalid-result': 0, 'timed-out': 0, aborted: 0, disposed: 0, 'delivery-failed': 0, infrastructure: 0,
  }

  observe(observation: ReviewerTelemetryObservationV1): void {
    if (observation.kind === 'fallback') {
      this.fallbacks += 1
      return
    }
    this.reviews += 1
    this.attempts += observation.attempts
    this.rotationAttempts += observation.contaminatedRotationAttempts
    this.rotations += observation.contaminatedRotations
    this.durationSum += observation.durationMs
    this.durationMax = Math.max(this.durationMax, observation.durationMs)
    if (observation.outcome === 'allow') this.allow += 1
    else if (observation.outcome === 'deny') this.deny += 1
    else if (observation.outcome === 'human') this.human += 1
    else {
      this.errors += 1
      if (observation.failure !== undefined) this.failures[observation.failure] += 1
    }
  }

  snapshot(): ReviewerTelemetrySnapshotV1 {
    const failures = Object.fromEntries(FAILURE_KINDS.map(kind => [kind, this.failures[kind]])) as Record<ReviewerTelemetryFailureV1, number>
    return Object.freeze({
      reviews: this.reviews, allow: this.allow, deny: this.deny, human: this.human,
      errors: this.errors, fallbacks: this.fallbacks, attempts: this.attempts,
      contaminatedRotationAttempts: this.rotationAttempts, contaminatedRotations: this.rotations,
      durationMs: Object.freeze({ sum: this.durationSum, max: this.durationMax }), failures: Object.freeze(failures),
    })
  }
}
