import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import {
  resolveReviewerModelRouteFromDshCatalog,
} from '../../src/index.js'
import type { ReviewerModelCatalog } from '../../src/index.js'

function catalog(overrides: Partial<ReviewerModelCatalog> = {}): ReviewerModelCatalog {
  const provider: LlmProviderInfo = { id: 'deepseek', name: 'DeepSeek' }
  const model: LlmModelInfo = {
    provider: 'deepseek',
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
  }
  const resolved: LlmResolvedModelInfo = {
    ...model,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('low'),
    },
  }
  return {
    listProviders: vi.fn(() => [provider]),
    listModels: vi.fn(async () => [model]),
    resolveModelInfo: vi.fn(async () => resolved),
    ...overrides,
  }
}

describe('resolveReviewerModelRouteFromDshCatalog', () => {
  it('binds the exact provider/model/effort through the stock DSH catalog', async () => {
    const source = catalog()
    const route = { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningEffort: 'high' }
    const selected = await resolveReviewerModelRouteFromDshCatalog(source, route)

    expect(source.listProviders).toHaveBeenCalledOnce()
    expect(source.listModels).toHaveBeenCalledWith('deepseek')
    expect(source.resolveModelInfo).toHaveBeenCalledWith('deepseek', 'deepseek-reasoner', undefined)
    expect(selected.route).toEqual(route)
    expect(selected.provider).toEqual({ id: 'deepseek', name: 'DeepSeek' })
    expect(selected.model.id).toBe('deepseek-reasoner')
    expect(Object.isFrozen(selected.route)).toBe(true)
  })

  it('fails closed for a stale provider or a provider/model mismatch', async () => {
    await expect(resolveReviewerModelRouteFromDshCatalog(
      catalog({ listProviders: () => [] }),
      { providerId: 'missing', modelId: 'deepseek-reasoner' },
    )).rejects.toThrow(/provider .*not present exactly once/)

    await expect(resolveReviewerModelRouteFromDshCatalog(
      catalog({ listModels: async () => [{ provider: 'other', id: 'deepseek-reasoner', name: 'Wrong owner' }] }),
      { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
    )).rejects.toThrow(/model .*not present exactly once/)
  })

  it('fails closed for an unsupported reasoning effort or identity drift', async () => {
    await expect(resolveReviewerModelRouteFromDshCatalog(
      catalog(),
      { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningEffort: 'impossible' },
    )).rejects.toThrow(/reasoning effort .*not offered/)

    await expect(resolveReviewerModelRouteFromDshCatalog(
      catalog({
        resolveModelInfo: async () => ({
          provider: 'deepseek',
          id: 'different-model',
          name: 'Different',
        }),
      }),
      { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
    )).rejects.toThrow(/different Guardian provider\/model identities/)
  })

  it('honors an already-aborted catalog operation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('stop'))
    await expect(resolveReviewerModelRouteFromDshCatalog(
      catalog(),
      { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
      abort.signal,
    )).rejects.toThrow('stop')
  })
})
