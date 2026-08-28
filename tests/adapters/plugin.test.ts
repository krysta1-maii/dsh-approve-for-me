import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ManagedAgentProvider, ManagedProviderRegistration } from 'dsh-managed-agent'
import {
  REVIEWER_PROVIDER,
  SUBMIT_DECISION_TOOL,
  installApproveForMe,
  parseApprovalReviewRequest,
} from '../../src/index.js'
import type { Config } from '../../src/index.js'

type CtxEvent = 'tools/pre-execute' | 'tools/result' | 'approval/request'

const config: Config = {
  reviewer: {
    generation: 'reviewer-v1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    policyVersion: 'policy-v1',
    toolsetVersion: 1,
  },
  timeoutMs: 1_000,
}

function decisionFor(request: ReturnType<typeof parseApprovalReviewRequest>) {
  return {
    protocolVersion: 1,
    reviewId: request.reviewId,
    parentSessionId: request.parentSessionId,
    reviewerSessionId: request.reviewerSessionId,
    generation: request.generation,
    actionHash: request.actionHash,
    decision: 'allow',
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'The request is explicitly authorized.',
  }
}

interface InstallHarness {
  ctx: {
    managedAgents: { registerProvider(provider: ManagedAgentProvider): ManagedProviderRegistration }
    approval: { registerMachinePolicy(policy: unknown): () => void }
    on(event: CtxEvent, listener: (...args: unknown[]) => unknown): () => void
    effect(setup: () => (() => void | Promise<void>), label?: string): unknown
  }
  registered: ManagedAgentProvider | undefined
  machinePolicy: unknown | undefined
  disposeMachinePolicy: ReturnType<typeof vi.fn>
  composition: { suppressions: number; restrictions: number; approvalNever: number; sandboxReadOnly: number; resultObservers: number }
  childTool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
  resultObserver: ((exec: unknown, result: unknown) => unknown) | undefined
  listeners: {
    preExecute: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    result: ((exec: unknown, result: unknown) => unknown) | undefined
    answerer: ((request: { agent: { id: string }; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }, next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>) | undefined
  }
  disposeRegistration: ReturnType<typeof vi.fn>
}

function harness(): InstallHarness {
  const listeners: InstallHarness['listeners'] = {
    preExecute: undefined,
    result: undefined,
    answerer: undefined,
  }
  const composition: InstallHarness['composition'] = {
    suppressions: 0,
    restrictions: 0,
    approvalNever: 0,
    sandboxReadOnly: 0,
    resultObservers: 0,
  }
  const disposeRegistration = vi.fn(async () => {})
  const disposeMachinePolicy = vi.fn(() => {})
  let registered: ManagedAgentProvider | undefined
  let machinePolicy: unknown | undefined
  let childTool: InstallHarness['childTool']
  let resultObserver: InstallHarness['resultObserver']
  const child: { id: string; session: { id: string; append: (type: string, data: unknown) => void } } = {
    id: 'reviewer-1',
    session: {
      id: 'reviewer-1',
      append: (type: string) => {
        if (type === 'approval/policy') composition.approvalNever += 1
        if (type === 'sandbox/mode') composition.sandboxReadOnly += 1
      },
    },
  }
  const ctx = {
    managedAgents: {
      registerProvider(provider: ManagedAgentProvider): ManagedProviderRegistration {
        registered = provider
        return {
          controller: {
            async create(_parent: unknown, options: { providerData?: unknown; label: string }) {
              const compositionResult = registered!.materialize({
                source: 'startup',
                parentSessionId: SessionId('parent-1'),
                childSessionId: SessionId('reviewer-1'),
                descriptor: {
                  version: 1,
                  provider: REVIEWER_PROVIDER,
                  label: options.label,
                  providerData: options.providerData as never,
                },
              })
              compositionResult.setup?.({
                agent: child,
                systemPrompt: {
                  suppressRuntimeContext: () => { composition.suppressions += 1; return () => {} },
                  section: () => () => {},
                },
                tools: {
                  restrict: () => { composition.restrictions += 1; return () => {} },
                  register: (tool: unknown) => { childTool = tool as InstallHarness['childTool']; return () => {} },
                },
                on: (event: string, listener: (...args: unknown[]) => unknown) => {
                  if (event === 'tools/result') {
                    composition.resultObservers += 1
                    resultObserver = listener as InstallHarness['resultObserver']
                  }
                  return () => {}
                },
              } as never)
              return SessionId('reviewer-1')
            },
            async list() { return [] },
            async rotate() { return SessionId('reviewer-1') },
            async deliver(_parent: unknown, _childId: unknown, content: readonly unknown[]) {
              const raw = (content[0] as { text: string } | undefined)?.text.split('\n').at(-1)
              if (raw === undefined) throw new Error('approval request was not delivered')
              const request = parseApprovalReviewRequest(JSON.parse(raw))
              expect(childTool?.name).toBe(SUBMIT_DECISION_TOOL)
              // Simulate the real two-phase pipeline: the scoped tool stages
              // the candidate and the child-scoped tools/result observer is
              // the authoritative submit point.
              const exec = {
                callId: 'child-call-1',
                rootCallId: 'child-call-1',
                name: SUBMIT_DECISION_TOOL,
                arguments: decisionFor(request),
                agent: { id: 'reviewer-1', session: { id: 'reviewer-1' } },
                signal: new AbortController().signal,
                token: Symbol('token'),
                deferContext: () => {},
                concludeTurn: () => {},
              }
              await childTool!.execute(exec.arguments, exec)
              resultObserver?.(exec, { isError: false, value: { recorded: true }, content: [] })
              return MessageId('message-1')
            },
            interrupt: vi.fn(),
          },
          dispose: disposeRegistration,
        }
      },
    },
    approval: {
      registerMachinePolicy(policy: unknown): () => void {
        machinePolicy = policy
        return disposeMachinePolicy
      },
    },
    on(event: CtxEvent, listener: (...args: unknown[]) => unknown) {
      if (event === 'tools/pre-execute') listeners.preExecute = listener as InstallHarness['listeners']['preExecute']
      if (event === 'tools/result') listeners.result = listener as InstallHarness['listeners']['result']
      if (event === 'approval/request') listeners.answerer = listener as InstallHarness['listeners']['answerer']
      return () => {}
    },
    effect(setup: () => (() => void | Promise<void>)) { return setup() },
  }
  return {
    ctx: ctx as unknown as InstallHarness['ctx'],
    get registered() { return registered },
    get machinePolicy() { return machinePolicy },
    disposeMachinePolicy,
    composition,
    get childTool() { return childTool },
    get resultObserver() { return resultObserver },
    listeners,
    disposeRegistration,
  }
}

describe('installApproveForMe composition root', () => {
  it('registers the managed Reviewer, captures the complete action, and accepts its scoped result', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.registered?.name).toBe(REVIEWER_PROVIDER)

    // Complete action capture on pre-execute; the fake child submits during
    // deliver, so the answerer must return the automatic grant. The capture
    // store keys by EXACT Agent identity, so every phase reuses one object.
    const parent = { id: 'parent-1', session: { id: 'parent-1' } }
    await h.listeners.preExecute!({
      agent: parent,
      callId: 'call-1',
      name: 'bash',
      arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))
    await expect(h.listeners.answerer!({
      agent: parent,
      toolName: 'bash',
      callId: 'call-1',
    }, async () => 'rejected')).resolves.toBe('allowed-once')

    // The create-time setup composed the complete locked-down Reviewer scope.
    expect(h.composition).toEqual({
      suppressions: 1,
      restrictions: 1,
      approvalNever: 1,
      sandboxReadOnly: 1,
      resultObservers: 1,
    })
    expect(h.childTool?.name).toBe(SUBMIT_DECISION_TOOL)

    // Release happens on tools/result: the next approval for the same call
    // must fail closed.
    h.listeners.result!({ agent: parent, callId: 'call-1' }, {})
    await expect(h.listeners.answerer!({
      agent: parent,
      toolName: 'bash',
      callId: 'call-1',
    }, async () => 'rejected')).resolves.toBe('unavailable')

    await plugin.dispose()
    expect(h.disposeRegistration).toHaveBeenCalledOnce()
  })

  it('registers the machine-policy adapter, resolves captured hashes, and disposes it exactly once', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.machinePolicy).toMatchObject({ id: 'dsh-approve-for-me/v1' })

    const policy = h.machinePolicy as { decide(request: { agent: { id: string }; toolName: string; callId?: string; requestId?: string }): Promise<string> }
    const parent = { id: 'parent-1', session: { id: 'parent-1' } }
    await h.listeners.preExecute!({
      agent: parent,
      callId: 'call-1',
      name: 'bash',
      arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))
    // The transitional gate declines so the existing waterfall answerer still
    // owns authorization until P2.
    await expect(policy.decide({
      agent: parent,
      toolName: 'bash',
      callId: 'call-1',
      requestId: 'ask-1',
    })).resolves.toBe('delegate')

    await plugin.dispose()
    expect(h.disposeMachinePolicy).toHaveBeenCalledOnce()
  })

  it('delegates to the downstream answerer in auto-then-user mode when capture is missing', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, { ...config, mode: 'auto-then-user' })
    const next = vi.fn(async () => 'rejected' as const)
    await expect(h.listeners.answerer!({
      agent: { id: 'parent-1' },
      toolName: 'bash',
      callId: 'missing',
    }, next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    await plugin.dispose()
  })

  it('prepends capture and answerer so policy watchers see the action first', () => {
    const calls: string[] = []
    const ctx = {
      managedAgents: { registerProvider: () => ({ controller: { create: async () => SessionId('r'), list: async () => [], rotate: async () => SessionId('r'), deliver: async () => MessageId('m'), interrupt: () => {} }, dispose: async () => {} }) },
      on(event: string, _listener: unknown, options?: { prepend?: boolean }) {
        calls.push(`${event}:${String(options?.prepend ?? false)}`)
        return () => {}
      },
      effect(setup: () => (() => void | Promise<void>)) { return setup() },
    }
    installApproveForMe(ctx as unknown as Context, config)
    expect(calls).toContain('tools/pre-execute:true')
    expect(calls).toContain('approval/request:true')
    expect(calls).toContain('tools/result:false')
  })

  it('disposes the old registration and can be remounted after unload', async () => {
    const first = harness()
    const plugin = installApproveForMe(first.ctx as unknown as Context, config)
    await plugin.dispose()
    expect(first.disposeRegistration).toHaveBeenCalledOnce()

    const second = harness()
    const reloaded = installApproveForMe(second.ctx as unknown as Context, config)
    expect(second.registered?.name).toBe(REVIEWER_PROVIDER)
    await reloaded.dispose()
    expect(second.disposeRegistration).toHaveBeenCalledOnce()
  })
})
