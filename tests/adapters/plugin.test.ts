import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ManagedAgentProvider, ManagedProviderRegistration } from 'dsh-managed-agent'
import {
  REVIEWER_PROVIDER,
  SUBMIT_DECISION_TOOL,
  fingerprintApprovalToolCatalogV1,
  createFilesystemActionProjector,
  createShellProcessActionProjector,
  createDshAlpha2StockToolCatalog,
  ToolFamilyActionProjectorRegistry,
  ApprovalRunLifecycle,
  DshStorageDomainFactRepositories,
  DshStorageDomainGateDecisionRecordStore,
  DshStorageDomainSealedFacts,
  SerialLanes,
  installApproveForMe,
  parseApprovalReviewRequest,
} from '../../src/index.js'
import type { Config } from '../../src/index.js'
import * as approveForMe from '../../src/index.js'

type CtxEvent = 'tools/pre-execute' | 'tools/result'

const validToolCatalog = () => {
  const unsealed = {
    version: 1 as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: '',
    descriptors: [{ toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'body-escalation' as const, actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'dsh-approve-for-me/shell-process-v1' }],
  }
  return { ...unsealed, fingerprint: fingerprintApprovalToolCatalogV1(unsealed)! }
}

const catalogProjectors = new ToolFamilyActionProjectorRegistry([createShellProcessActionProjector()])

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
    tools: { schemas(agent: unknown): readonly unknown[] }
    on(event: CtxEvent | 'llm/adapters-updated', listener: (...args: unknown[]) => unknown): () => void
    effect(setup: () => (() => void | Promise<void>), label?: string): unknown
    inject(services: readonly string[], listener: (ctx: unknown) => void): Promise<void>
    logger: { error(error: unknown): void }
    llm: {
      listProviders(): Array<{ id: string; name: string }>
      listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>>
      resolveModelInfo(provider: string, model: string): Promise<{ provider: string; id: string; name: string }>
    }
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
    topology: (() => unknown) | undefined
  }
  disposeRegistration: ReturnType<typeof vi.fn>
}

function harness(): InstallHarness {
  const listeners: InstallHarness['listeners'] = {
    preExecute: undefined,
    result: undefined,
    topology: undefined,
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
            async renew() { return SessionId('reviewer-1') },
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
        return () => {
          machinePolicy = undefined
          disposeMachinePolicy()
        }
      },
    },
    tools: { schemas: vi.fn(() => []) },
    llm: {
      listProviders: vi.fn(() => [{ id: 'deepseek', name: 'DeepSeek' }]),
      listModels: vi.fn(async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
      resolveModelInfo: vi.fn(async () => ({ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' })),
    },
    on(event: CtxEvent | 'llm/adapters-updated', listener: (...args: unknown[]) => unknown) {
      if (event === 'tools/pre-execute') listeners.preExecute = listener as InstallHarness['listeners']['preExecute']
      if (event === 'tools/result') listeners.result = listener as InstallHarness['listeners']['result']
      if (event === 'llm/adapters-updated') listeners.topology = listener as InstallHarness['listeners']['topology']
      return () => {}
    },
    effect(setup: () => (() => void | Promise<void>)) { return setup() },
    inject: vi.fn(async () => {}),
    logger: { error: vi.fn() },
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
    expect(plugin.getReviewerTelemetryMetrics()).toMatchObject({ reviews: 0, fallbacks: 0, attempts: 0 })

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

  it('rejects full case capture until a durable host-private adapter exists', () => {
    const h = harness()
    expect(() => installApproveForMe(h.ctx as unknown as Context, {
      ...config,
      caseCapture: { mode: 'full', maxCases: 1, maxArtifactBytes: 1, maxTotalBytes: 1, retentionDays: 1 },
    })).toThrow(/host-private durable case-capture adapter/)
    expect(h.registered).toBeUndefined()
  })

  it('fails closed without a source-verified dossier despite a matching catalog', async () => {
    const h = harness()
    const catalogConfig: Config = {
      ...config,
      toolCatalog: validToolCatalog(),
    }
    const plugin = installApproveForMe(h.ctx as unknown as Context, catalogConfig, { toolFamilyActionProjectors: catalogProjectors })
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

  it('rejects catalog bindings without an exact registered semantic projector before provider registration', () => {
    const h = harness()
    const catalogConfig: Config = { ...config, toolCatalog: validToolCatalog() }
    expect(() => installApproveForMe(h.ctx as unknown as Context, catalogConfig))
      .toThrow(/loader stock projectors require argumentSemanticsId/)
    expect(h.registered).toBeUndefined()

    const wrongTool = new ToolFamilyActionProjectorRegistry([createShellProcessActionProjector(['sh'])])
    expect(() => installApproveForMe(h.ctx as unknown as Context, catalogConfig, { toolFamilyActionProjectors: wrongTool }))
      .toThrow(/no matching registered semantic projector/)
    expect(h.registered).toBeUndefined()

    const extraTool = new ToolFamilyActionProjectorRegistry([createShellProcessActionProjector(), createFilesystemActionProjector({ read: 'read' })])
    expect(() => installApproveForMe(h.ctx as unknown as Context, catalogConfig, { toolFamilyActionProjectors: extraTool }))
      .toThrow(/absent from toolCatalog/)
    expect(h.registered).toBeUndefined()
  })

  it('mounts through the normal loader path without taking an unscoped schema snapshot', async () => {
    const h = harness()
    const loaderContext = h.ctx as InstallHarness['ctx'] & {
      tools: { schemas(agent: unknown): readonly unknown[] }
    }
    const schemas = vi.fn((_agent: unknown) => [
      { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      { name: 'todo_write', description: 'Record tasks', parameters: { type: 'object', properties: { todos: { type: 'array' } } } },
    ])
    loaderContext.tools = { schemas }

    expect('default' in approveForMe).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(approveForMe) as typeof approveForMe
    expect(unwrapped).toBe(approveForMe)
    expect(unwrapped.name).toBe('dsh-approve-for-me')
    expect(unwrapped.inject).toEqual(['agents', 'managedAgents', 'tools', 'systemPrompt', 'approval', 'storageDomain', 'llm'])
    await unwrapped.apply(loaderContext as unknown as Context, config)
    expect(h.registered?.name).toBe(REVIEWER_PROVIDER)
    expect(schemas).not.toHaveBeenCalled()
    expect(h.listeners.preExecute).toBeTypeOf('function')
    expect(h.machinePolicy).toMatchObject({ id: 'dsh-approve-for-me/v1' })
  })

  it('uses a pre-mounted settings route before arming any Reviewer policy', async () => {
    const h = harness()
    const selected = { reviewer: { provider: 'openai-codex', model: 'gpt-5.6-terra' } }
    const installSection = vi.fn((_owner, namespace, _schema, base, hooks: {
      setSource(source: () => typeof selected): void
      onChange(): void
    }) => {
      expect(namespace).toBe('dsh-approve-for-me')
      expect(base).toEqual({ reviewer: { provider: 'deepseek', model: 'deepseek-chat' } })
      hooks.setSource(() => selected)
      hooks.onChange()
    })
    h.ctx.inject = vi.fn(async (_services, listener) => {
      listener({ settings: { installSection } })
    })
    h.ctx.llm.listProviders = vi.fn(() => [{ id: 'openai-codex', name: 'Codex' }])
    h.ctx.llm.listModels = vi.fn(async provider => [{ provider, id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' }])
    h.ctx.llm.resolveModelInfo = vi.fn(async (provider, model) => ({ provider, id: model, name: model }))

    await approveForMe.apply(h.ctx as unknown as Context, config)

    expect(installSection).toHaveBeenCalledOnce()
    expect(h.ctx.llm.listModels).toHaveBeenCalledTimes(1)
    expect(h.ctx.llm.listModels).toHaveBeenCalledWith('openai-codex')
    expect(h.ctx.llm.resolveModelInfo).toHaveBeenCalledWith('openai-codex', 'gpt-5.6-terra', expect.any(AbortSignal))
    expect(h.machinePolicy).toMatchObject({ id: 'dsh-approve-for-me/v1' })
  })

  it('retires the old policy immediately for an unavailable settings route and rearms on catalog recovery', async () => {
    const h = harness()
    let selected = { reviewer: { provider: 'deepseek', model: 'deepseek-chat' } }
    let settingsHooks: { onChange(): void } | undefined
    h.ctx.inject = vi.fn(async (_services, listener) => {
      listener({ settings: { installSection: (_owner: unknown, _namespace: string, _schema: unknown, _base: unknown, hooks: {
        setSource(source: () => typeof selected): void
        onChange(): void
      }) => {
        settingsHooks = hooks
        hooks.setSource(() => selected)
        hooks.onChange()
      } } })
    })
    const listProviders = vi.fn(() => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai-codex', name: 'Codex' },
    ])
    let terraAvailable = false
    const listModels = vi.fn(async (provider: string) => provider === 'openai-codex'
      ? terraAvailable ? [{ provider, id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' }] : []
      : [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' }])
    h.ctx.llm.listProviders = listProviders
    h.ctx.llm.listModels = listModels
    h.ctx.llm.resolveModelInfo = vi.fn(async (provider, model) => ({ provider, id: model, name: model }))

    await approveForMe.apply(h.ctx as unknown as Context, config)
    expect(h.machinePolicy).toBeDefined()

    selected = { reviewer: { provider: 'openai-codex', model: 'gpt-5.6-terra' } }
    settingsHooks!.onChange()
    expect(h.machinePolicy).toBeUndefined()
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledWith('openai-codex'))
    expect(h.machinePolicy).toBeUndefined()

    terraAvailable = true
    h.listeners.topology?.()
    await vi.waitFor(() => expect(h.machinePolicy).toMatchObject({ id: 'dsh-approve-for-me/v1' }))
    expect(h.ctx.llm.resolveModelInfo).toHaveBeenLastCalledWith('openai-codex', 'gpt-5.6-terra', expect.any(AbortSignal))
  })

  it('stays dormant after a late settings attachment fails, even on later topology signals', async () => {
    const h = harness()
    let attachSettings: ((ctx: unknown) => void) | undefined
    h.ctx.inject = vi.fn(async (_services, listener) => {
      attachSettings = listener
    })

    await approveForMe.apply(h.ctx as unknown as Context, config)
    expect(h.machinePolicy).toBeDefined()

    expect(() => attachSettings!({
      settings: { installSection: () => { throw new Error('invalid stored AFM settings') } },
    })).toThrow(/invalid stored AFM settings/)
    expect(h.machinePolicy).toBeUndefined()

    h.listeners.topology?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.machinePolicy).toBeUndefined()
  })

  it('withdraws on topology drift and rearms only after the configured route returns', async () => {
    const h = harness()
    const listModels = vi.fn(async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }])
    h.ctx.llm.listModels = listModels
    await approveForMe.apply(h.ctx as unknown as Context, config)
    expect(h.machinePolicy).toBeDefined()

    listModels.mockResolvedValue([])
    h.listeners.topology?.()
    expect(h.disposeMachinePolicy).toHaveBeenCalledOnce()
    expect(h.machinePolicy).toBeUndefined()
    await vi.waitFor(() => expect(h.disposeRegistration).toHaveBeenCalledOnce())
    expect(h.machinePolicy).toBeUndefined()

    listModels.mockResolvedValue([{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }])
    h.listeners.topology?.()
    await vi.waitFor(() => expect(h.machinePolicy).toMatchObject({ id: 'dsh-approve-for-me/v1' }))
  })

  it('keeps a stale Guardian route unarmed and installs after the DSH catalog publishes it', async () => {
    const h = harness()
    const listProviders = vi.fn<() => Array<{ id: string; name: string }>>(() => [])
    h.ctx.llm.listProviders = listProviders
    await expect(approveForMe.apply(h.ctx as unknown as Context, config)).resolves.toBeUndefined()
    expect(h.registered).toBeUndefined()
    expect(h.machinePolicy).toBeUndefined()

    listProviders.mockReturnValue([{ id: 'deepseek', name: 'DeepSeek' }])
    h.listeners.topology?.()
    await vi.waitFor(() => expect(h.registered?.name).toBe(REVIEWER_PROVIDER))
    expect(h.machinePolicy).toMatchObject({ id: 'dsh-approve-for-me/v1' })
  })

  it('mounts a supported non-empty stock catalog through the loader without programmatic projector options', async () => {
    const h = harness()
    const stockSchemas = [
      { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'read', description: 'Read a text file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    ]
    const stockCatalog = createDshAlpha2StockToolCatalog(stockSchemas)
    expect(stockCatalog.descriptors).toHaveLength(2)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(approveForMe) as typeof approveForMe
    await expect(unwrapped.apply(h.ctx as unknown as Context, { ...config, toolCatalog: stockCatalog })).resolves.toBeUndefined()
    expect(h.registered?.name).toBe(REVIEWER_PROVIDER)
  })

  it('accepts every explicitly-bound tool family in a closed catalog', async () => {
    const h = harness()
    const unsealed = {
      version: 1 as const,
      argumentSemanticsId: 'default-v1',
      fingerprint: '',
      descriptors: [
        { toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classification: 'body-escalation' as const, actionSemanticsFamily: 'shell-process-v1', actionProjectorId: 'dsh-approve-for-me/shell-process-v1' },
        { toolName: 'read', toolSchemaFingerprint: 'read-fp', classification: 'ordinary' as const, actionSemanticsFamily: 'filesystem-v1', actionProjectorId: 'dsh-approve-for-me/filesystem-v1' },
      ],
    }
    const catalogConfig: Config = { ...config, toolCatalog: { ...unsealed, fingerprint: fingerprintApprovalToolCatalogV1(unsealed)! } }
    const projectors = new ToolFamilyActionProjectorRegistry([
      createShellProcessActionProjector(), createFilesystemActionProjector({ read: 'read' }),
    ])
    const plugin = installApproveForMe(h.ctx as unknown as Context, catalogConfig, { toolFamilyActionProjectors: projectors })
    expect(h.registered?.name).toBe(REVIEWER_PROVIDER)
    await plugin.dispose()
  })

  it('fails loud when toolCatalog is configured without the patched machine-policy fork', () => {
    const h = harness()
    const catalogConfig: Config = {
      ...config,
      toolCatalog: validToolCatalog(),
    }
    const withoutFork = { ...h.ctx, approval: undefined } as unknown as Context
    expect(() => installApproveForMe(withoutFork, catalogConfig, { toolFamilyActionProjectors: catalogProjectors })).toThrow(/patched @deepseek-ai\/dsh-user-approval/)
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

  it('keeps the machine policy unarmed and rolls back the provider when hook mounting fails', async () => {
    const h = harness()
    const originalOn = h.ctx.on.bind(h.ctx)
    h.ctx.on = ((event: CtxEvent | 'llm/adapters-updated', listener: (...args: unknown[]) => unknown) => {
      if (event === 'tools/result') throw new Error('hook mount failed')
      return originalOn(event, listener)
    })

    expect(() => installApproveForMe(h.ctx as unknown as Context, config)).toThrow(/hook mount failed/)
    expect(h.machinePolicy).toBeUndefined()
    await vi.waitFor(() => expect(h.disposeRegistration).toHaveBeenCalledOnce())
  })

  it('keeps later topology reconciles dormant after a retirement failure', async () => {
    const h = harness()
    const registerProvider = vi.spyOn(h.ctx.managedAgents, 'registerProvider')
    h.disposeRegistration.mockRejectedValue(new Error('managed provider retirement failed'))
    await approveForMe.apply(h.ctx as unknown as Context, config)
    expect(registerProvider).toHaveBeenCalledOnce()

    h.listeners.topology?.()
    expect(h.machinePolicy).toBeUndefined()
    await vi.waitFor(() => expect(h.ctx.logger.error).toHaveBeenCalled())

    h.listeners.topology?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.machinePolicy).toBeUndefined()
    expect(registerProvider).toHaveBeenCalledOnce()
  })

  it('does not settle loader reconciliation before post-registration rollback finishes', async () => {
    const h = harness()
    const registerProvider = h.ctx.managedAgents.registerProvider.bind(h.ctx.managedAgents)
    let releaseRollback!: () => void
    const rollbackBarrier = new Promise<void>(resolve => { releaseRollback = resolve })
    const rollbackDispose = vi.fn(() => rollbackBarrier)
    h.ctx.managedAgents.registerProvider = vi.fn(provider => ({
      ...registerProvider(provider),
      dispose: rollbackDispose,
    }))
    const originalOn = h.ctx.on.bind(h.ctx)
    h.ctx.on = ((event: CtxEvent | 'llm/adapters-updated', listener: (...args: unknown[]) => unknown) => {
      if (event === 'tools/result') throw new Error('post-registration mount failed')
      return originalOn(event, listener)
    })

    const applying = approveForMe.apply(h.ctx as unknown as Context, config)
    await vi.waitFor(() => expect(rollbackDispose).toHaveBeenCalledOnce())
    let settled = false
    void applying.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.machinePolicy).toBeUndefined()

    releaseRollback()
    await expect(applying).rejects.toThrow(/post-registration mount failed/)
  })

  it('disposes the old registration and can be remounted after unload', async () => {
    const first = harness()
    const plugin = installApproveForMe(first.ctx as unknown as Context, config)
    const firstDisposal = plugin.dispose()
    const secondDisposal = plugin.dispose()
    expect(secondDisposal).toBe(firstDisposal)
    await firstDisposal
    expect(first.disposeRegistration).toHaveBeenCalledOnce()
    expect(first.disposeMachinePolicy).toHaveBeenCalledOnce()

    const second = harness()
    const reloaded = installApproveForMe(second.ctx as unknown as Context, config)
    expect(second.registered?.name).toBe(REVIEWER_PROVIDER)
    await reloaded.dispose()
    expect(second.disposeRegistration).toHaveBeenCalledOnce()
  })
  it('orders observer fencing, abort, drains, provider release, and durable close', async () => {
    const h = harness(), order: string[] = []
    const ctx = h.ctx as any
    const on = ctx.on.bind(ctx); ctx.on = (event: string, listener: (...args: unknown[]) => unknown) => { on(event, listener); return () => { order.push('fence:' + event) } }
    const policy = ctx.approval.registerMachinePolicy.bind(ctx.approval); ctx.approval.registerMachinePolicy = (value: unknown) => { const dispose = policy(value); return () => { order.push('fence:policy'); dispose() } }
    const register = ctx.managedAgents.registerProvider.bind(ctx.managedAgents); ctx.managedAgents.registerProvider = (provider: ManagedAgentProvider) => { const registration = register(provider); return { ...registration, dispose: async () => { order.push('provider'); await registration.dispose() } } }
    const spy = (prototype: any, key: string, label: string) => { const original = prototype[key]; return vi.spyOn(prototype, key).mockImplementation(function (this: any, ...args: unknown[]) { order.push(label); return original.apply(this, args) }) }
    const spies = [spy(ApprovalRunLifecycle.prototype, 'dispose', 'abort'), spy(SerialLanes.prototype, 'drain', 'lanes'), spy(DshStorageDomainSealedFacts.prototype, 'drain', 'ledger'), spy(DshStorageDomainFactRepositories.prototype, 'drain', 'facts-close'), spy(DshStorageDomainGateDecisionRecordStore.prototype, 'drain', 'records-close')]
    try { await installApproveForMe(h.ctx as unknown as Context, config).dispose() } finally { spies.forEach(item => item.mockRestore()) }
    expect(order).toEqual(['fence:policy', 'fence:session/event', 'fence:tools/result', 'fence:tools/post-execute', 'fence:tools/pre-execute', 'abort', 'lanes', 'ledger', 'provider', 'facts-close', 'records-close'])
  })
})
