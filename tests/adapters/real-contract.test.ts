/**
 * Phase 0 exit-condition fixture: prove the plugin compiles against the REAL
 * patched-DSH contracts without local facsimiles or `as unknown as` through
 * the DSH seam. The runtime fakes below stop at the boundary the plugin owns.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  ManagedProviderRegistration,
  ManagedSubagentComposition,
  ManagedSubagentController,
  ManagedSubagentProvider,
  SubagentRuntime,
} from 'dsh-managed-agent'
import {
  createApprovalAnswerer,
  createDecisionTool,
  createReviewerPolicyV1,
  createReviewerProvider,
  createReviewerProviderData,
  snapshotJson,
} from '../../src/index.js'
import type { ApprovalDecision } from '../../src/index.js'

describe('real patched-DSH contract fixture', () => {
  it('augments the published SubagentRuntime with the managed capability', () => {
    expectTypeOf<SubagentRuntime['registerManagedProvider']>()
      .parameter(0).toEqualTypeOf<ManagedSubagentProvider>()
    expectTypeOf<ReturnType<SubagentRuntime['registerManagedProvider']>>()
      .toEqualTypeOf<ManagedProviderRegistration>()
  })

  it('lets the plugin provider satisfy the real ManagedSubagentProvider', async () => {
    const provider: ManagedSubagentProvider = createReviewerProvider({
      submitDecision: { submit: vi.fn() },
    })
    const composition = await provider.materialize({
      source: 'startup',
      parentSessionId: SessionId('parent-1'),
      childSessionId: SessionId('reviewer-1'),
      descriptor: {
        version: 3,
        mode: 'managed',
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
    expectTypeOf<typeof composition.agentOptions>().toEqualTypeOf<AgentOptions | undefined>()
    expectTypeOf<typeof composition.setup>().toEqualTypeOf<AgentSetup | undefined>()
    expect(composition.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
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
    const value = await definition.execute({}, exec)
    expect(value).toEqual({ recorded: true })
  })

  it('lets the answerer satisfy the real approval/request listener shape', () => {
    const answerer = createApprovalAnswerer({
      coordinator: { review: vi.fn(async () => ({ decision: 'deny' }) as ApprovalDecision) },
      captures: { remember: () => {}, lookup: () => undefined, release: () => false },
      mode: 'auto',
    })
    // Exact DSH waterfall listener signature: (req, next) => Promise<ApprovalOutcome>.
    const handler = answerer as (
      req: ApprovalRequest,
      next: () => Promise<ApprovalOutcome>,
    ) => Promise<ApprovalOutcome>
    expect(typeof handler).toBe('function')
  })

  it('keeps the policy content in the real ContentBlock vocabulary', () => {
    const policy = createReviewerPolicyV1()
    const blocks: ContentBlock[] = policy.buildRequestContent({
      protocolVersion: 1,
      reviewId: 'review-1',
      parentSessionId: 'parent-1',
      reviewerSessionId: 'reviewer-1',
      generation: 'generation-1',
      actionHash: `sha256:${'0'.repeat(64)}`,
      issuedAt: 100,
      deadlineAt: 200,
      action: {
        version: 1,
        kind: 'tool-call',
        toolName: 'bash',
        arguments: {},
        requestedPermissions: [],
      },
    })
    expect(blocks[0]!.type).toBe('text')
  })

  it('holds the controller authority through the real capability interface', () => {
    // Structural verification only: the adapter maps the capability one-to-one.
    const controller: ManagedSubagentController = {
      create: async () => SessionId('reviewer-1'),
      list: async () => [],
      deliver: async (): Promise<MessageId> => MessageId('message-1'),
      interrupt: () => {},
    }
    expect(controller).toBeDefined()
    // The exact live parent stays the authority argument, never a session id.
    type CreateParams = Parameters<ManagedSubagentController['create']>
    expectTypeOf<CreateParams[0]>().toEqualTypeOf<Agent>()
  })

  it('never requires a DSH import to see ctx.subagents on a real Context', () => {
    // Importing dsh-managed-agent (as every adapter file does) loads the
    // patched declarations into this program: the compiled fixture below uses
    // the REAL cordis Context type and must resolve the capability.
    const register = (ctx: Context): unknown => ctx.subagents.registerManagedProvider(
      createReviewerProvider({ submitDecision: { submit: vi.fn() } }),
    )
    expectTypeOf<typeof register>().parameter(0).toEqualTypeOf<Context>()
  })
})
