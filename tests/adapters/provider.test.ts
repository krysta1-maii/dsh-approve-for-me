import { describe, expect, it, vi } from 'vitest'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ManagedAgentMaterializeInfo, ManagedAgentProvider } from 'dsh-managed-agent'
import {
  REVIEWER_DECISION_PARAMETERS,
  REVIEWER_POLICY_VERSION,
  REVIEWER_POLICY_VERSION_V2,
  REVIEWER_SECTION,
  SUBMIT_DECISION_TOOL,
  createReviewerProvider,
  createReviewerProviderData,
  snapshotJson,
} from '../../src/index.js'
import type { ReviewerProviderDataV1 } from '../../src/index.js'

const providerData: ReviewerProviderDataV1 = createReviewerProviderData({
  generation: 'generation-1',
  modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat', reasoningEffort: 'high' },
  policyVersion: REVIEWER_POLICY_VERSION,
  toolsetVersion: 1,
})

function materializeInfo(overrides: {
  source?: 'startup' | 'resume'
  childSessionId?: string
  providerData?: unknown
} = {}): ManagedAgentMaterializeInfo {
  return {
    source: overrides.source ?? 'startup',
    parentSessionId: SessionId('parent-1'),
    childSessionId: SessionId(overrides.childSessionId ?? 'reviewer-1'),
    descriptor: {
      version: 1,
      provider: 'dsh-approve-for-me/reviewer',
      label: 'Approval Reviewer',
      ...overrides.providerData === undefined
        ? { providerData: snapshotJson(providerData) }
        : { providerData: overrides.providerData as never },
    },
  }
}

function agentCtxStub() {
  const appended: Array<{ type: string; data: unknown }> = []
  const registeredTools: unknown[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const agent = {
    id: SessionId('reviewer-1'),
    session: {
      id: SessionId('reviewer-1'),
      append(type: string, data: unknown): void {
        appended.push({ type, data })
      },
    },
  }
  const stub = {
    agent,
    on(event: string, listener: (...args: unknown[]) => unknown): () => void {
      const entry = listeners.get(event) ?? []
      entry.push(listener)
      listeners.set(event, entry)
      return () => {}
    },
    systemPrompt: {
      suppressRuntimeContext: vi.fn(() => () => {}),
      section: vi.fn((_section: unknown) => () => {}),
    },
    tools: {
      restrict: vi.fn(() => () => {}),
      register: vi.fn((tool: unknown) => { registeredTools.push(tool); return () => {} }),
    },
  }
  return { stub, appended, registeredTools, listeners, stubContext: stub as unknown as Context }
}

describe('createReviewerProvider', () => {
  it('is a real ManagedAgentProvider and shares one composition path for startup and resume', async () => {
    const provider: ManagedAgentProvider = createReviewerProvider({ submitDecision: { submit: vi.fn() } })
    expect(provider.name).toBe('dsh-approve-for-me/reviewer')
    const startup = await provider.materialize(materializeInfo({ source: 'startup' }))
    const resumed = await provider.materialize(materializeInfo({ source: 'resume', childSessionId: 'reviewer-1' }))
    expect(startup.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(resumed.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(typeof startup.setup).toBe('function')
    expect(typeof resumed.setup).toBe('function')
  })

  it('installs the complete locked-down composition in one setup', async () => {
    const submit = { submit: vi.fn((_payload: unknown, _actualId: string) => ({ status: 'unknown' as const, reviewId: 'review-1' })) }
    const provider = createReviewerProvider({ submitDecision: submit })
    const { stub, appended, registeredTools, listeners } = agentCtxStub()
    const composition = await provider.materialize(materializeInfo())
    await composition.setup?.(stub as unknown as Context)

    // installModelSelection registers exactly the two scoped listeners.
    expect(listeners.get('system-prompt/assemble')?.length ?? 0).toBe(1)
    expect(listeners.get('agent/request')?.length ?? 0).toBe(1)

    expect(stub.systemPrompt.suppressRuntimeContext).toHaveBeenCalledOnce()
    const section = stub.systemPrompt.section.mock.calls[0]![0] as { name: string; order: number; complete?: boolean; text: string }
    expect(section).toMatchObject({ name: REVIEWER_SECTION, order: 0, complete: true })
    expect(section.text).toContain(SUBMIT_DECISION_TOOL)
    expect(stub.tools.restrict).toHaveBeenCalledWith({ allow: [] })
    expect(registeredTools).toHaveLength(1)
    expect((registeredTools[0] as { name: string }).name).toBe(SUBMIT_DECISION_TOOL)
    expect(listeners.get('tools/result')?.length ?? 0).toBe(1)
    expect(appended).toEqual([
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'sandbox/mode', data: { mode: 'read-only' } },
    ])
  })

  it('materializes the explicit R5 policy version with the locked-down composition', async () => {
    const provider = createReviewerProvider({ submitDecision: { submit: vi.fn() } })
    const data = createReviewerProviderData({
      generation: 'generation-1',
      modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      policyVersion: REVIEWER_POLICY_VERSION_V2,
      toolsetVersion: 1,
    })
    const { stub, stubContext } = agentCtxStub()
    const composition = await provider.materialize(materializeInfo({ providerData: data }))
    await composition.setup?.(stubContext)
    const section = stub.systemPrompt.section.mock.calls[0]![0] as { text: string }
    expect(section.text).toContain('source-verified dossier')
    expect(section.text).toContain('Critical risk')
  })

  it('rejects unknown policy versions and forged descriptor data', () => {
    const provider = createReviewerProvider({ submitDecision: { submit: vi.fn() } })
    // Fully valid providerData for an unregistered policy — the fingerprint
    // matches, so the rejection must come from the policy registry.
    const unknownPolicy = createReviewerProviderData({
      generation: 'generation-1',
      modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      policyVersion: 'policy-unknown',
      toolsetVersion: 1,
    })
    expect(() => provider.materialize(materializeInfo({ providerData: unknownPolicy })))
      .toThrow(/unknown reviewer policy version/)
    expect(() => provider.materialize(materializeInfo({
      providerData: { ...providerData, version: 2 },
    }))).toThrow(/version/)
    expect(() => provider.materialize(materializeInfo({
      providerData: { not: 'reviewer data' },
    }))).toThrow(/providerData/)
    expect(() => provider.materialize(materializeInfo({
      providerData: { ...providerData, configurationFingerprint: `sha256:${'0'.repeat(64)}` },
    }))).toThrow(/does not match/)
  })

  it('uses the decision parameters with the enforced DSH JSON Schema subset', () => {
    expect(() => assertObjectJsonSchema(REVIEWER_DECISION_PARAMETERS)).not.toThrow()
  })
})
