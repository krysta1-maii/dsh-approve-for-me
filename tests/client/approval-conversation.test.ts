import { describe, expect, it, vi } from 'vitest'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply } from '../../src/client.js'
import {
  approvalConversationDefinition,
  matchApprovalEvent,
  type ApprovalFlowData,
} from '../../src/client/approval-conversation.js'
import { ApprovalFlowItem, APPROVAL_FLOW_STYLES } from '../../src/client/approval-flow-item.js'
import {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
  APPROVAL_SETTINGS_STYLES,
  approvalModelCandidates,
  decodeApprovalModelSettings,
  hasReviewerRouteOverride,
} from '../../src/client/approval-settings-card.js'

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

describe('approval Chat projection', () => {
  it('matches only valid official approval audit events', () => {
    expect(matchApprovalEvent(event('approval/asked', 1, {
      id: 'ask-1', toolName: 'bash', callId: 'call-1', reason: 'needs workspace-write',
    }))).toEqual({ id: 'ask-1', role: 'start' })
    expect(matchApprovalEvent(event('approval/decided', 2, {
      id: 'ask-1', outcome: 'allowed-once',
    }))).toEqual({ id: 'ask-1', role: 'update' })

    expect(matchApprovalEvent(event('approval/asked', 3, { id: 'ask-2', toolName: '' }))).toBeNull()
    expect(matchApprovalEvent(event('approval/decided', 4, { id: 'ask-2', outcome: 'maybe' }))).toBeNull()
    expect(matchApprovalEvent(event('assistant/message', 5, { id: 'ask-1' }))).toBeNull()
  })

  it('shows pending at ask and updates the same node in place after the final decision', () => {
    const asked = matchOf(event('approval/asked', 7, {
      id: 'ask-1', toolName: 'write', callId: 'call-1', reason: 'Write the requested file',
    }), 'start')
    const initialContext = contextOf([asked], undefined)
    const initial = approvalConversationDefinition.start(
      initialContext,
      asked as never,
      { previous: () => undefined },
    )
    const pendingNode = approvalConversationDefinition.buildViewNode!(contextOf([asked], initial))

    expect(pendingNode).toMatchObject({
      key: initialContext.key,
      kind: 'approve-for-me',
      target: 'chat',
      anchorSeq: 7,
      location: { kind: 'session' },
      visibility: 'visible',
      data: {
        requestId: 'ask-1',
        toolName: 'write',
        callId: 'call-1',
        reason: 'Write the requested file',
        askedSeq: 7,
        askedAt: 1_007,
      },
    })
    expect((pendingNode!.data as ApprovalFlowData).outcome).toBeUndefined()

    const decided = matchOf(event('approval/decided', 9, {
      id: 'ask-1', outcome: 'allowed-once',
    }), 'update')
    const settled = approvalConversationDefinition.update(
      contextOf([asked, decided], initial) as ConversationNodeContext<ApprovalFlowData> & { state: ApprovalFlowData },
      decided,
    )
    const settledNode = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], settled))

    expect(settledNode?.key).toBe(pendingNode?.key)
    expect((settledNode as { anchorSeq?: number } | null)?.anchorSeq).toBe(7)
    expect(settledNode?.data).toMatchObject({
      requestId: 'ask-1',
      outcome: 'allowed-once',
      decidedSeq: 9,
      decidedAt: 1_009,
    })
  })

  it('reconstructs a settled row from replayed asked and decided evidence', () => {
    const asked = matchOf(event('approval/asked', 10, { id: 'ask-1', toolName: 'bash' }), 'start')
    const decided = matchOf(event('approval/decided', 11, { id: 'ask-1', outcome: 'rejected' }), 'update')
    const node = approvalConversationDefinition.buildViewNode!(contextOf([asked, decided], undefined))

    expect(node).toMatchObject({
      anchorSeq: 10,
      data: { requestId: 'ask-1', toolName: 'bash', outcome: 'rejected', decidedSeq: 11 },
    })
  })

  it('exposes the current tool and decision through the live-region name', () => {
    const rendered = ApprovalFlowItem.type({
      node: { data: { requestId: 'ask-1', toolName: 'bash', askedSeq: 1, askedAt: 1, outcome: 'allowed-once' } },
      inspectCall: vi.fn(),
      t: (key: string) => key,
    } as never) as { props: Record<string, unknown> }

    expect(rendered.props['role']).toBe('status')
    expect(rendered.props['aria-live']).toBe('polite')
    expect(rendered.props['aria-label']).toBe('approval.aria: bash, status.allowed-once')
  })

  it('uses DSH design tokens, explicit outcome tones, and reduced-motion handling', () => {
    expect(APPROVAL_FLOW_STYLES).toContain('var(--dsw-alias-state-business-primary)')
    expect(APPROVAL_FLOW_STYLES).toContain('var(--dsw-alias-state-success-primary)')
    expect(APPROVAL_FLOW_STYLES).toContain('var(--dsw-alias-state-error-primary)')
    expect(APPROVAL_FLOW_STYLES).toContain('var(--dsw-alias-state-warn-label)')
    expect(APPROVAL_FLOW_STYLES).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

describe('AFM plugin settings card model', () => {
  it('narrows the settings section and detects nested user overrides', () => {
    expect(decodeApprovalModelSettings({
      reviewer: { provider: 'openai-codex', model: 'gpt-5.6-terra', ignored: true },
      privatePolicy: 'not exposed',
    })).toEqual({ reviewer: { provider: 'openai-codex', model: 'gpt-5.6-terra' } })
    expect(decodeApprovalModelSettings({ reviewer: { provider: '', model: 'x' } })).toBeUndefined()
    expect(hasReviewerRouteOverride({ reviewer: { model: 'gpt-5.6-terra' } })).toBe(true)
    expect(hasReviewerRouteOverride({ reviewer: {} })).toBe(false)
  })

  it('uses exact catalog ids and retains a selected route that is unavailable', () => {
    const groups = [{
      id: 'openai-codex',
      name: 'Codex',
      models: [{ id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra', description: 'Reviewer route' }],
    }]
    expect(approvalModelCandidates(groups, { provider: 'openai-codex', model: 'gpt-5.6-terra' }))
      .toEqual([expect.objectContaining({
        provider: 'openai-codex',
        model: 'gpt-5.6-terra',
        providerName: 'Codex',
        modelName: 'GPT 5.6 Terra',
        availability: 'available',
      })])
    expect(approvalModelCandidates(groups, { provider: 'cpa', model: 'gpt-5.6-sol' }, new Set()).at(-1))
      .toMatchObject({ provider: 'cpa', model: 'gpt-5.6-sol', availability: 'unavailable' })
    expect(approvalModelCandidates(groups, { provider: 'cpa', model: 'gpt-5.6-sol' }, new Set(['cpa'])).at(-1))
      .toMatchObject({ provider: 'cpa', model: 'gpt-5.6-sol', availability: 'unknown' })
  })

  it('styles the card with DSH tokens and reduced-motion handling', () => {
    expect(APPROVAL_SETTINGS_STYLES).toContain('var(--dsw-alias-bg-layer-3)')
    expect(APPROVAL_SETTINGS_STYLES).toContain('var(--dsw-alias-brand-primary)')
    expect(APPROVAL_SETTINGS_STYLES).toContain('@media (prefers-reduced-motion:reduce)')
  })
})

describe('AFM client plugin', () => {
  it('registers the lifecycle definition, localized keyed renderer, and scoped styles', () => {
    const registerDefinition = vi.fn(() => () => {})
    const registerLocale = vi.fn(() => () => {})
    const registerSlot = vi.fn(() => () => {})
    const effects: string[] = []
    const bindSettings = vi.fn(() => ({
      getSnapshot: () => ({ status: 'ready', value: { reviewer: { provider: 'openai-codex', model: 'gpt-5.6-terra' } }, base: {}, user: {}, revision: 1, writable: true, mode: 'host' }),
      subscribe: () => () => {},
      mutate: vi.fn(async () => {}),
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    }))
    const ctx = {
      uiConversation: { events: { register: registerDefinition } },
      locale: { register: registerLocale, bind: () => (key: string) => key },
      slots: {
        inject(_name: string, setup: () => unknown) { setup() },
        register: registerSlot,
      },
      settingsScope: { bind: bindSettings },
      remote: {
        session: { modelCatalog: vi.fn(async () => ({ ok: false })) },
        $on: vi.fn(() => () => {}),
      },
      on: vi.fn(() => () => {}),
      effect(setup: () => unknown, label?: string) {
        effects.push(label ?? '')
        return setup()
      },
    }

    apply(ctx as never)

    expect(registerDefinition).toHaveBeenCalledWith(approvalConversationDefinition)
    expect(registerLocale).toHaveBeenCalledWith('approve-for-me', expect.objectContaining({ zh: expect.any(Object), en: expect.any(Object) }))
    expect(registerSlot).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.node',
      key: 'approve-for-me',
      locale: 'approve-for-me',
    }), expect.anything())
    expect(bindSettings).toHaveBeenCalledWith({
      namespace: APPROVE_FOR_ME_SETTINGS_NAMESPACE,
      decode: decodeApprovalModelSettings,
    })
    expect(registerSlot).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.plugin.item',
      key: APPROVE_FOR_ME_SETTINGS_NAMESPACE,
      locale: 'approve-for-me',
    }), expect.anything())
    expect(effects).toEqual(expect.arrayContaining([
      'approve-for-me: dictionaries',
      'approve-for-me: client styles',
      'approve-for-me: model adapter invalidations',
      'approve-for-me: model settings invalidations',
      'approve-for-me: connection generation',
    ]))
  })
})
