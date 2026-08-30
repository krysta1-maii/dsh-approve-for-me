import { describe, expect, it } from 'vitest'
import { InMemoryReviewerTelemetry } from '../../src/index.js'

describe('InMemoryReviewerTelemetry', () => {
  it('aggregates only bounded scalar reviewer observations', () => {
    const telemetry = new InMemoryReviewerTelemetry()
    telemetry.observe({
      kind: 'review', outcome: 'allow', durationMs: 12, attempts: 1,
      contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    })
    telemetry.observe({
      kind: 'review', outcome: 'error', durationMs: 7, attempts: 2,
      contaminatedRotationAttempts: 1, contaminatedRotations: 1, failure: 'invalid-result',
    })
    telemetry.observe({ kind: 'fallback' })

    expect(telemetry.snapshot()).toEqual(expect.objectContaining({
      reviews: 2, allow: 1, errors: 1, fallbacks: 1, attempts: 3,
      contaminatedRotationAttempts: 1, contaminatedRotations: 1,
      durationMs: { sum: 19, max: 12 },
      failures: expect.objectContaining({ 'invalid-result': 1, aborted: 0 }),
    }))
  })
})
