import { describe, expect, it } from 'vitest'
import { DefaultPrincipalDelegationProjector } from '../../src/index.js'
import type {
  DelegationToolClassificationCatalogV1,
  PrincipalDelegationReceiptV1,
  ToolAttemptV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

function descriptor(overrides: Partial<Extract<NonNullable<DelegationToolClassificationCatalogV1['descriptors'][number]>, { classification: 'delegation' }>> = {}) {
  return {
    classification: 'delegation' as const,
    projectorId: 'stock-subagent-v1',
    toolName: 'subagent',
    toolSchemaFingerprint: 'subagent-fp',
    operation: 'start' as const,
    receiptPolicy: { kind: 'none' as const },
    ...overrides,
  }
}

function attempt(overrides: Partial<ToolAttemptV1> = {}): ToolAttemptV1 {
  return {
    request: {
      kind: 'model-tool-call',
      issuedIn: { seq: 10, type: 'assistant/message', turn: 2 },
      blockIndex: 0,
      callId: 'call-1',
      toolName: 'subagent',
      rawArguments: '{"objective":"x"}',
    },
    outcome: { kind: 'completed' },
    ...overrides,
  }
}

function receipt(kind: PrincipalDelegationReceiptV1['kind'] = 'continuable-child-started'): PrincipalDelegationReceiptV1 {
  switch (kind) {
    case 'continuable-child-started':
      return { kind, childSessionId: 'child-1', directParentSessionId: 'parent-1' }
    default:
      return { kind: 'interrupt-accepted' }
  }
}

describe('DefaultPrincipalDelegationProjector', () => {
  it('projects a delegation entry with a safe receipt when required', () => {
    const catalog: DelegationToolClassificationCatalogV1 = {
      version: 1,
      eventProjectionPolicyId: 'dsh-session-facts-v1',
      argumentSemanticsId: 'default-v1',
      fingerprint: hash('c'),
      descriptors: [descriptor({ receiptPolicy: { kind: 'required-on-completed', receiptKinds: ['continuable-child-started'] } })],
    }
    const projector = new DefaultPrincipalDelegationProjector(catalog)
    const result = projector.project({
      principalSessionId: 'parent-1',
      attempt: attempt(),
      descriptor: descriptor({ receiptPolicy: { kind: 'required-on-completed', receiptKinds: ['continuable-child-started'] } }),
      receipt: {
        session: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 },
        requestEventSeq: 10,
        resultEvent: { seq: 20, type: 'tool/result' },
        callId: 'call-1',
        classificationCatalogFingerprint: hash('c'),
        projectorId: 'stock-subagent-v1',
        receipt: receipt(),
      },
    })
    expect(result.kind).toBe('delegation')
    if (result.kind !== 'delegation') return
    expect(result.entry.operation).toBe('start')
    expect(result.entry.order).toEqual([2, 10, 0])
  })

  it('rejects missing required receipt and mismatch descriptors', () => {
    const catalog: DelegationToolClassificationCatalogV1 = {
      version: 1,
      eventProjectionPolicyId: 'dsh-session-facts-v1',
      argumentSemanticsId: 'default-v1',
      fingerprint: hash('c'),
      descriptors: [descriptor({ receiptPolicy: { kind: 'required-on-completed', receiptKinds: ['continuable-child-started'] } })],
    }
    const projector = new DefaultPrincipalDelegationProjector(catalog)
    expect(projector.project({
      principalSessionId: 'parent-1',
      attempt: attempt(),
      descriptor: descriptor({ receiptPolicy: { kind: 'required-on-completed', receiptKinds: ['continuable-child-started'] } }),
    }).kind).toBe('invalid')

    expect(projector.project({
      principalSessionId: 'parent-1',
      attempt: attempt({ request: { ...attempt().request, toolName: 'other' } }),
      descriptor: descriptor(),
    }).kind).toBe('invalid')
  })

  it('rejects malformed requests and non-completed attempts do not require receipts', () => {
    const projector = new DefaultPrincipalDelegationProjector({
      version: 1,
      eventProjectionPolicyId: 'dsh-session-facts-v1',
      argumentSemanticsId: 'default-v1',
      fingerprint: hash('c'),
      descriptors: [descriptor()],
    })
    expect(projector.project({
      principalSessionId: 'parent-1',
      attempt: attempt({ request: { ...attempt().request, callId: '' } }),
      descriptor: descriptor(),
    }).kind).toBe('invalid')

    const pending = projector.project({
      principalSessionId: 'parent-1',
      attempt: attempt({ outcome: { kind: 'pending' } }),
      descriptor: descriptor(),
    })
    expect(pending.kind).toBe('delegation')
  })
})
