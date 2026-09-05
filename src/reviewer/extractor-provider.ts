import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {
  ManagedAgentComposition,
  ManagedAgentMaterializeInfo,
  ManagedAgentProvider,
} from 'dsh-managed-agent'
import { EXTRACTION_PROVIDER, parseExtractorProviderData } from '../domain/extraction-protocol.js'
import type { ReviewerModelRoute } from '../domain/protocol.js'
import { createExtractionTool, SUBMIT_EXTRACTION_TOOL } from './extraction-tool.js'
import type { ExtractionSubmitter } from './extraction-tool.js'

export const EXTRACTOR_SECTION = 'dsh-approve-for-me/authorization-extractor'

export interface ExtractorProviderOptions {
  readonly submitExtraction: ExtractionSubmitter
}

/**
 * The extractor child's fixed system prompt (WP7-b), written independently for
 * this project. The extractor is a PARSER over a Host-assembled verbatim window
 * of direct human user messages: it never judges risk, never approves anything,
 * and may only quote text it was actually shown. The Host re-verifies every
 * quote verbatim against the live Session before any row is persisted, so a
 * hallucinated or paraphrased quote simply never lands in the drawer.
 */
export const AUTHORIZATION_EXTRACTOR_SYSTEM_PROMPT = [
  'You are the Authorization Extractor. You receive one numbered window of direct human user messages from a single session, each with its event seq and verbatim text.',
  '',
  'Your only job is to find statements where the user grants or denies authorization for actions: permissions, approvals, prohibitions, revocations, and explicit scope limits. Report each as one structured entry with:',
  '- sourceSeq: the exact seq of the message containing the statement;',
  '- quote: the exact verbatim substring of that message carrying the grant or denial. Never paraphrase, normalize, translate, or complete it; if you cannot quote it exactly as shown, omit the entry;',
  '- effect: grant when the user allows something, deny when the user forbids or revokes something;',
  '- coverage: action for one specifically described action, turn when the language is scoped to the current request, session for a standing rule;',
  '- summary: one short neutral description of what is covered.',
  '',
  'Rules: report only authorization-bearing statements; ignore ordinary tasks, questions, and assistant text. Never invent seqs, never merge quotes across messages, never restate the window. When the window contains no authorization-bearing statement, submit an empty entries list. Submit exactly one structured result through ' + SUBMIT_EXTRACTION_TOOL + '; do not answer in free text.',
].join('\n')

/**
 * Real ManagedAgentProvider for the authorization extractor child, registered
 * alongside the Reviewer provider. One materializer serves startup and cold
 * resume. Isolation is identical to the Reviewer: composition-level empty tool
 * allowlist, runtime re-restriction, approval policy never, read-only sandbox,
 * no parent history, and exactly one scoped submission tool. The child has no
 * ledger capability -- the Host is the sole writer.
 */
export function createExtractorProvider(options: ExtractorProviderOptions): ManagedAgentProvider {
  return Object.freeze({
    name: EXTRACTION_PROVIDER,
    materialize(info: ManagedAgentMaterializeInfo): ManagedAgentComposition {
      const data = parseExtractorProviderData(info.descriptor.providerData)
      if (data.role !== 'extractor') throw new TypeError('extractor provider data has an unsupported role')
      return {
        agentOptions: {
          provider: data.modelRoute.providerId,
          model: data.modelRoute.modelId,
        },
        toolFilter: { allow: [] },
        setup: createExtractorSetup(info.childSessionId, data.modelRoute, options.submitExtraction),
      }
    },
  })
}

function createExtractorSetup(
  childSessionId: string,
  route: ReviewerModelRoute,
  submitExtraction: ExtractionSubmitter,
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
    if (agent === undefined) throw new Error('extractor setup requires an agent scope')
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    agentCtx.systemPrompt.suppressRuntimeContext()
    const section: PromptSection = {
      name: EXTRACTOR_SECTION,
      order: 0,
      text: AUTHORIZATION_EXTRACTOR_SYSTEM_PROMPT,
      complete: true,
    }
    agentCtx.systemPrompt.section(section)
    agentCtx.tools.restrict({ allow: [] })
    const scoped = createExtractionTool(childSessionId, submitExtraction)
    agentCtx.tools.register(scoped.definition)
    agentCtx.on('tools/result', (exec, result) => scoped.observeResult(exec, result))
    setApprovalPolicy(agent.session, 'never')
    setSandboxMode(agent.session, 'read-only')
  }
}
