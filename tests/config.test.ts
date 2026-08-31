import { describe, expect, it } from 'vitest'
import { Config, fingerprintApprovalToolCatalogV1, inject, name, normalizeConfig } from '../src/index.js'

const toolCatalog = (descriptors: readonly { readonly toolName: string; readonly toolSchemaFingerprint: string; readonly classification: 'ordinary' | 'gate-ask' | 'body-escalation'; readonly actionSemanticsFamily: string; readonly actionProjectorId: string }[]) => {
  const unsealed = { version: 1 as const, argumentSemanticsId: 'default-v1', fingerprint: '', descriptors }
  return { ...unsealed, fingerprint: fingerprintApprovalToolCatalogV1(unsealed)! }
}

const valid = () => ({
  reviewer: {
    generation: 'reviewer-v1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    policyVersion: 'policy-v1',
    toolsetVersion: 1 as const,
  },
})

describe('plugin config', () => {
  it('exposes the stable plugin identity and required injects', () => {
    expect(name).toBe('dsh-approve-for-me')
    expect([...inject]).toEqual(['agents', 'managedAgents', 'tools', 'systemPrompt', 'approval', 'storageDomain', 'llm'])
  })

  it('normalizes defaults and derives the Reviewer preset', () => {
    const normalized = normalizeConfig(valid())
    expect(normalized.mode).toBe('auto')
    expect(normalized.timeoutMs).toBe(30_000)
    expect(normalized.maxDossierBytes).toBe(256_000)
    expect(normalized.preset).toMatchObject({
      version: 1,
      role: 'primary',
      generation: 'reviewer-v1',
      modelRoute: {
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        reasoningEffort: 'high',
      },
      policyVersion: 'policy-v1',
      toolsetVersion: 1,
    })
    expect(normalized.preset.configurationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('accepts explicit mode and timeout', () => {
    const normalized = normalizeConfig({ ...valid(), mode: 'auto-then-user', timeoutMs: 5_000 })
    expect(normalized.mode).toBe('auto-then-user')
    expect(normalized.timeoutMs).toBe(5_000)
  })

  it('normalizes maxDeliveryAttemptsPerChild and trust-envelope defaults', () => {
    const normalized = normalizeConfig(valid())
    expect(normalized.maxDeliveryAttemptsPerChild).toBe(64)
    expect(normalized.trustEnvelope).toEqual({
      version: 1,
      enabled: false,
      tools: [],
      maxRequestedMode: 'read-only',
      workspaceOnly: true,
      requireJustification: false,
      requireStrictWidening: false,
    })
    expect(Object.isFrozen(normalized.trustEnvelope.tools)).toBe(true)
  })

  it('normalizes tool catalog defaults and accepts a closed catalog', () => {
    expect(normalizeConfig(valid()).toolCatalog).toEqual({
      version: 1,
      argumentSemanticsId: 'default-v1',
      fingerprint: fingerprintApprovalToolCatalogV1({ version: 1, argumentSemanticsId: 'default-v1', fingerprint: '', descriptors: [] }),
      descriptors: [],
    })
    const normalized = normalizeConfig({
      ...valid(),
      toolCatalog: toolCatalog([
        { toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'body-escalation', actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'shell-v1' },
      ]),
    })
    expect(normalized.toolCatalog.descriptors).toHaveLength(1)
    expect(Object.isFrozen(normalized.toolCatalog.descriptors)).toBe(true)
    expect(Object.isFrozen(normalized.toolCatalog.descriptors[0])).toBe(true)
  })

  it('deep-clones configured descriptors across the install boundary', () => {
    const descriptor = { toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'body-escalation' as const, actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'shell-v1' }
    const normalized = normalizeConfig({ ...valid(), toolCatalog: toolCatalog([descriptor]) })
    ;(descriptor as { classification: string }).classification = 'ordinary'
    expect(normalized.toolCatalog.descriptors[0]?.classification).toBe('body-escalation')
  })

  it('commits each descriptor semantic family and projector identity', () => {
    const catalog = toolCatalog([{ toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'ordinary', actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'shell-v1' }])
    expect(fingerprintApprovalToolCatalogV1({ ...catalog, descriptors: [{ ...catalog.descriptors[0]!, actionProjectorId: 'shell-v2' }] })).not.toBe(catalog.fingerprint)
    expect(fingerprintApprovalToolCatalogV1({ ...catalog, descriptors: [{ ...catalog.descriptors[0]!, actionSemanticsFamily: 'other-v1' }] })).not.toBe(catalog.fingerprint)
  })

  it('rejects a tool catalog whose supplied fingerprint is not its canonical commitment', () => {
    expect(() => normalizeConfig({
      ...valid(),
      toolCatalog: { ...toolCatalog([{ toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'ordinary', actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'shell-v1' }]), fingerprint: `sha256:${'a'.repeat(64)}` },
    })).toThrow(/toolCatalog\.fingerprint/)
  })

  it('rejects duplicate tool catalog descriptors', () => {
    expect(() => normalizeConfig({
      ...valid(),
      toolCatalog: {
        version: 1,
        argumentSemanticsId: 'default-v1',
        fingerprint: `sha256:${'a'.repeat(64)}`,
        descriptors: [
          { toolName: 'bash', toolSchemaFingerprint: 'a', classification: 'ordinary', actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'shell-v1' },
          { toolName: 'bash', toolSchemaFingerprint: 'b', classification: 'body-escalation', actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'shell-v1' },
        ],
      },
    })).toThrow(/duplicate toolCatalog descriptor/)
  })

  it('normalizes case-capture defaults and accepts explicit full config', () => {
    const normalized = normalizeConfig(valid())
    expect(normalized.caseCapture).toEqual({
      mode: 'off',
      maxCases: 100,
      maxArtifactBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
      retentionDays: 30,
    })
    const full = normalizeConfig({
      ...valid(),
      caseCapture: {
        mode: 'full',
        maxCases: 10,
        maxArtifactBytes: 2_000,
        maxTotalBytes: 20_000,
        retentionDays: 7,
      },
    })
    expect(full.caseCapture.mode).toBe('full')
    expect(Object.isFrozen(full.caseCapture)).toBe(true)
  })

  it('rejects invalid case-capture configuration', () => {
    expect(() => normalizeConfig({
      ...valid(),
      caseCapture: { mode: 'full', maxCases: 0, maxArtifactBytes: 1, maxTotalBytes: 2, retentionDays: 1 },
    })).toThrow(/positive safe integer/)
  })

  it('accepts explicit maxDeliveryAttemptsPerChild and a partial trust envelope', () => {
    const normalized = normalizeConfig({
      ...valid(),
      maxDeliveryAttemptsPerChild: 16,
      trustEnvelope: {
        enabled: true,
        tools: ['bash'],
        maxRequestedMode: 'workspace-write',
        requireJustification: true,
      },
    })
    expect(normalized.maxDeliveryAttemptsPerChild).toBe(16)
    expect(normalized.trustEnvelope).toMatchObject({
      enabled: true,
      tools: ['bash'],
      maxRequestedMode: 'workspace-write',
      workspaceOnly: true,
      requireJustification: true,
      requireStrictWidening: false,
    })
  })

  it('rejects invalid loader configuration before provider registration', () => {
    expect(() => normalizeConfig({ ...valid(), timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => normalizeConfig({ ...valid(), mode: 'never' as never })).toThrow(/mode/)
    expect(() => normalizeConfig({ ...valid(), maxDeliveryAttemptsPerChild: 0 })).toThrow(/maxDeliveryAttemptsPerChild/)
    expect(() => normalizeConfig({ ...valid(), maxDossierBytes: 0 })).toThrow(/maxDossierBytes/)
    expect(() => normalizeConfig({ ...valid(), trustEnvelope: { tools: ['unknown'] as never } }))
      .toThrow(/unknown tool family/)
    expect(() => normalizeConfig({ ...valid(), reviewer: { ...valid().reviewer, toolsetVersion: 2 as never } }))
      .toThrow(/toolsetVersion/)
  })

  it('validates through the Schemastery schema', () => {
    const validated = Config(valid())
    const reviewer = (validated as unknown as { reviewer: { generation: string; toolsetVersion: number } }).reviewer
    expect(reviewer.generation).toBe('reviewer-v1')
    expect(reviewer.toolsetVersion).toBe(1)
    expect(() => Config({ reviewer: { provider: 'deepseek' } } as never)).toThrow()
  })
})
