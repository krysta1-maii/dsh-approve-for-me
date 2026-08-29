import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ManagedAgentProvider, ManagedProviderRegistration } from 'dsh-managed-agent'
import {
  REVIEWER_PROVIDER,
  SUBMIT_DECISION_TOOL,
  fingerprintApprovalToolCatalogV1,
  installApproveForMe,
  parseApprovalReviewRequest,
} from '../../src/index.js'
import type { Config } from '../../src/index.js'

type CtxEvent = 'tools/pre-execute' | 'tools/result'

const validToolCatalog = () => {
  const unsealed = {
    version: 1 as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: '',
    descriptors: [{ toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'body-escalation' as const }],
  }
  return { ...unsealed, fingerprint: fingerprintApprovalToolCatalogV1(unsealed)! }
}

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
  }
  disposeRegistration: ReturnType<typeof vi.fn>
}

function harness(): InstallHarness {
  const listeners: InstallHarness['listeners'] = {
    preExecute: undefined,
    result: undefined,
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
  it('registers the managed Reviewer and retains capture hooks without an approval/request listener', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.registered?.name).toBe(REVIEWER_PROVIDER)
    expect(plugin.getDossierCompilationMetrics()).toMatchObject({ attempts: 0, overflowRate: 0 })

    // Complete action capture remains available to the sole machine-policy path.
    // No legacy approval/request listener is registered.
    const parent = { id: 'parent-1', session: { id: 'parent-1' } }
    await h.listeners.preExecute!({
      agent: parent,
      callId: 'call-1',
      name: 'bash',
      arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))
    const policy = h.machinePolicy as { decide(request: { agent: typeof parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    await expect(policy.decide({ agent: parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('unavailable')

    // A non-authorizing empty catalog must not materialize a Reviewer.
    expect(h.composition).toEqual({
      suppressions: 0,
      restrictions: 0,
      approvalNever: 0,
      sandboxReadOnly: 0,
      resultObservers: 0,
    })
    expect(h.childTool).toBeUndefined()

    h.listeners.result!({ agent: parent, callId: 'call-1' }, {})

    await plugin.dispose()
    expect(h.disposeRegistration).toHaveBeenCalledOnce()
  })

  it('fails closed without a source-verified dossier despite a matching catalog', async () => {
    const h = harness()
    const catalogConfig: Config = {
      ...config,
      toolCatalog: validToolCatalog(),
    }
    const plugin = installApproveForMe(h.ctx as unknown as Context, catalogConfig)
    const policy = h.machinePolicy as {
      decide(request: { agent: { id: string }; toolName: string; callId?: string; requestId?: string }): Promise<string>
    }

    const parent = { id: 'parent-1', session: { id: 'parent-1' } }
    await h.listeners.preExecute!({
      agent: parent,
      callId: 'call-1',
      name: 'bash',
      arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))

    await expect(policy.decide({
      agent: parent,
      toolName: 'bash',
      callId: 'call-1',
      requestId: 'ask-1',
    })).resolves.toBe('unavailable')

    await plugin.dispose()
  })

  it('fails loud when toolCatalog is configured without the patched machine-policy fork', () => {
    const h = harness()
    const catalogConfig: Config = {
      ...config,
      toolCatalog: validToolCatalog(),
    }
    const withoutFork = { ...h.ctx, approval: undefined } as unknown as Context
    expect(() => installApproveForMe(withoutFork, catalogConfig)).toThrow(/patched @deepseek-ai\/dsh-user-approval/)
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
    // Empty catalog is non-authorizing and does not restore a waterfall listener.
    await expect(policy.decide({
      agent: parent,
      toolName: 'bash',
      callId: 'call-1',
      requestId: 'ask-1',
    })).resolves.toBe('unavailable')

    await plugin.dispose()
    expect(h.disposeMachinePolicy).toHaveBeenCalledOnce()
  })

  it('keeps missing capture closed even in auto-then-user mode', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, { ...config, mode: 'auto-then-user' })
    const policy = h.machinePolicy as { decide(request: { agent: { id: string; session: { id: string } }; toolName: string; callId: string; requestId: string }): Promise<string> }
    await expect(policy.decide({
      agent: { id: 'agent-1', session: { id: 'parent-1' } },
      toolName: 'bash',
      callId: 'missing',
      requestId: 'ask-1',
    })).resolves.toBe('unavailable')
    await plugin.dispose()
  })

  it('prepends capture but never registers an approval/request listener', () => {
    const h = harness()
    installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.listeners.preExecute).toBeTypeOf('function')
    expect(h.listeners.result).toBeTypeOf('function')
    expect(Object.hasOwn(h.listeners, 'answerer')).toBe(false)
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
