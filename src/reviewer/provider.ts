import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// Referenced type import: loads the dsh-system-prompt declarations (and its
// ctx.systemPrompt augmentation) into the consumer program.
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {
  ManagedAgentComposition,
  ManagedAgentMaterializeInfo,
  ManagedAgentProvider,
} from 'dsh-managed-agent'
import { REVIEWER_PROVIDER, parseReviewerProviderData } from '../domain/protocol.js'
import type { ReviewerModelRoute } from '../domain/protocol.js'
import { createPolicyRegistry } from './policy.js'
import type { ReviewerPolicy } from './policy.js'
import { createDecisionTool } from './decision-tool.js'
import type { DecisionSubmitter } from './decision-tool.js'

export const REVIEWER_SECTION = 'dsh-approve-for-me/reviewer'

export interface ReviewerProviderOptions {
  readonly label?: string
  readonly submitDecision: DecisionSubmitter
}

/**
 * Real `ManagedAgentProvider` consumed by `ctx.managedAgents.registerProvider()`
 * on the stock Guarded Continuable `dsh-managed-agent` Host. One materializer
 * serves BOTH startup and cold resume: same providerData parsing, same policy
 * resolution, same composition.
 */
export function createReviewerProvider(options: ReviewerProviderOptions): ManagedAgentProvider {
  const policies = createPolicyRegistry()
  return Object.freeze({
    name: REVIEWER_PROVIDER,
    materialize(info: ManagedAgentMaterializeInfo): ManagedAgentComposition {
      const data = parseReviewerProviderData(info.descriptor.providerData)
      if (data.role !== 'primary') throw new TypeError('Reviewer provider data has an unsupported role')
      const policy = policies.resolve(data.policyVersion)
      return {
        agentOptions: {
          provider: data.modelRoute.providerId,
          model: data.modelRoute.modelId,
        },
        toolFilter: { allow: [] },
        setup: createReviewerSetup(info.childSessionId, data.modelRoute, policy, options.submitDecision),
      }
    },
  })
}

/**
 * Composition factory used identically by startup and resume. Registers the
 * fixed model route (provider/model/reasoningEffort) through the DSH model
 * selection seam so the configuration fingerprint and the real composition
 * stay in lockstep.
 */
function createReviewerSetup(
  childSessionId: string,
  route: ReviewerModelRoute,
  policy: ReviewerPolicy,
  submitDecision: DecisionSubmitter,
): AgentSetup {
  const selection: ModelSelection = {
    provider: route.providerId,
    model: route.modelId,
    ...route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  }
  return (agentCtx: Context) => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('Reviewer setup requires an agent scope')
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    agentCtx.systemPrompt.suppressRuntimeContext()
    const section: PromptSection = {
      name: REVIEWER_SECTION,
      order: 0,
      text: policy.systemPrompt,
      complete: true,
    }
    agentCtx.systemPrompt.section(section)
    agentCtx.tools.restrict({ allow: [] })
    const scoped = createDecisionTool(childSessionId, submitDecision, policy.decisionParameters)
    agentCtx.tools.register(scoped.definition)
    agentCtx.on('tools/result', (exec, result) => scoped.observeResult(exec, result))
    setApprovalPolicy(agent.session, 'never')
    setSandboxMode(agent.session, 'read-only')
  }
}
