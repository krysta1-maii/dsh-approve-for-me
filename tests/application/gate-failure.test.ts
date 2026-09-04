import { describe, expect, it } from 'vitest'
import { GateFailure, gateFailureOutcome } from '../../src/application/gate-failure.js'

describe('gateFailureOutcome WP4-b4 reason-code routing', () => {
  it('routes a sealed tail-budget overflow to delegate only in auto-then-user mode', () => {
    const failure = new GateFailure('tail-budget-overflow', 'sealed tail exceeds the configured budget')
    expect(gateFailureOutcome(failure, 'auto')).toBe('unavailable')
    expect(gateFailureOutcome(failure, 'auto-then-user')).toBe('delegate')
  })

  it('routes a sealed-current-missing gap to delegate only in auto-then-user mode', () => {
    const failure = new GateFailure('sealed-current-missing', 'no sealed facts for this lifecycle; the current action is unsealed pending')
    expect(gateFailureOutcome(failure, 'auto')).toBe('unavailable')
    expect(gateFailureOutcome(failure, 'auto-then-user')).toBe('delegate')
  })

  it('never routes an integrity or conflict failure to delegate in any mode', () => {
    expect(gateFailureOutcome(new GateFailure('integrity', 'seal chain invalid'), 'auto-then-user')).toBe('unavailable')
    expect(gateFailureOutcome(new GateFailure('conflict', 'current-seal conflict'), 'auto-then-user')).toBe('unavailable')
  })

  it('still routes abort to cancelled and keeps the legacy retryable mapping', () => {
    expect(gateFailureOutcome(new GateFailure('abort', 'cancelled'), 'auto-then-user')).toBe('cancelled')
    expect(gateFailureOutcome(new GateFailure('retryable-capability', 'reviewer down'), 'auto-then-user')).toBe('delegate')
    expect(gateFailureOutcome(new GateFailure('retryable-capability', 'reviewer down'), 'auto')).toBe('unavailable')
  })

  it('treats a non-GateFailure error as unavailable and never delegates it', () => {
    expect(gateFailureOutcome(new Error('boom'), 'auto-then-user')).toBe('unavailable')
    expect(gateFailureOutcome(undefined, 'auto-then-user')).toBe('unavailable')
  })
})
