import { describe, expect, it } from 'vitest'
import { InMemoryGateFailureMetrics } from '../../src/application/gate-failure-metrics.js'

describe('InMemoryGateFailureMetrics (WP5-a §4.4)', () => {
  it('counts each gate failure code and the unavailable/delegate split', () => {
    const metrics = new InMemoryGateFailureMetrics()
    const empty = metrics.snapshot()
    expect(empty).toMatchObject({ total: 0, unavailable: 0, delegates: 0 })
    // The closed failure-code set is fully initialized to zero.
    expect(empty.failures['seal-chain-invalid']).toBe(0)
    expect(empty.failures['activity-projection-invalid']).toBe(0)
    expect(empty.failures['tail-budget-overflow']).toBe(0)
    expect((Object.keys(empty.failures) as string[]).length).toBeGreaterThanOrEqual(15)

    metrics.observe({ code: 'seal-chain-invalid', outcome: 'unavailable' })
    metrics.observe({ code: 'ledger-storage-unavailable', outcome: 'unavailable' })
    metrics.observe({ code: 'tail-budget-overflow', outcome: 'delegate' })
    const snap = metrics.snapshot()
    expect(snap).toMatchObject({ total: 3, unavailable: 2, delegates: 1 })
    expect(snap.failures['seal-chain-invalid']).toBe(1)
    expect(snap.failures['ledger-storage-unavailable']).toBe(1)
    expect(snap.failures['tail-budget-overflow']).toBe(1)
    expect(snap.failures['seal-live-rebind-failed']).toBe(0)
  })

  it('never retains identities or content, only scalar counts', () => {
    const metrics = new InMemoryGateFailureMetrics()
    metrics.observe({ code: 'sealed-current-conflict', outcome: 'unavailable' })
    const snap = metrics.snapshot()
    expect(JSON.stringify(snap)).not.toMatch(/parent-|request-|call-/)
    expect(snap.failures['sealed-current-conflict']).toBe(1)
  })
})
