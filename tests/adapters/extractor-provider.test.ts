import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ManagedAgentMaterializeInfo, ManagedAgentProvider } from 'dsh-managed-agent'
import {
  AUTHORIZATION_EXTRACTOR_SYSTEM_PROMPT,
  EXTRACTION_PROVIDER,
  EXTRACTOR_SECTION,
  SUBMIT_EXTRACTION_TOOL,
  createExtractorProvider,
  createExtractorProviderData,
  fingerprintExtractorConfiguration,
  snapshotJson,
} from '../../src/index.js'
import type { ExtractorProviderDataV1 } from '../../src/index.js'

const providerData: ExtractorProviderDataV1 = createExtractorProviderData({
  generation: 'generation-1',
  modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat', reasoningEffort: 'high' },
  extractorVersion: 'extractor-v1',
})

function materializeInfo(overrides: {
  source?: 'startup' | 'resume'
  childSessionId?: string
  providerData?: unknown
} = {}): ManagedAgentMaterializeInfo {
  return {
    source: overrides.source ?? 'startup',
    parentSessionId: SessionId('parent-1'),
    childSessionId: SessionId(overrides.childSessionId ?? 'extractor-1'),
    descriptor: {
      version: 1,
      provider: EXTRACTION_PROVIDER,
      label: 'Authorization Extractor',
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
    id: SessionId('extractor-1'),
    session: {
      id: SessionId('extractor-1'),
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

describe('createExtractorProvider', () => {
  it('is a real ManagedAgentProvider and shares one composition path for startup and resume', async () => {
    const provider: ManagedAgentProvider = createExtractorProvider({ submitExtraction: { submit: vi.fn() } })
    expect(provider.name).toBe(EXTRACTION_PROVIDER)
    const startup = await provider.materialize(materializeInfo({ source: 'startup' }))
    const resumed = await provider.materialize(materializeInfo({ source: 'resume', childSessionId: 'extractor-1' }))
    expect(startup.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(resumed.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(typeof startup.setup).toBe('function')
    expect(typeof resumed.setup).toBe('function')
  })

  it('installs the complete locked-down composition in one setup', async () => {
    const submit = { submit: vi.fn((_payload: unknown, _actualId: string) => ({ status: 'unknown' as const, extractionId: 'ext-1' })) }
    const provider = createExtractorProvider({ submitExtraction: submit })
    const { stub, appended, registeredTools, listeners } = agentCtxStub()
    const composition = await provider.materialize(materializeInfo())
    await composition.setup?.(stub as unknown as Context)

    // installModelSelection registers exactly the two scoped listeners.
    expect(listeners.get('system-prompt/assemble')?.length ?? 0).toBe(1)
    expect(listeners.get('agent/request')?.length ?? 0).toBe(1)

    expect(stub.systemPrompt.suppressRuntimeContext).toHaveBeenCalledOnce()
    const section = stub.systemPrompt.section.mock.calls[0]![0] as { name: string; order: number; complete?: boolean; text: string }
    expect(section).toMatchObject({ name: EXTRACTOR_SECTION, order: 0, complete: true })
    expect(section.text).toContain(SUBMIT_EXTRACTION_TOOL)
    expect(section.text).toContain('Authorization Extractor')
    expect(stub.tools.restrict).toHaveBeenCalledWith({ allow: [] })
    expect(registeredTools).toHaveLength(1)
    expect((registeredTools[0] as { name: string }).name).toBe(SUBMIT_EXTRACTION_TOOL)
    expect(listeners.get('tools/result')?.length ?? 0).toBe(1)
    expect(appended).toEqual([
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'sandbox/mode', data: { mode: 'read-only' } },
    ])
  })

  it('materializes with the correct system prompt content', async () => {
    const provider = createExtractorProvider({ submitExtraction: { submit: vi.fn() } })
    const { stub, stubContext } = agentCtxStub()
    const composition = await provider.materialize(materializeInfo())
    await composition.setup?.(stubContext)
    const section = stub.systemPrompt.section.mock.calls[0]![0] as { text: string }
    expect(section.text).toBe(AUTHORIZATION_EXTRACTOR_SYSTEM_PROMPT)
    expect(section.text).toContain('Authorization Extractor')
    expect(section.text).toContain('exact verbatim substring')
    expect(section.text).toContain('submit_authorization_extraction')
  })

  it('rejects role other than extractor', () => {
    const provider = createExtractorProvider({ submitExtraction: { submit: vi.fn() } })
    const wrongRole = createExtractorProviderData({
      generation: 'generation-1',
      modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      extractorVersion: 'extractor-v1',
    })
    // parseExtractorProviderData already validates role === 'extractor', but
    // the provider materialize also double-checks.
    expect(() => provider.materialize(materializeInfo({
      providerData: { ...wrongRole, role: 'primary' },
    }))).toThrow(/role must be/)
  })

  it('rejects forged descriptor data', () => {
    const provider = createExtractorProvider({ submitExtraction: { submit: vi.fn() } })
    expect(() => provider.materialize(materializeInfo({
      providerData: { ...providerData, version: 2 },
    }))).toThrow(/version must be 1/)
    expect(() => provider.materialize(materializeInfo({
      providerData: { not: 'extractor data' },
    }))).toThrow(/extractorProviderData/)
    expect(() => provider.materialize(materializeInfo({
      providerData: { ...providerData, configurationFingerprint: 'sha256:' + '0'.repeat(64) },
    }))).toThrow(/does not match/)
  })

  it('rejects an empty tool allowlist at composition level', async () => {
    const provider = createExtractorProvider({ submitExtraction: { submit: vi.fn() } })
    const composition = await provider.materialize(materializeInfo())
    expect(composition.toolFilter).toEqual({ allow: [] })
  })

  it('computes a stable configuration fingerprint', () => {
    const fp1 = fingerprintExtractorConfiguration({ modelRoute: { providerId: 'a', modelId: 'b' }, extractorVersion: 'v1' })
    const fp2 = fingerprintExtractorConfiguration({ modelRoute: { providerId: 'a', modelId: 'b' }, extractorVersion: 'v1' })
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
