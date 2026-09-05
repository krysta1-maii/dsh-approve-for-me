import { describe, expect, it } from 'vitest'
import { GateFailure, gateFailureOutcome, GATE_FAILURE_CODES } from '../../src/application/gate-failure.js'
import type { GateFailureCode } from '../../src/application/gate-failure.js'

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

  it('routes a ledger-budget-overflow gap to delegate only in auto-then-user mode (T1)', () => {
    const failure = new GateFailure('ledger-budget-overflow', 'sealed activity ledger exceeds maxLedgerEntries')
    expect(gateFailureOutcome(failure, 'auto')).toBe('unavailable')
    expect(gateFailureOutcome(failure, 'auto-then-user')).toBe('delegate')
  })

  // WP5-a §4.4: the tamper, storage and projection classes are hard unavailable
  // in every mode; they must never be routed to the human waterfall as if they
  // were an explainable sealed-current-missing or a capacity overflow.
  const UNAVAILABLE_SIX: readonly GateFailureCode[] = ['sealed-current-conflict', 'seal-chain-invalid', 'seal-live-rebind-failed', 'ledger-storage-unavailable', 'ledger-conflict', 'activity-projection-invalid']
  for (const code of UNAVAILABLE_SIX) {
    it(`routes '${code}' to unavailable in every mode (never delegates)`, () => {
      expect(gateFailureOutcome(new GateFailure(code, 'tamper/failure'), 'auto')).toBe('unavailable')
      expect(gateFailureOutcome(new GateFailure(code, 'tamper/failure'), 'auto-then-user')).toBe('unavailable')
    })
  }

  it('routes disposal-cancellation (lifecycle) to cancelled in every mode (WP7)', () => {
    // A plugin-tree reload disposes the instance mid-approval; the in-flight
    // run is cancelled so the fork continues to the composed answerer instead
    // of reporting "no approval channel available".
    expect(gateFailureOutcome(new GateFailure('lifecycle', 'approval run was cancelled by plugin disposal'), 'auto')).toBe('cancelled')
    expect(gateFailureOutcome(new GateFailure('lifecycle', 'approval run was cancelled by plugin disposal'), 'auto-then-user')).toBe('cancelled')
  })

  it('holds a closed runtime code set containing every typed gate code (WP5-a)', () => {
    const expected: readonly GateFailureCode[] = ['integrity', 'conflict', 'retryable-capability', 'abort', 'deadline', 'lifecycle', 'tail-budget-overflow', 'ledger-budget-overflow', 'sealed-current-missing', 'sealed-current-conflict', 'seal-chain-invalid', 'seal-live-rebind-failed', 'ledger-storage-unavailable', 'ledger-conflict', 'activity-projection-invalid']
    expect(GATE_FAILURE_CODES).toEqual(expected)
    expect(new Set(GATE_FAILURE_CODES).size).toBe(GATE_FAILURE_CODES.length)
  })

  it('fails closed on a runtime-unknown code rather than delegating (WP5-a)', () => {
    const unknown = new GateFailure('bogus' as GateFailureCode, 'unknown code')
    expect(gateFailureOutcome(unknown, 'auto-then-user')).toBe('unavailable')
  })
})
