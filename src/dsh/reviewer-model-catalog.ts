import type {
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import type { ReviewerModelRoute } from '../domain/protocol.js'

/** Minimal stock DSH catalog surface used to bind one Guardian route. */
export interface ReviewerModelCatalog {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

export interface ResolvedReviewerModelRoute {
  readonly route: ReviewerModelRoute
  readonly provider: LlmProviderInfo
  readonly model: LlmResolvedModelInfo
}

/**
 * Bind a configured Guardian route to the stock DSH provider/model catalog.
 *
 * The provider and model ids are copied directly from `ctx.llm.listProviders()`
 * and `ctx.llm.listModels()`. Exact-route metadata is then resolved through the
 * same registered adapter that will serve the Reviewer, so credentials, retry
 * behavior and provider-private configuration remain owned by DSH.
 */
export async function resolveReviewerModelRouteFromDshCatalog(
  catalog: ReviewerModelCatalog,
  route: ReviewerModelRoute,
  signal?: AbortSignal,
): Promise<ResolvedReviewerModelRoute> {
  signal?.throwIfAborted()
  const providers = catalog.listProviders()
  const providerMatches = providers.filter(candidate => candidate.id === route.providerId)
  if (providerMatches.length !== 1) {
    throw new Error(`Guardian provider "${route.providerId}" is not present exactly once in the DSH provider list`)
  }

  const listedModels = await catalog.listModels(route.providerId)
  signal?.throwIfAborted()
  const modelMatches = listedModels.filter(candidate =>
    candidate.provider === route.providerId && candidate.id === route.modelId)
  if (modelMatches.length !== 1) {
    throw new Error(
      `Guardian model "${route.modelId}" is not present exactly once in the DSH model list for provider "${route.providerId}"`,
    )
  }

  const resolved = await catalog.resolveModelInfo(route.providerId, route.modelId, signal)
  signal?.throwIfAborted()
  if (resolved.provider !== route.providerId || resolved.id !== route.modelId) {
    throw new Error('DSH resolved different Guardian provider/model identities than the selected catalog route')
  }
  if (route.reasoningEffort !== undefined) {
    const efforts = resolved.reasoning?.efforts ?? []
    if (!efforts.some(effort => String(effort.id) === route.reasoningEffort)) {
      throw new Error(
        `Guardian reasoning effort "${route.reasoningEffort}" is not offered by DSH for ${route.providerId}/${route.modelId}`,
      )
    }
  }

  return Object.freeze({
    route: Object.freeze({ ...route }),
    provider: Object.freeze({ ...providerMatches[0]! }),
    model: resolved,
  })
}
