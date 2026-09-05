import { describe, expect, it, vi } from 'vitest'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import {
  REASON_CODE_TABLE,
  REASON_MISS_COPY_KEY,
  createServerBackedReasonCodeReader,
  missingReasonCodeReader,
  readReasonCode,
  readReasonCodeFrom,
  resolveReasonCodePresentation,
  setApprovalReasonCodeServerReader,
  type ReasonCode,
} from '../../src/client/reason-code.js'
import { DshStorageDomainGateDecisionRecordStore } from '../../src/index.js'
import type { GateDecisionRecord, StorageDomainFacility } from '../../src/index.js'
import {
  approvalConversationDefinition,
  setApprovalReasonCodeSidecarReader,
  type ApprovalFlowData,
} from '../../src/client/approval-conversation.js'
import { ApprovalFlowItem } from '../../src/client/approval-flow-item.js'

type ReactElementish = {
  readonly type: unknown
  readonly props: Record<string, unknown> & { readonly className?: string; readonly children?: unknown }
}

/** Recursively collect element nodes whose className includes the marker. */
function collectByClass(node: unknown, marker: string, out: ReactElementish[] = []): ReactElementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectByClass(child, marker, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const element = node as ReactElementish
  if (typeof element.props?.className === 'string' && element.props.className.split(' ').includes(marker)) {
    out.push(element)
  }
  collectByClass(element.props?.children, marker, out)
  return out
}

function event(type: string, seq: number, data: Record<string, unknown>): SessionEventLike {
  return { type, seq, time: 1_000 + seq, data } as SessionEventLike
}

function matchOf(source: SessionEventLike, role: 'start' | 'update'): ConversationMatch {
  return { event: source, role, location: { kind: 'unresolved' } } as ConversationMatch
}

function contextOf(
  matches: readonly ConversationMatch[],
  state: ApprovalFlowData | undefined,
): ConversationNodeContext<ApprovalFlowData> {
  return {
    key: 'dsh-approve-for-me/approval\0ask-1',
    kind: 'dsh-approve-for-me/approval',
    id: 'ask-1',
    matches,
    start: matches.find(item => item.role === 'start') as never,
    state,
    current: new Map(),
  }
}

function renderItem(data: Partial<ApprovalFlowData>) {
  return ApprovalFlowItem.type({
    node: {
      data: {
        requestId: 'ask-1',
        toolName: 'bash',
        askedSeq: 1,
        askedAt: 1,
        ...data,
      },
    },
    inspectCall: vi.fn(),
    t: (key: string) => key,
  } as never) as ReactElementish
}

describe('reason-code closed vocabulary', () => {
  it('accepts every known reason code and rejects unknown / non-string values', () => {
    for (const code of Object.keys(REASON_CODE_TABLE)) {
      expect(readReasonCode(code)).toBe(code)
    }
    expect(readReasonCode('not-a-real-code')).toBeUndefined()
    expect(readReasonCode('')).toBeUndefined()
    expect(readReasonCode(42)).toBeUndefined()
    expect(readReasonCode(null)).toBeUndefined()
    expect(readReasonCode({ code: 'abort' })).toBeUndefined()
  })

  it('maps each known code to a distinct copy key and tone', () => {
    const mapping = {
      'sealed-current-conflict': 'reason.sealed-current-conflict',
      'seal-chain-invalid': 'reason.seal-chain-invalid',
      'seal-live-rebind-failed': 'reason.seal-live-rebind-failed',
      integrity: 'reason.integrity',
      conflict: 'reason.conflict',
      'sealed-current-missing': 'reason.sealed-current-missing',
      'tail-budget-overflow': 'reason.tail-budget-overflow',
      'ledger-budget-overflow': 'reason.ledger-budget-overflow',
      'budget-overflow': 'reason.budget-overflow',
      'retryable-capability': 'reason.retryable-capability',
      'ledger-storage-unavailable': 'reason.ledger-storage-unavailable',
      'ledger-conflict': 'reason.ledger-conflict',
      'activity-projection-invalid': 'reason.activity-projection-invalid',
      deadline: 'reason.deadline',
      lifecycle: 'reason.lifecycle',
      abort: 'reason.abort',
    } satisfies Record<ReasonCode, string>
    for (const [code, copyKey] of Object.entries(mapping)) {
      const resolved = resolveReasonCodePresentation('unavailable', code)
      expect(resolved.copyKey).toBe(copyKey)
      expect(resolved.miss).toBe(false)
    }
  })

  it('groups tamper signals with the error tone and capacity codes with the warn tone', () => {
    expect(resolveReasonCodePresentation('unavailable', 'seal-chain-invalid').tone).toBe('error')
    expect(resolveReasonCodePresentation('unavailable', 'sealed-current-conflict').class).toBe('tamper')
    expect(resolveReasonCodePresentation('unavailable', 'ledger-budget-overflow').tone).toBe('warn')
    expect(resolveReasonCodePresentation('unavailable', 'sealed-current-missing').class).toBe('capacity')
  })
})

describe('reason-code safe degradation (unknown / missing)', () => {
  it('degrades an unknown code on an unavailable outcome to the generic safe line and a miss', () => {
    const resolved = resolveReasonCodePresentation('unavailable', 'totally-unknown')
    expect(resolved.copyKey).toBe(REASON_MISS_COPY_KEY)
    expect(resolved.miss).toBe(true)
  })

  it('degrades an absent code on an unavailable outcome to the generic safe line and a miss', () => {
    const resolved = resolveReasonCodePresentation('unavailable', undefined)
    expect(resolved.copyKey).toBe(REASON_MISS_COPY_KEY)
    expect(resolved.miss).toBe(true)
  })

  it('shows no reason line for a decided outcome that is not unavailable', () => {
    const resolved = resolveReasonCodePresentation('allowed-once', undefined)
    expect(resolved.copyKey).toBeUndefined()
    expect(resolved.miss).toBe(false)
    expect(resolveReasonCodePresentation('rejected', undefined).copyKey).toBeUndefined()
  })
})

describe('renderer absence / read failure never affects the Gate result', () => {
  it('keeps the authoritative outcome unchanged while the reason line degrades to a miss', () => {
    const outcome: ApprovalOutcome = 'unavailable'
    // The presentation is a pure projection of (outcome, code): a miss cannot
    // rewrite the outcome that the Gate produced.
    const degraded = resolveReasonCodePresentation(outcome, undefined)
    expect(outcome).toBe('unavailable')
    expect(degraded.miss).toBe(true)
    expect(degraded.copyKey).toBe(REASON_MISS_COPY_KEY)
  })

  it('treats a throwing sidecar read as a miss without leaking an error', () => {
    const throwing = { read: () => { throw new Error('storage down') } }
    expect(readReasonCodeFrom('ask-1', throwing)).toBeUndefined()
  })

  it('treats a missing reader as a miss (safe generic line)', () => {
    expect(readReasonCodeFrom('ask-1', undefined)).toBeUndefined()
    expect(missingReasonCodeReader.read('ask-1')).toBeUndefined()
  })
})

describe('reason-code sidecar read-only API', () => {
  it('enriches a decided row from a reader that resolves a known code', () => {
    const reader = { read: (requestId: string) => requestId === 'ask-1' ? 'sealed-current-missing' as const : undefined }
    expect(readReasonCodeFrom('ask-1', reader)).toBe('sealed-current-missing')
  })

  it('degrades a reader that returns an unrecognized value', () => {
    const reader = { read: () => 'bogus' as unknown as ReasonCode }
    expect(readReasonCodeFrom('ask-1', reader)).toBeUndefined()
  })

  it('enriches a decided row via the sidecar reader and never rewrites its outcome', () => {
    setApprovalReasonCodeSidecarReader({ read: () => 'sealed-current-missing' })
    try {
      const asked = matchOf(event('approval/asked', 20, { id: 'ask-1', toolName: 'bash' }), 'start')
      const decided = matchOf(event('approval/decided', 21, { id: 'ask-1', outcome: 'unavailable' }), 'update')
      const node = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], undefined))
      expect(node?.data).toMatchObject({ outcome: 'unavailable', reasonCode: 'sealed-current-missing', decidedSeq: 21 })
    } finally {
      setApprovalReasonCodeSidecarReader(undefined)
    }
  })

  it('defaults to the safe missing reader and keeps an unexplained unavailable outcome intact', () => {
    setApprovalReasonCodeSidecarReader(undefined)
    const asked = matchOf(event('approval/asked', 30, { id: 'ask-1', toolName: 'bash' }), 'start')
    const decided = matchOf(event('approval/decided', 31, { id: 'ask-1', outcome: 'unavailable' }), 'update')
    const node = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], undefined))
    expect(node?.data).toMatchObject({ outcome: 'unavailable' })
    expect((node?.data as ApprovalFlowData).reasonCode).toBeUndefined()
  })
})

function memoryFacility(): StorageDomainFacility {
  const rows = new Map<string, unknown>()
  return {
    open: async () => ({
      table: () => ({ get: (key: string) => rows.get(key), put: async (key: string, value: unknown) => { rows.set(key, value) } }),
      close: async () => {},
    }),
  }
}

function failureRecordOverStore(requestId: string, code: ReasonCode): GateDecisionRecord {
  return {
    version: 2, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'unavailable',
    requestId, parentSessionId: 'session-1', parentLifecycleFingerprint: 'lifecycle-1', callId: 'call-1',
    actionHash: `sha256:${'a'.repeat(64)}`, generation: 'gen-1', policyVersion: 'policy-1',
    configurationFingerprint: `sha256:${'b'.repeat(64)}`, disposition: 'no-decision', reviewAttempts: 0,
    contaminatedRotationAttempts: 0, contaminatedRotations: 0, failureStage: 'verified-dossier',
    failureCode: code as never,
  }
}

describe('WP5-c server read channel -> renderer (real decided unavailable row)', () => {
  it('flows a real stored failure code to the decided renderer, not a generic miss', async () => {
    const store = new DshStorageDomainGateDecisionRecordStore(memoryFacility())
    await expect(store.createConfirmed(failureRecordOverStore('ask-fail', 'sealed-current-missing'))).resolves.toBe('confirmed')
    const code = await store.readReasonCode('ask-fail')
    expect(code).toBe('sealed-current-missing')

    // Wire the read-only server channel into the browser sidecar reader exactly
    // as client.ts apply() does.
    setApprovalReasonCodeSidecarReader(createServerBackedReasonCodeReader())
    setApprovalReasonCodeServerReader({ resolve: requestId => requestId === 'ask-fail' ? code : undefined })
    try {
      const asked = matchOf(event('approval/asked', 40, { id: 'ask-fail', toolName: 'bash' }), 'start')
      const decided = matchOf(event('approval/decided', 41, { id: 'ask-fail', outcome: 'unavailable' }), 'update')
      const node = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], undefined))
      expect(node?.data).toMatchObject({ outcome: 'unavailable', reasonCode: 'sealed-current-missing', decidedSeq: 41 })

      const item = ApprovalFlowItem.type({ node, inspectCall: vi.fn(), t: (key: string) => key } as never)
      const reason = collectByClass(item, 'dsh-afm-flow__reason')
      expect(reason).toHaveLength(1)
      expect(reason[0]!.props['title']).toBe('reason.sealed-current-missing')
      expect(reason[0]!.props['data-reason-miss']).toBeUndefined()
    } finally {
      setApprovalReasonCodeServerReader(undefined)
      setApprovalReasonCodeSidecarReader(undefined)
    }
  })

  it('degrades to a miss when the server bridge throws (a failing read never surfaces)', () => {
    const reader = createServerBackedReasonCodeReader()
    setApprovalReasonCodeServerReader({ resolve: () => { throw new Error('storage down') } })
    try {
      expect(readReasonCodeFrom('ask-1', reader)).toBeUndefined()
    } finally {
      setApprovalReasonCodeServerReader(undefined)
    }
  })

  it('degrades to the generic miss when the server channel returns no code (unchanged safe path)', async () => {
    const store = new DshStorageDomainGateDecisionRecordStore(memoryFacility())
    const code = await store.readReasonCode('no-such-ask')
    expect(code).toBeUndefined()

    setApprovalReasonCodeSidecarReader(createServerBackedReasonCodeReader())
    setApprovalReasonCodeServerReader({ resolve: requestId => requestId === 'ask-fail' ? 'sealed-current-missing' as const : undefined })
    try {
      const asked = matchOf(event('approval/asked', 50, { id: 'ask-other', toolName: 'bash' }), 'start')
      const decided = matchOf(event('approval/decided', 51, { id: 'ask-other', outcome: 'unavailable' }), 'update')
      const node = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], undefined))
      expect((node?.data as ApprovalFlowData).reasonCode).toBeUndefined()

      const item = ApprovalFlowItem.type({ node, inspectCall: vi.fn(), t: (key: string) => key } as never)
      const reason = collectByClass(item, 'dsh-afm-flow__reason')
      expect(reason[0]!.props['data-reason-miss']).toBe('true')
      expect(reason[0]!.props['title']).toBe(REASON_MISS_COPY_KEY)
    } finally {
      setApprovalReasonCodeServerReader(undefined)
      setApprovalReasonCodeSidecarReader(undefined)
    }
  })
})

describe('reason-code decided renderer integration', () => {
  it('shows the mapped reason line for a known code on an unavailable outcome', () => {
    const item = renderItem({ outcome: 'unavailable', decidedSeq: 2, decidedAt: 1_002, reasonCode: 'seal-chain-invalid' })
    const reason = collectByClass(item, 'dsh-afm-flow__reason')
    expect(reason).toHaveLength(1)
    expect(reason[0]!.props['data-reason-class']).toBe('tamper')
    expect(reason[0]!.props['data-reason-miss']).toBeUndefined()
    expect(reason[0]!.props['title']).toBe('reason.seal-chain-invalid')
  })

  it('renders the generic safe line, marks a miss, and leaves the Gate outcome untouched', () => {
    const item = renderItem({ outcome: 'unavailable', decidedSeq: 2, decidedAt: 1_002, reasonCode: 'unknown-code' as ReasonCode })
    // The authoritative status the Gate produced is preserved verbatim.
    expect(item.props['data-status']).toBe('unavailable')
    const reason = collectByClass(item, 'dsh-afm-flow__reason')
    expect(reason).toHaveLength(1)
    expect(reason[0]!.props['data-reason-miss']).toBe('true')
    expect(reason[0]!.props['title']).toBe(REASON_MISS_COPY_KEY)
  })

  it('omits the reason line for a pending row and a decided non-unavailable outcome', () => {
    const pending = renderItem({})
    expect(collectByClass(pending, 'dsh-afm-flow__reason')).toHaveLength(0)
    const allowed = renderItem({ outcome: 'allowed-once', decidedSeq: 2, decidedAt: 1_002 })
    expect(collectByClass(allowed, 'dsh-afm-flow__reason')).toHaveLength(0)
  })

  it('rebuilds a settled row with a reason code on refresh (replayed evidence)', () => {
    const asked = matchOf(event('approval/asked', 10, { id: 'ask-1', toolName: 'bash' }), 'start')
    const decided = matchOf(event('approval/decided', 11, {
      id: 'ask-1',
      outcome: 'unavailable',
      reasonCode: 'ledger-storage-unavailable',
    }), 'update')
    const node = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], undefined))
    expect(node).toMatchObject({
      anchorSeq: 10,
      data: { requestId: 'ask-1', outcome: 'unavailable', reasonCode: 'ledger-storage-unavailable', decidedSeq: 11 },
    })
  })
})
