/**
 * Phase 3 exit-condition fixture: prove the plugin compiles against the REAL
 * stock Guarded Continuable contracts (`ctx.managedAgents`) without local
 * facsimiles or `as unknown as` through the DSH seam. The runtime fakes below
 * stop at the boundary the plugin owns.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  ManagedAgentComposition,
  ManagedAgentController,
  ManagedAgentMaterializeInfo,
  ManagedAgentProvider,
  ManagedProviderRegistration,
} from 'dsh-managed-agent'
import {
  createDecisionTool,
  createReviewerPolicyV1,
  createReviewerProvider,
  createReviewerProviderData,
  createActionSnapshot,
  createApprovalReviewPacketV1,
  createApprovalReviewRequest,
  snapshotJson,
} from '../../src/index.js'

describe('real guarded-continuable contract fixture', () => {
  it('exposes ctx.managedAgents instead of augmenting stock SubagentRuntime', () => {
    expectTypeOf<Context['managedAgents']['registerProvider']>()
      .parameter(0).toEqualTypeOf<ManagedAgentProvider>()
    expectTypeOf<ReturnType<Context['managedAgents']['registerProvider']>>()
      .toEqualTypeOf<ManagedProviderRegistration>()
  })

  it('lets the plugin provider satisfy the real ManagedAgentProvider', () => {
    const provider: ManagedAgentProvider = createReviewerProvider({
      submitDecision: { submit: vi.fn() },
    })
    const composition = provider.materialize({
      source: 'startup',
      parentSessionId: SessionId('parent-1'),
      childSessionId: SessionId('reviewer-1'),
      descriptor: {
        version: 1,
        provider: 'dsh-approve-for-me/reviewer',
        label: 'Approval Reviewer',
        providerData: snapshotJson(createReviewerProviderData({
          generation: 'generation-1',
          modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          policyVersion: 'policy-v1',
          toolsetVersion: 1,
        })),
      },
    })
    expectTypeOf<typeof composition>().toEqualTypeOf<ManagedAgentComposition>()
    expect(composition.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(composition.toolFilter).toEqual({ allow: [] })
    expect(typeof composition.setup).toBe('function')
  })

  it('lets the scoped decision tool satisfy the real ToolDefinition', async () => {
    const tool = createDecisionTool('reviewer-1', { submit: vi.fn() }).definition
    const definition: ToolDefinition = tool
    expect(definition.name).toBe('submit_approval_decision')
    // The real execute signature is exercised with a structural context stub.
    const exec = {
      callId: 'call-1' as ToolRunContext['callId'],
      rootCallId: 'call-1' as ToolRunContext['rootCallId'],
      name: definition.name,
      arguments: {},
      agent: { id: SessionId('reviewer-1'), session: { id: SessionId('reviewer-1') } } as Agent,
      signal: new AbortController().signal,
      token: Symbol('token') as ToolRunContext['token'],
      deferContext: () => {},
      concludeTurn: () => {},
    } satisfies ToolRunContext
    // The contract now validates before staging: exercise execute with a
    // well-formed decision payload.
    const value = await definition.execute({
      protocolVersion: 1,
      reviewId: 'review-1',
      parentSessionId: 'parent-1',
      reviewerSessionId: 'reviewer-1',
      generation: 'generation-1',
      actionHash: `sha256:${'0'.repeat(64)}`,
      decision: 'allow',
      risk: 'low',
      categories: [],
      userAuthorization: 'explicit',
      rationale: 'Explicitly authorized.',
    }, exec)
    expect(value).toEqual({ recorded: true })
  })

  it('keeps the policy content in the real ContentBlock vocabulary', () => {
    const policy = createReviewerPolicyV1()
    const request = createApprovalReviewRequest(createActionSnapshot({ toolName: 'bash', arguments: {} }), {
      reviewId: 'review-1', parentSessionId: 'parent-1', reviewerSessionId: 'reviewer-1', generation: 'generation-1', issuedAt: 100, deadlineAt: 200,
    })
    const blocks: ContentBlock[] = policy.buildRequestContent(createApprovalReviewPacketV1({
      request,
      dossier: { version: 1, kind: 'guardian-dossier', freeze: { parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 0 }, throughSeq: 1, currentTurn: 1, currentStep: 0, frozenAt: 1 }, environment: {}, instructions: {}, interaction: {}, currentTurnTools: {}, pendingApproval: {}, completeness: { ready: true } },
    }))
    expect(blocks[0]!.type).toBe('text')
  })

  it('holds the controller authority through the real capability interface', () => {
    // Structural verification only: the adapter maps the capability one-to-one.
    const controller: ManagedAgentController = {
      create: async () => SessionId('reviewer-1'),
      list: async () => [],
      rotate: async () => SessionId('reviewer-2'),
      renew: async () => SessionId('reviewer-2'),
      deliver: async (): Promise<MessageId> => MessageId('message-1'),
      interrupt: () => {},
    }
    expect(controller).toBeDefined()
    // The exact live parent stays the authority argument, never a session id.
    type CreateParams = Parameters<ManagedAgentController['create']>
    expectTypeOf<CreateParams[0]>().toEqualTypeOf<Agent>()
  })

  it('loads ctx.managedAgents on a real Context through the Host declarations', () => {
    const register = (ctx: Context): unknown => ctx.managedAgents.registerProvider(
      createReviewerProvider({ submitDecision: { submit: vi.fn() } }),
    )
    expectTypeOf<typeof register>().parameter(0).toEqualTypeOf<Context>()
  })

  it('supplies the exact descriptor shape for startup and resume materialization', () => {
    const provider: ManagedAgentProvider = createReviewerProvider({
      submitDecision: { submit: vi.fn() },
    })
    const info: ManagedAgentMaterializeInfo = {
      source: 'resume',
      parentSessionId: SessionId('parent-1'),
      childSessionId: SessionId('reviewer-1'),
      descriptor: {
        version: 1,
        provider: 'dsh-approve-for-me/reviewer',
        label: 'Approval Reviewer',
        providerData: snapshotJson(createReviewerProviderData({
          generation: 'generation-1',
          modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          policyVersion: 'policy-v1',
          toolsetVersion: 1,
        })),
      },
    }
    expect(provider.materialize(info).agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})
