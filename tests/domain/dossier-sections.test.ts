import { describe, expect, it } from 'vitest'
import {
  effectiveToolBindingFromSchemaV1,
  effectiveToolBindingsFromRequestHeaderV1,
  validateDelegationToolCatalog,
  validateToolTrajectorySection,
} from '../../src/index.js'
import type { ToolTrajectorySectionV1 } from '../../src/index.js'

function catalog(descriptors = [
  { classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' },
  {
    classification: 'delegation' as const,
    projectorId: 'stock-subagent-v1',
    toolName: 'subagent',
    toolSchemaFingerprint: 'subagent-fp',
    operation: 'start' as const,
    receiptPolicy: { kind: 'none' as const },
  },
]) {
  return {
    version: 1 as const,
    eventProjectionPolicyId: 'dsh-session-facts-v1' as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: `sha256:${'0'.repeat(64)}`,
    descriptors,
  }
}

describe('effective tool bindings', () => {
  const bash = { name: 'bash', description: 'run shell commands', parameters: { type: 'object', properties: { command: { type: 'string' } } } }

  it('commits the complete canonical model-visible schema', () => {
    const first = effectiveToolBindingFromSchemaV1(bash)
    const reordered = effectiveToolBindingFromSchemaV1({ name: 'bash', description: 'run shell commands', parameters: { properties: { command: { type: 'string' } }, type: 'object' } })
    const changed = effectiveToolBindingFromSchemaV1({ ...bash, description: 'different description' })
    expect(first).toEqual(reordered)
    expect(first?.toolName).toBe('bash')
    expect(first?.toolSchemaFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(changed).not.toEqual(first)
  })

  it('creates a closed unique schema set and rejects malformed schemas', () => {
    expect(effectiveToolBindingsFromRequestHeaderV1({ tools: [bash] })).toHaveLength(1)
    expect(effectiveToolBindingsFromRequestHeaderV1({ tools: [bash, bash] })).toBeUndefined()
    expect(effectiveToolBindingsFromRequestHeaderV1({ tools: [{ name: 'bash', description: 'x', parameters: [] }] })).toBeUndefined()
    expect(effectiveToolBindingsFromRequestHeaderV1({ tools: 'bash' })).toBeUndefined()
  })
})

describe('validateDelegationToolCatalog', () => {
  it('accepts a closed-world exact catalog', () => {
    expect(validateDelegationToolCatalog(catalog(), [
      { toolName: 'bash', toolSchemaFingerprint: 'bash-fp' },
      { toolName: 'subagent', toolSchemaFingerprint: 'subagent-fp' },
    ])).toEqual({ kind: 'ok' })
  })

  it('rejects missing, extra, fingerprint drift, and duplicates', () => {
    expect(validateDelegationToolCatalog(catalog(), [
      { toolName: 'bash', toolSchemaFingerprint: 'bash-fp' },
    ])).toMatchObject({ kind: 'invalid', reason: /descriptor for subagent/ })
    expect(validateDelegationToolCatalog(catalog(), [
      { toolName: 'bash', toolSchemaFingerprint: 'bash-fp' },
      { toolName: 'subagent', toolSchemaFingerprint: 'subagent-fp' },
      { toolName: 'read', toolSchemaFingerprint: 'read-fp' },
    ])).toMatchObject({ kind: 'invalid', reason: 'missing descriptor for read' })
    expect(validateDelegationToolCatalog(catalog(), [
      { toolName: 'bash', toolSchemaFingerprint: 'drift' },
      { toolName: 'subagent', toolSchemaFingerprint: 'subagent-fp' },
    ])).toMatchObject({ kind: 'invalid', reason: /schema fingerprint mismatch/ })
    expect(validateDelegationToolCatalog(catalog(), [
      { toolName: 'bash', toolSchemaFingerprint: 'bash-fp' },
      { toolName: 'subagent', toolSchemaFingerprint: 'subagent-fp' },
      { toolName: 'extra', toolSchemaFingerprint: 'extra-fp' },
    ])).toMatchObject({ kind: 'invalid', reason: /missing descriptor for extra/ })
    expect(validateDelegationToolCatalog(catalog([
      ...catalog().descriptors,
      { classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'dup' },
    ]), [
      { toolName: 'bash', toolSchemaFingerprint: 'bash-fp' },
      { toolName: 'subagent', toolSchemaFingerprint: 'subagent-fp' },
    ])).toMatchObject({ kind: 'invalid', reason: /duplicate descriptor/ })
  })
})

function trajectory(overrides: Partial<ToolTrajectorySectionV1> = {}): ToolTrajectorySectionV1 {
  return {
    turn: 1,
    excludedPendingRequest: { callId: 'pending-1', requestEventSeq: 5 },
    attempts: [
      {
        request: { kind: 'model-tool-call', issuedIn: { seq: 1, type: 'assistant/message' }, blockIndex: 0, callId: 'call-1', toolName: 'bash', rawArguments: '{}' },
        outcome: { kind: 'completed' },
      },
      {
        request: { kind: 'code-dispatch', dispatchStart: { seq: 2, type: 'tool/code-dispatch-start' }, rootCallId: 'call-0', parentCallId: 'call-0', callId: 'call-0:code:1', toolName: 'read', arguments: {} },
        outcome: { kind: 'pending' },
      },
    ],
    ...overrides,
  }
}

describe('validateToolTrajectorySection', () => {
  it('accepts a well-formed trajectory with unique calls', () => {
    expect(validateToolTrajectorySection(trajectory())).toEqual({ kind: 'ok' })
  })

  it('rejects duplicate call ids and malformed excluded pending key', () => {
    const duplicate = trajectory({
      attempts: [
        ...trajectory().attempts,
        {
          request: { kind: 'model-tool-call', issuedIn: { seq: 3, type: 'assistant/message' }, blockIndex: 1, callId: 'call-1', toolName: 'bash', rawArguments: '{}' },
          outcome: { kind: 'completed' },
        },
      ],
    })
    expect(validateToolTrajectorySection(duplicate)).toMatchObject({ kind: 'invalid', reason: /duplicate attempt callId/ })
    expect(validateToolTrajectorySection({
      ...trajectory(),
      excludedPendingRequest: { callId: '', requestEventSeq: 0 },
    })).toMatchObject({ kind: 'invalid', reason: /excludedPendingRequest/ })
  })
})
