import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { StorageDomainFacility } from '../../src/dsh/storage-domain-decision-record.js'
import type { ManagedAgentProvider, ManagedProviderRegistration } from 'dsh-managed-agent'
import {
  REVIEWER_PROVIDER,
  EXTRACTION_PROVIDER,
  SUBMIT_DECISION_TOOL,
  SUBMIT_EXTRACTION_TOOL,
  DefaultExtractionChannel,
  DshStorageDomainAuthorizationLedger,
  AUTHORIZATION_EXTRACTOR_VERSION,
  createExtractorProviderData,
  createReviewerProviderData,
  fingerprintApprovalToolCatalogV1,
  createFilesystemActionProjector,
  createShellProcessActionProjector,
  createDshAlpha2StockToolCatalog,
  ToolFamilyActionProjectorRegistry,
  ApprovalRunLifecycle,
  DEFAULT_MAX_SEALED_HISTORY_WINDOW,
  DshStorageDomainFactRepositories,
  DshStorageDomainGateDecisionRecordStore,
  REASON_CODE_ROUTE_PATH,
  LEDGER_HEALTH_ROUTE_PATH,
  DshStorageDomainSealedFacts,
  SerialLanes,
  canonicalJson,
  createActionSnapshot,
  createToolExecutionFactRecordV2,
  hashAction,
  DSH_ALPHA2_SHELL_FAMILY,
  DSH_ALPHA2_SHELL_PROJECTOR_ID,
  SealBackfillRunner,
  installApproveForMe,
  parseApprovalReviewPacketV1,
  parseApprovalReviewPacketV2,
  parseApprovalReviewRequest,
} from '../../src/index.js'
import type { ApprovalSnapshotRecordV1, Config, SessionLifecycleIdentityV1, StorageDomainHandle, ToolExecutionFactRecordV2 } from '../../src/index.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import * as approveForMe from '../../src/index.js'
import { approvalE2ESchemas, buildApprovalE2EFixture, seedApprovalE2E } from '../helpers/approval-e2e.js'

type CtxEvent = 'tools/pre-execute' | 'tools/result' | 'session/event'

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
    storageDomain?: StorageDomainFacility
    agents?: { get(id: string): Agent | undefined }
    managedAgents: { registerProvider(provider: ManagedAgentProvider): ManagedProviderRegistration }
    approval: { registerMachinePolicy(policy: unknown): () => void }
    tools: { schemas(agent: unknown): readonly unknown[] }
    on(event: CtxEvent | 'llm/adapters-updated', listener: (...args: unknown[]) => unknown): () => void
    effect(setup: () => (() => void | Promise<void>), label?: string): unknown
    inject(services: readonly string[], listener: (ctx: unknown) => void): Promise<void>
    logger: { error(error: unknown): void }
    webServer?: { register(route: { kind: 'exact'; path: string; handler: unknown }): () => void }
    llm: {
      listProviders(): Array<{ id: string; name: string }>
      listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>>
      resolveModelInfo(provider: string, model: string): Promise<{ provider: string; id: string; name: string }>
    }
  }
  registered: ManagedAgentProvider | undefined
  extractorRegistered: ManagedAgentProvider | undefined
  registeredNames: string[]
  machinePolicy: unknown | undefined
  disposeMachinePolicy: ReturnType<typeof vi.fn>
  composition: { suppressions: number; restrictions: number; approvalNever: number; sandboxReadOnly: number; resultObservers: number }
  childTool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
  resultObserver: ((exec: unknown, result: unknown) => unknown) | undefined
  listeners: {
    preExecute: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    result: ((exec: unknown, result: unknown) => unknown) | undefined
    sessionEvent: ((session: unknown, event: unknown) => unknown) | undefined
    topology: (() => unknown) | undefined
  }
  delivered: ReturnType<typeof parseApprovalReviewRequest> | undefined
  deliveredPacket: { request: ReturnType<typeof parseApprovalReviewRequest>; dossier: unknown } | undefined
  disposeRegistration: ReturnType<typeof vi.fn>
  disposeExtractorRegistration: ReturnType<typeof vi.fn>
  webServerRoute: { kind: string; path: string; handler: unknown } | undefined
  /** WP8-b: every registered route keyed by path (reason-code + ledger-health). */
  webServerRoutes: ReadonlyMap<string, { kind: string; path: string; handler: unknown }>
  disposeWebServerRoute: ReturnType<typeof vi.fn>
  /** Per-route disposer spy (path-keyed), for unregister assertions. */
  disposeWebServerRouteFor: (path: string) => ReturnType<typeof vi.fn> | undefined
  extractionDelivered: { request: Record<string, unknown>; window: readonly { seq: number; text: string }[] } | undefined
}

interface ScopedCapture {
  childTool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
  resultObserver: ((exec: unknown, result: unknown) => unknown) | undefined
}

function harness(options: {
  schemas?: readonly unknown[]
  storageDomain?: StorageDomainFacility
  agents?: { get(id: string): Agent | undefined }
  /**
   * WP8-a: model the web GUI host's ctx.webServer. When true the ctx exposes a
   * stub register() that records the route and returns a spied disposer; when
   * absent (default) the ctx has no webServer at all (CLI profile).
   */
  webServer?: boolean
  /** Test hook: propose extractor submission entries for a delivered window. */
  proposeExtractionEntries?: (request: Record<string, unknown>, window: readonly { seq: number; text: string }[]) => readonly Record<string, unknown>[]
  /**
   * Model a session whose managed directory already lists an extractor child
   * (e.g. a previous approval created one): the idle no-op guard treats the
   * directory as the only valid childSession evidence.
   */
  existingExtractorChild?: boolean
} = {}): InstallHarness {
  const listeners: InstallHarness['listeners'] = {
    preExecute: undefined,
    result: undefined,
    sessionEvent: undefined,
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
  const disposeExtractorRegistration = vi.fn(async () => {})
  const disposeMachinePolicy = vi.fn(() => {})
  let registered: ManagedAgentProvider | undefined
  let extractorRegistered: ManagedAgentProvider | undefined
  const registeredNames: string[] = []
  let machinePolicy: unknown | undefined
  let childTool: InstallHarness['childTool']
  let resultObserver: InstallHarness['resultObserver']
  let delivered: ReturnType<typeof parseApprovalReviewRequest> | undefined
  let deliveredPacket: { request: ReturnType<typeof parseApprovalReviewRequest>; dossier: unknown } | undefined
  let extractionDelivered: InstallHarness['extractionDelivered']
  // WP8-a/WP8-b: webServer stub capture, keyed by route path so two exact
  // routes (reason-code + ledger-health) coexist without clobbering.
  const webServerRoutes = new Map<string, { kind: string; path: string; handler: unknown }>()
  const disposeWebServerRouteSpies = new Map<string, ReturnType<typeof vi.fn>>()
  // Materialize runs inside controller.create, so the scoped tool/observer must
  // be captured per provider: the Reviewer and the Extractor share the same
  // fake controller shape but register different scoped tools.
  const scopedByProvider = new Map<string, ScopedCapture>()
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
        registeredNames.push(provider.name)
        if (provider.name === REVIEWER_PROVIDER) registered = provider
        if (provider.name === EXTRACTION_PROVIDER) extractorRegistered = provider
        const childSessionId = provider.name === REVIEWER_PROVIDER ? 'reviewer-1' : 'extractor-1'
        const dispose = provider.name === REVIEWER_PROVIDER ? disposeRegistration : disposeExtractorRegistration
        // Materialize captures this provider's scoped tool/observer. A child
        // that already exists in the directory (existingExtractorChild) never
        // passes through create, so deliver materializes lazily -- mirroring a
        // real session whose scoped tool was registered at child startup.
        const materializeScoped = (): ScopedCapture => {
          let captured = scopedByProvider.get(provider.name)
          if (captured !== undefined) return captured
          const compositionResult = provider.materialize({
            source: 'startup',
            parentSessionId: SessionId('parent-1'),
            childSessionId: SessionId(childSessionId),
            descriptor: {
              version: 1,
              provider: provider.name,
              label: provider.name === REVIEWER_PROVIDER ? 'Reviewer' : 'Authorization Extractor',
              providerData: (provider.name === REVIEWER_PROVIDER
                ? createReviewerProviderData({
                    generation: 'reviewer-v1',
                    modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
                    policyVersion: 'policy-v1',
                    toolsetVersion: 1,
                  })
                : createExtractorProviderData({
                    generation: 'reviewer-v1',
                    modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
                    extractorVersion: AUTHORIZATION_EXTRACTOR_VERSION,
                  })) as never,
            },
          })
          captured = { childTool: undefined, resultObserver: undefined }
          compositionResult.setup?.({
                agent: child,
                systemPrompt: {
                  suppressRuntimeContext: () => { composition.suppressions += 1; return () => {} },
                  section: () => () => {},
                },
                tools: {
                  restrict: () => { composition.restrictions += 1; return () => {} },
                  register: (tool: unknown) => {
                    captured.childTool = tool as ScopedCapture['childTool']
                    childTool = captured.childTool
                    return () => {}
                  },
                },
                on: (event: string, listener: (...args: unknown[]) => unknown) => {
                  if (event === 'tools/result') {
                    composition.resultObservers += 1
                    captured.resultObserver = listener as ScopedCapture['resultObserver']
                    resultObserver = captured.resultObserver
                  }
                  return () => {}
                },
              } as never)
          scopedByProvider.set(provider.name, captured)
          return captured
        }
        return {
          controller: {
            async create(_parent: unknown, _options: { providerData?: unknown; label: string }) {
              materializeScoped()
              return SessionId(childSessionId)
            },
            async list() {
              if (options.existingExtractorChild && provider.name === EXTRACTION_PROVIDER) {
                return [{
                  id: SessionId('extractor-1'),
                  parentSessionId: SessionId('parent-1'),
                  provider: EXTRACTION_PROVIDER,
                  label: 'Authorization Extractor',
                  providerData: createExtractorProviderData({
                    generation: 'reviewer-v1',
                    modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
                    extractorVersion: AUTHORIZATION_EXTRACTOR_VERSION,
                  }),
                  deliveryAttempts: 0,
                  retired: false,
                  contaminated: false,
                }] as never
              }
              return []
            },
            async rotate() { return SessionId(childSessionId) },
            async renew() { return SessionId(childSessionId) },
            async deliver(_parent: unknown, _childId: unknown, content: readonly unknown[]) {
              const raw = (content[0] as { text: string } | undefined)?.text.split('\n').at(-1)
              if (raw === undefined) throw new Error('approval request was not delivered')
              const rawJson = JSON.parse(raw) as Record<string, unknown>
              if (provider.name === EXTRACTION_PROVIDER) {
                // Authorization extraction delivery: echo one structured
                // submission (entries proposed by the test hook, identity
                // fields verbatim from the delivered request) and run the real
                // two-phase scoped tool flow: execute stages, the child-scoped
                // tools/result observer submits with the ACTUAL extractor
                // Session id.
                const window = (rawJson.window as readonly { seq: number; text: string }[] | undefined) ?? []
                extractionDelivered = { request: rawJson, window }
                const scoped = materializeScoped()
                if (scoped.childTool === undefined) throw new Error('extraction tool was not materialized')
                const submission = {
                  protocolVersion: 1,
                  extractionId: rawJson.extractionId,
                  parentSessionId: rawJson.parentSessionId,
                  extractorSessionId: rawJson.extractorSessionId,
                  generation: rawJson.generation,
                  extractorVersion: rawJson.extractorVersion,
                  throughSeq: rawJson.throughSeq,
                  entries: options.proposeExtractionEntries?.(rawJson, window) ?? [],
                }
                const exec = {
                  callId: 'extract-call-1',
                  rootCallId: 'extract-call-1',
                  name: SUBMIT_EXTRACTION_TOOL,
                  arguments: submission,
                  agent: { id: childSessionId, session: { id: childSessionId } },
                  signal: new AbortController().signal,
                  token: Symbol('token'),
                  deferContext: () => {},
                  concludeTurn: () => {},
                }
                await scoped.childTool.execute(submission, exec)
                scoped.resultObserver?.(exec, { isError: false, value: { recorded: true }, content: [] })
                return MessageId('message-extract-1')
              }
              // Capture the raw packet so packet-level (dossier.interaction.sealed.excerpts)
              // assertions are possible on the real Reviewer deliver payload.
              let packet: { request: ReturnType<typeof parseApprovalReviewRequest>; dossier: unknown }
              try {
                const parsed = parseApprovalReviewPacketV2(rawJson)
                packet = { request: parsed.request, dossier: parsed.dossier }
              } catch {
                const parsed = parseApprovalReviewPacketV1(rawJson)
                packet = { request: parsed.request, dossier: parsed.dossier }
              }
              deliveredPacket = packet
              const request = packet.request
              delivered = request
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
          dispose,
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
    tools: { schemas: vi.fn(() => [...(options.schemas ?? [])]) },
    llm: {
      listProviders: vi.fn(() => [{ id: 'deepseek', name: 'DeepSeek' }]),
      listModels: vi.fn(async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
      resolveModelInfo: vi.fn(async () => ({ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' })),
    },
    on(event: CtxEvent | 'llm/adapters-updated', listener: (...args: unknown[]) => unknown) {
      if (event === 'tools/pre-execute') listeners.preExecute = listener as InstallHarness['listeners']['preExecute']
      if (event === 'tools/result') listeners.result = listener as InstallHarness['listeners']['result']
      if (event === 'session/event') listeners.sessionEvent = listener as InstallHarness['listeners']['sessionEvent']
      if (event === 'llm/adapters-updated') listeners.topology = listener as InstallHarness['listeners']['topology']
      return () => {}
    },
    effect(setup: () => (() => void | Promise<void>)) { return setup() },
    inject: vi.fn(async () => {}),
    logger: { error: vi.fn() },
    storageDomain: options.storageDomain,
    agents: options.agents,
    webServer: options.webServer === true
      ? {
          register(route: { kind: 'exact'; path: string; handler: unknown }) {
            webServerRoutes.set(route.path, route)
            const spy = vi.fn(() => {})
            disposeWebServerRouteSpies.set(route.path, spy)
            return spy
          },
        }
      : undefined,
  }
  return {
    ctx: ctx as unknown as InstallHarness['ctx'],
    get registered() { return registered },
    get extractorRegistered() { return extractorRegistered },
    get registeredNames() { return registeredNames },
    get machinePolicy() { return machinePolicy },
    disposeMachinePolicy,
    composition,
    get childTool() { return childTool },
    get resultObserver() { return resultObserver },
    listeners,
    disposeRegistration,
    disposeExtractorRegistration,
    get delivered() { return delivered },
    get deliveredPacket() { return deliveredPacket },
    get extractionDelivered() { return extractionDelivered },
    get webServerRoute() { return webServerRoutes.get(REASON_CODE_ROUTE_PATH) },
    get webServerRoutes() { return webServerRoutes },
    get disposeWebServerRoute() { return disposeWebServerRouteSpies.get(REASON_CODE_ROUTE_PATH)! },
    disposeWebServerRouteFor: (path: string) => disposeWebServerRouteSpies.get(path),
  }
}

describe('installApproveForMe composition root', () => {
  it('registers the managed Reviewer and retains capture hooks without an approval/request listener', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.registered?.name).toBe(REVIEWER_PROVIDER)
    expect(plugin.getDossierCompilationMetrics()).toMatchObject({ attempts: 0, overflowRate: 0 })
    expect(plugin.getReviewerTelemetryMetrics()).toMatchObject({ reviews: 0, fallbacks: 0, attempts: 0 })
    expect(plugin.getGateFailureMetrics()).toMatchObject({ total: 0, unavailable: 0, delegates: 0 })

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

  it('does not reject an oversized session and proves the approve hot path is zero full-snapshot (WP4-b4-2b S-4)', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    // An oversized (20001-event) live session whose approval ask sits inside the
    // bounded sealed-tail window. The remapped hot path must locate that ask via
    // exact eventAt reads only — never by materializing the full snapshot on the
    // decide path — and must still not throw the removed maxSourceEvents budget.
    const seqCount = 20_001
    const askedSeq = 20_000
    const eventAt = vi.fn((seq: number) => seq === askedSeq
      ? { type: 'approval/asked' as const, data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } }
      : undefined)
    const snapshotEvents = vi.fn(() => [])
    const parent = {
      id: 'parent-1',
      session: {
        id: 'parent-1',
        header: { id: 'parent-1', version: 1, createdAt: 100 },
        eventAt,
        seq: seqCount,
        snapshotEvents,
      },
    }
    const policy = h.machinePolicy as {
      decide(request: { agent: typeof parent; toolName: string; callId: string; requestId: string }): Promise<string>
    }
    await h.listeners.preExecute!({
      agent: parent,
      callId: 'call-1',
      name: 'bash',
      arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))
    // The capture/pre-execute step legitimately touches snapshotEvents (an
    // accepted, out-of-scope capture-path remnant). Clear it so a later call can
    // only represent the approval decide/pipeline segment.
    snapshotEvents.mockClear()

    await expect(policy.decide({ agent: parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('unavailable')

    // The approval hot path (resolveActionHash -> validateLiveApprovalBinding ->
    // resolver) never materializes the full session snapshot.
    expect(snapshotEvents).not.toHaveBeenCalled()
    // Every live read is an exact eventAt inside the bounded sealed-tail window,
    // so the locate cost stays O(maxSealedTailEvents) even at 20k events.
    const readSeqs = eventAt.mock.calls.map(call => call[0] as number)
    expect(readSeqs.length).toBeGreaterThan(0)
    expect(Math.max(...readSeqs)).toBeLessThan(seqCount)
    expect(Math.min(...readSeqs)).toBeGreaterThanOrEqual(seqCount - 512)

    await plugin.dispose()
  })

  it('fails closed when the approval ask lies outside the bounded sealed-tail window (guard mutation)', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    const seqCount = 20_001
    const eventAt = vi.fn((seq: number) => seq === 0
      ? { type: 'approval/asked' as const, data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } }
      : undefined)
    const parent = {
      id: 'parent-1',
      session: {
        id: 'parent-1',
        header: { id: 'parent-1', version: 1, createdAt: 100 },
        eventAt,
        seq: seqCount,
        snapshotEvents: vi.fn(() => []),
      },
    }
    const policy = h.machinePolicy as {
      decide(request: { agent: typeof parent; toolName: string; callId: string; requestId: string }): Promise<string>
    }
    await h.listeners.preExecute!({
      agent: parent, callId: 'call-1', name: 'bash', arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))
    parent.session.snapshotEvents.mockClear()

    await expect(policy.decide({ agent: parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('unavailable')
    // The guard never scanned beneath the sealed-tail window: a full-history
    // eventAt scan would have reached seq 0, found the (stale) ask, and reopened a
    // closed ask — this mutation is killed by the lower-bound assertion below.
    const readSeqs = eventAt.mock.calls.map(call => call[0] as number)
    expect(readSeqs.length).toBeGreaterThan(0)
    expect(Math.min(...readSeqs)).toBeGreaterThanOrEqual(seqCount - 512)
    await plugin.dispose()
  })

  it('fails closed on a duplicate matching approval ask within the bounded window (contract pin)', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    const seqCount = 20_001
    const eventAt = vi.fn((seq: number) => (seq === 20_000 || seq === 19_999)
      ? { type: 'approval/asked' as const, data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } }
      : undefined)
    const parent = {
      id: 'parent-1',
      session: {
        id: 'parent-1',
        header: { id: 'parent-1', version: 1, createdAt: 100 },
        eventAt,
        seq: seqCount,
        snapshotEvents: vi.fn(() => []),
      },
    }
    const policy = h.machinePolicy as {
      decide(request: { agent: typeof parent; toolName: string; callId: string; requestId: string }): Promise<string>
    }
    await h.listeners.preExecute!({
      agent: parent, callId: 'call-1', name: 'bash', arguments: { command: 'pwd' },
    }, async () => ({ kind: 'ask' }))

    // Two distinct but matching approval/asked events for one request are
    // ambiguous and must fail closed, never resolve to one of the competing asks.
    // This asserts the SYSTEM's final behavior: the bridge's resolveApprovalAskedSeq
    // in-window duplicate guard also fails closed, so this plugin-level test is NOT
    // the sole killer of a duplicate-tolerance mutation (the reader/bridge layer is).
    await expect(policy.decide({ agent: parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('unavailable')
    await plugin.dispose()
  })

  it('pins the sealed-tail window lower bound: inclusive at lower, strictly exclusive below (WP4-b4-2b S-2)', async () => {
    const seqCount = 20_001
    const lower = seqCount - DEFAULT_MAX_SEALED_HISTORY_WINDOW
    const askEvent = (seq: number) => ({ type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 1, step: 0 } })
    const resolveWithAsk = async (match: (seq: number) => unknown): Promise<{ outcome: string; readSeqs: number[] }> => {
      const h = harness()
      const plugin = installApproveForMe(h.ctx as unknown as Context, config)
      const eventAt = vi.fn((seq: number) => match(seq))
      const snapshotEvents = vi.fn(() => [])
      const parent = {
        id: 'parent-1',
        session: {
          id: 'parent-1',
          header: { id: 'parent-1', version: 1, createdAt: 100 },
          eventAt,
          seq: seqCount,
          snapshotEvents,
        },
      }
      const policy = h.machinePolicy as {
        decide(request: { agent: typeof parent; toolName: string; callId: string; requestId: string }): Promise<string>
      }
      await h.listeners.preExecute!({
        agent: parent, callId: 'call-1', name: 'bash', arguments: { command: 'pwd' },
      }, async () => ({ kind: 'ask' }))
      snapshotEvents.mockClear()
      const outcome = await policy.decide({ agent: parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })
      await plugin.dispose()
      return { outcome, readSeqs: eventAt.mock.calls.map(call => call[0] as number) }
    }

    // Exactly at the lower bound (inclusive): the guard scans seq lower, counts the
    // ask, and resolves (only a downstream closed state remains). If the bound were
    // exclusive the ask would be skipped and binding would fail closed at the guard.
    const atLower = await resolveWithAsk(seq => seq === lower ? askEvent(seq) : undefined)
    expect(atLower.outcome).toBe('unavailable')
    expect(atLower.readSeqs).toContain(lower)

    // One below the lower bound (strictly exclusive): the guard never scans it, so
    // the ask is out of window and binding fails closed (integrity). If the bound
    // were shifted down this seq would be read and the ask reopened.
    const belowLower = await resolveWithAsk(seq => seq === lower - 1 ? askEvent(seq) : undefined)
    expect(belowLower.outcome).toBe('unavailable')
    expect(belowLower.readSeqs).not.toContain(lower - 1)
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
    expect(registerProvider).toHaveBeenCalledTimes(2)

    h.listeners.topology?.()
    expect(h.machinePolicy).toBeUndefined()
    await vi.waitFor(() => expect(h.ctx.logger.error).toHaveBeenCalled())

    h.listeners.topology?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.machinePolicy).toBeUndefined()
    expect(registerProvider).toHaveBeenCalledTimes(2)
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
    const register = ctx.managedAgents.registerProvider.bind(ctx.managedAgents); ctx.managedAgents.registerProvider = (provider: ManagedAgentProvider) => { const registration = register(provider); return { ...registration, dispose: async () => { order.push(provider.name === REVIEWER_PROVIDER ? 'provider' : 'extractor-provider'); await registration.dispose() } } }
    const spy = (prototype: any, key: string, label: string) => { const original = prototype[key]; return vi.spyOn(prototype, key).mockImplementation(function (this: any, ...args: unknown[]) { order.push(label); return original.apply(this, args) }) }
    // WP7-c2b: the extraction channel closes before the lane drain (in-flight
    // extractions settle as 'disposed'), both drawers drain before the decision
    // channel and provider release, and the extractor unregisters after the
    // Reviewer. WP8-c: the seal-backfill runner disposes after the review
    // lanes; its own internal writer lane drains inside that step (second
    // 'lanes'), always before the sealed ledger closes underneath it.
    const spies = [spy(ApprovalRunLifecycle.prototype, 'dispose', 'abort'), spy(SealBackfillRunner.prototype, 'dispose', 'seal-backfill'), spy(DefaultExtractionChannel.prototype, 'dispose', 'extraction-channel'), spy(SerialLanes.prototype, 'drain', 'lanes'), spy(DshStorageDomainSealedFacts.prototype, 'drain', 'ledger'), spy(DshStorageDomainAuthorizationLedger.prototype, 'drain', 'authorization-ledger'), spy(DshStorageDomainFactRepositories.prototype, 'drain', 'facts-close'), spy(DshStorageDomainGateDecisionRecordStore.prototype, 'drain', 'records-close')]
    try { await installApproveForMe(h.ctx as unknown as Context, config).dispose() } finally { spies.forEach(item => item.mockRestore()) }
    expect(order).toEqual(['fence:policy', 'fence:session/event', 'fence:tools/result', 'fence:tools/post-execute', 'fence:tools/pre-execute', 'abort', 'extraction-channel', 'lanes', 'seal-backfill', 'lanes', 'ledger', 'authorization-ledger', 'provider', 'extractor-provider', 'facts-close', 'records-close'])
  })

describe('storage-domain approve e2e (WP4-c item 4/5)', () => {
  function e2eHarness(padEvents: number, options: { existingExtractorChild?: boolean } = {}) {
    const fixture = buildApprovalE2EFixture({ padEvents })
    const h = harness({
      schemas: [approvalE2ESchemas],
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
      ...(options.existingExtractorChild === undefined ? {} : { existingExtractorChild: options.existingExtractorChild }),
    })
    return { fixture, h }
  }

  it('lets a real plugin allow a real approval and carries sealed excerpts in the Reviewer packet (item 4)', async () => {
    const { fixture, h } = e2eHarness(0)
    await seedApprovalE2E(fixture)
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)

    // Live-session spies: snapshotEvents is used only by the capture/pre-execute
    // path (an accepted remnant); the decide segment must not re-materialize it.
    const session = fixture.parent.session as any
    const snapshotEvents = vi.fn(() => fixture.events)
    session.snapshotEvents = snapshotEvents
    const eventAtCalls: number[] = []
    session.eventAt = (seq: number) => { eventAtCalls.push(seq); return fixture.events[seq] }

    await h.listeners.preExecute!({
      agent: fixture.parent,
      callId: 'call-1',
      rootCallId: 'call-1',
      name: 'bash',
      arguments: { command: 'pwd', description: 'print the working directory' },
      signal: new AbortController().signal,
      token: Symbol('e2e'),
    } as never, async () => ({ kind: 'ask' } as never))

    // Capture path on a clean tree asserted above; clear so the decide segment
    // can only reflect full-history rematerialization (must be zero).
    snapshotEvents.mockClear()
    eventAtCalls.length = 0

    const policy = h.machinePolicy as { decide(request: { agent: typeof fixture.parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    fixture.appendCurrentAsk()
    const outcome = await policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })
    expect(outcome).toBe('allowed-once')

    // The decide / resolver hot path never materializes the full session snapshot.
    expect(snapshotEvents).not.toHaveBeenCalled()

    // The Reviewer packet was delivered with the sealed dossier excerpts channel.
    expect(h.deliveredPacket).toBeDefined()
    const excerpts = (h.deliveredPacket as any)?.dossier?.interaction?.sealed?.excerpts
    expect(excerpts).toBeDefined()
    // WP6 verbatim pin: the excerpt channel must carry the fixture user-message text
    // exactly (it is an intent aid, not a transformed summary), in seq order.
    expect(excerpts.map((entry: { text: string }) => entry.text)).toEqual([
      'list the workspace',
      'now print the working directory',
    ])

    // The Reviewer's explicit decision is committed as the allow outcome.
    await plugin.dispose()
  })

  it('keeps the >20k approve hot path bounded and still allows (item 5)', async () => {
    // The session's managed directory already lists an extractor child (a
    // prior approval created one), so the idle no-op guard treats extraction
    // as potentially effective and the idle trigger below actually runs.
    const { fixture, h } = e2eHarness(20_001, { existingExtractorChild: true })
    await seedApprovalE2E(fixture)
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)

    const session = fixture.parent.session as any
    const snapshotEvents = vi.fn(() => fixture.events)
    session.snapshotEvents = snapshotEvents
    const eventAtCalls: number[] = []
    session.eventAt = (seq: number) => { eventAtCalls.push(seq); return fixture.events[seq] }

    await h.listeners.preExecute!({
      agent: fixture.parent, callId: 'call-1', rootCallId: 'call-1', name: 'bash', arguments: { command: 'pwd', description: 'print the working directory' },
      signal: new AbortController().signal, token: Symbol('e2e'),
    } as never, async () => ({ kind: 'ask' } as never))
    snapshotEvents.mockClear()
    eventAtCalls.length = 0

    // WP7-c2b: the authorization extractor's first window on a mature session
    // scans the full history once (its deterministic collector walks
    // (checkpoint, throughSeq] via exact eventAt reads only -- never
    // snapshotEvents). Trigger that first idle extraction on the last root
    // user/message BEFORE the decide segment so the sync-tail catch-up inside
    // the approval stays incremental and the bounded-read pin below still
    // describes the decide segment exactly. Without directory evidence the
    // idle no-op guard would (correctly) refuse this first trigger.
    const userMessage = fixture.events.find(event => event.type === 'user/message')!
    h.listeners.sessionEvent!(fixture.parent.session, userMessage)
    await vi.waitFor(() => expect(h.extractionDelivered).toBeDefined())
    eventAtCalls.length = 0

    const policy = h.machinePolicy as { decide(request: { agent: typeof fixture.parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    fixture.appendCurrentAsk()
    const hotSeq = fixture.hotSeq
    const outcome = await policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })
    expect(outcome).toBe('allowed-once')
    expect(snapshotEvents).not.toHaveBeenCalled()

    // Every decide-path live read is an exact eventAt inside a bounded horizon.
    // Two bounded windows compose here: the ask-position scan anchors at
    // session.seq and now shares the sealed ledger gate default (256, WP6-b4), while
    // the recent-excerpt assembler keeps its own independent 512-event window at
    // the ask seq (which is session.seq - 1). The union is bounded by the wider
    // excerpt window: [session.seq - 512 - 1, session.seq) - never a full-history scan.
    // The extraction sync-tail catch-up reads only (checkpoint, askedSeq): after
    // the idle extraction above advanced the checkpoint past the last user/message,
    // that window is a handful of seqs inside the same horizon.
    expect(eventAtCalls.length).toBeGreaterThan(0)
    const lower = Math.max(0, hotSeq - 512 - 1)
    for (const seq of eventAtCalls) {
      expect(seq).toBeGreaterThanOrEqual(lower)
      expect(seq).toBeLessThan(hotSeq)
    }

    // The sealed dossier still carried excerpts (user messages are inside the window).
    const excerpts = (h.deliveredPacket as any)?.dossier?.interaction?.sealed?.excerpts
    expect(excerpts).toBeDefined()
    expect(excerpts.length).toBeGreaterThan(0)
    await plugin.dispose()
  })

  it('records a real source-backed unavailable reason code and reads it back (WP5-c)', async () => {
    const fixture = buildApprovalE2EFixture({ padEvents: 0 })
    // Deliberately do NOT seed a sealed ledger, so the sealed reader returns an
    // empty ledger -> the resolver throws `sealed-current-missing` (an
    // explainable unsealed current action) and the gate records a metadata-only
    // post-facts-failure row with that typed reason code.
    const h = harness({
      schemas: [approvalE2ESchemas],
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
    })
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    const session = fixture.parent.session as any
    session.snapshotEvents = vi.fn(() => fixture.events)
    session.eventAt = (seq: number) => fixture.events[seq]

    await h.listeners.preExecute!({
      agent: fixture.parent, callId: 'call-1', rootCallId: 'call-1', name: 'bash',
      arguments: { command: 'pwd', description: 'print the working directory' },
      signal: new AbortController().signal, token: Symbol('wp5c'),
    } as never, async () => ({ kind: 'ask' } as never))

    const policy = h.machinePolicy as { decide(request: { agent: typeof fixture.parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    fixture.appendCurrentAsk()
    // auto mode: an explainable missing seal stays unavailable (never delegated).
    await expect(policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('unavailable')

    // The server read-only channel resolves the typed reason code for the ask.
    await expect(plugin.readApprovalReasonCode('ask-1')).resolves.toBe('sealed-current-missing')

    await plugin.dispose()
  })
})

describe('WP8-a reason-code renderer transport route', () => {
  it('mounts and disposes without a webServer (CLI profile) and registers nothing', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.webServerRoute).toBeUndefined()
    await plugin.dispose()
    expect(h.disposeMachinePolicy).toHaveBeenCalled()
  })

  it('registers the exact reason-code route and unregisters it on dispose', async () => {
    const h = harness({ webServer: true })
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.webServerRoute?.kind).toBe('exact')
    expect(h.webServerRoute?.path).toBe(REASON_CODE_ROUTE_PATH)

    // The mounted handler answers through the domain-less records store: a
    // valid request degrades to the 200 miss body, never an error.
    const captured = { status: undefined as number | undefined, headers: undefined as Record<string, string> | undefined, body: undefined as string | undefined }
    const res = {
      writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.headers = headers },
      end(body?: string) { captured.body = body },
    }
    await (h.webServerRoute!.handler as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', url: `${REASON_CODE_ROUTE_PATH}?requestId=ask-1` }, res)
    expect(captured.status).toBe(200)
    expect(captured.headers?.['Cache-Control']).toBe('no-store')
    expect(JSON.parse(captured.body!)).toEqual({ version: 1 })

    await plugin.dispose()
    expect(h.disposeWebServerRoute).toHaveBeenCalledOnce()
  })

  it('a failing webServer registration never fails the mount', async () => {
    const h = harness({ webServer: true })
    const ctx = h.ctx as unknown as { webServer: { register(): () => void } }
    ctx.webServer.register = () => { throw new Error('route table frozen') }
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.webServerRoute).toBeUndefined()
    await plugin.dispose()
  })

  // Regression for the 2026-09-06 live incident: on a real Cordis context,
  // plain property access to a non-injected service throws
  // 'cannot get property "<name>" without inject'. Optional capabilities must
  // be discovered through ctx.get — model that contract with a Proxy that
  // throws on webServer/storageDomain property access.
  it('probes optional services via ctx.get on a Cordis-faithful context (property access throws)', async () => {
    const h = harness({ webServer: true })
    const inner = h.ctx as unknown as Record<string | symbol, unknown>
    const cordisLike = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'get') return (name: string) => target[name]
        if (prop === 'webServer' || prop === 'storageDomain') {
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const plugin = installApproveForMe(cordisLike as unknown as Context, config)
    expect(h.webServerRoute?.kind).toBe('exact')
    expect(h.webServerRoute?.path).toBe(REASON_CODE_ROUTE_PATH)
    expect(h.webServerRoutes.get(LEDGER_HEALTH_ROUTE_PATH)?.path).toBe(LEDGER_HEALTH_ROUTE_PATH)
    await plugin.dispose()
    expect(h.disposeWebServerRoute).toHaveBeenCalledOnce()
  })
})

describe('WP8-b ledger-health route', () => {
  it('registers both presentational routes and serves a degraded body without storage', async () => {
    const h = harness({ webServer: true })
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    const route = h.webServerRoutes.get(LEDGER_HEALTH_ROUTE_PATH)
    expect(route?.kind).toBe('exact')
    expect(h.webServerRoutes.get(REASON_CODE_ROUTE_PATH)?.kind).toBe('exact')

    // No storageDomain in this ctx: both segments must be omitted (never a
    // false/available field) and the body stays inside the closed set.
    const captured = { status: undefined as number | undefined, headers: undefined as Record<string, string> | undefined, body: undefined as string | undefined }
    const res = {
      writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.headers = headers },
      end(body?: string) { captured.body = body },
    }
    await (route!.handler as (req: unknown, res: unknown) => Promise<void>)({ method: 'GET' }, res)
    expect(captured.status).toBe(200)
    expect(captured.headers?.['Cache-Control']).toBe('no-store')
    const parsed = JSON.parse(captured.body!) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['generatedAt', 'version'])
    expect(parsed.version).toBe(1)
    expect(typeof parsed.generatedAt).toBe('number')
    expect(parsed.generatedAt as number).toBeGreaterThan(0)

    await plugin.dispose()
    expect(h.disposeWebServerRouteFor(LEDGER_HEALTH_ROUTE_PATH)).toHaveBeenCalledOnce()
    expect(h.disposeWebServerRoute).toHaveBeenCalledOnce()
  })

  it('405s a non-GET method on the ledger-health route', async () => {
    const h = harness({ webServer: true })
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    const route = h.webServerRoutes.get(LEDGER_HEALTH_ROUTE_PATH)!
    const captured = { status: undefined as number | undefined, body: undefined as string | undefined }
    const res = {
      writeHead(status: number) { captured.status = status },
      end(body?: string) { captured.body = body },
    }
    await (route.handler as (req: unknown, res: unknown) => Promise<void>)({ method: 'POST' }, res)
    expect(captured.status).toBe(405)
    expect(JSON.parse(captured.body!)).toEqual({ version: 1, error: 'bad-request' })
    await plugin.dispose()
  })

  it('mounts and disposes without a webServer (CLI profile) and registers nothing', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, config)
    expect(h.webServerRoutes.size).toBe(0)
    await plugin.dispose()
    expect(h.disposeMachinePolicy).toHaveBeenCalled()
  })
})

describe('WP8-c seal backfill wiring', () => {
  const backfillConfig: Config = { ...config, toolCatalog: validToolCatalog(), sealBackfill: true }

  const backfillLogLines = (h: InstallHarness): string[] =>
    (h.ctx.logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(call => String((call[0] as Error)?.message ?? call[0]))
      .filter(line => line.includes('seal-backfill'))

  const settle = (ms = 30) => new Promise<void>(resolve => setTimeout(resolve, ms))

  /**
   * Seed one approval-bound execution fact + snapshot that the live pipeline
   * never sealed (as if capture predated the ledger) and extend the fixture
   * session with the ask/result/turn-end live events the backfill re-binds.
   */
  const seedUnsealedExecution = async (fixture: ReturnType<typeof buildApprovalE2EFixture>) => {
    const effective = createDshAlpha2EffectiveCatalog([approvalE2ESchemas])
    const dossier = effective.dossier
    const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, [approvalE2ESchemas])
    const descriptor = dossier.descriptors.find(item => item.toolName === 'bash')!
    const command = 'pwd'
    const action = createActionSnapshot({
      toolName: 'bash',
      arguments: { command, description: 'print the working directory' },
      projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
      semantics: {
        family: DSH_ALPHA2_SHELL_FAMILY,
        value: { operation: 'bash', command, description: 'print the working directory', cwd: '/workspace', runInBackground: false },
      },
      requestedPermissions: [],
    })
    const requestEventSeq = fixture.requestEventSeq
    const askedSeq = fixture.askedSeq
    const resultEventSeq = askedSeq + 1
    const record: ToolExecutionFactRecordV2 = createToolExecutionFactRecordV2({
      session: fixture.lifecycle,
      request: { kind: 'model-tool-call', eventSeq: requestEventSeq, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      catalogCommitment: commitment,
      toolClassification: { classificationCatalogFingerprint: dossier.fingerprint, descriptor },
      projection: { projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID, action, observedAt: 100 + requestEventSeq },
      result: { eventSeq: resultEventSeq, eventType: 'tool/result', outcome: { kind: 'completed' } },
    })
    const snapshot: ApprovalSnapshotRecordV1 = {
      version: 1,
      session: fixture.lifecycle,
      approvalRequestId: 'ask-1',
      approvalAskedSeq: askedSeq,
      execution: {
        requestEventSeq,
        callId: 'call-1',
        toolName: 'bash',
        actionHash: hashAction(action),
        classificationCatalogFingerprint: dossier.fingerprint,
        projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
      },
      environment: { version: 1, kind: 'native-header-only' },
    }
    const facts = new DshStorageDomainFactRepositories(fixture.storageDomain)
    expect(await facts.create(record)).toBe('created')
    expect(await facts.createApproval(snapshot)).toBe('created')
    fixture.appendCurrentAsk()
    fixture.events.push({ seq: resultEventSeq, time: 100 + resultEventSeq, type: 'tool/result', sourceEventSeqs: [requestEventSeq], data: {} })
    const turnEndSeq = resultEventSeq + 1
    fixture.events.push({ seq: turnEndSeq, time: 100 + turnEndSeq, type: 'turn/end', data: {} })
    return { requestEventSeq, resultEventSeq, turnEndSeq }
  }

  it('never triggers when sealBackfill is off', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, { ...config, toolCatalog: validToolCatalog() }, { toolFamilyActionProjectors: catalogProjectors })
    const session = { id: 'parent-1', header: { id: 'parent-1', version: 1, createdAt: 100 }, eventAt: () => undefined }
    h.listeners.sessionEvent!(session, { seq: 0, type: 'turn/end', time: 1, data: {} })
    await settle()
    expect(backfillLogLines(h)).toHaveLength(0)
    await plugin.dispose()
  })

  it('turn/end backfills an unsealed approval-bound fact once and links it to the validated tip', async () => {
    const fixture = buildApprovalE2EFixture()
    const seeded = await seedUnsealedExecution(fixture)
    await seedApprovalE2E(fixture)
    const h = harness({ storageDomain: fixture.storageDomain, agents: { get: () => fixture.parent } })
    const plugin = installApproveForMe(h.ctx as unknown as Context, backfillConfig, { toolFamilyActionProjectors: catalogProjectors })
    h.listeners.sessionEvent!(fixture.parent.session, { seq: seeded.turnEndSeq, time: 100 + seeded.turnEndSeq, type: 'turn/end', data: {} })
    const fingerprint = canonicalJson(fixture.lifecycle)
    await vi.waitFor(async () => {
      const rows = await fixture.sealedReader.read(fingerprint)
      expect(rows?.length).toBe(2)
    }, { timeout: 2000 })
    const rows = (await fixture.sealedReader.read(fingerprint))!
    expect(rows[0]!.seal.sourceSeq).toBe(3) // seeded historical row (call-past)
    expect(rows[1]!.seal).toMatchObject({
      sourceSeq: seeded.requestEventSeq,
      request: { eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      approvalAsked: { requestId: 'ask-1' },
      result: { eventSeq: seeded.resultEventSeq, status: 'completed' },
      catalog: { epoch: 0 },
    })
    expect(rows[1]!.seal.previousSealHash).toBe(rows[0]!.seal.sealHash)
    // occurredAt comes from the live result event, not from the record.
    expect(rows[1]!.activity.occurredAt).toBe(100 + seeded.resultEventSeq)
    // Once per lifecycle per process: a second turn/end never re-runs it.
    const linesBefore = backfillLogLines(h).length
    h.listeners.sessionEvent!(fixture.parent.session, { seq: seeded.turnEndSeq + 1, time: 100 + seeded.turnEndSeq + 1, type: 'turn/end', data: {} })
    await settle()
    expect(backfillLogLines(h)).toHaveLength(linesBefore)
    await plugin.dispose()
  })

  it('does not trigger while an approval run is in flight, and triggers once it settles', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, { ...config, sealBackfill: true })
    const policy = h.machinePolicy as { decide(request: unknown): Promise<string> }
    const parent = { id: 'parent-1', session: { id: 'parent-1' } }
    const session = { id: 'parent-1', header: { id: 'parent-1', version: 1, createdAt: 100 }, eventAt: () => undefined }
    const deciding = policy.decide({ agent: parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })
    // The policy wrapper holds the in-flight count synchronously from the call;
    // a turn/end inside that window must not start a backfill.
    h.listeners.sessionEvent!(session, { seq: 0, type: 'turn/end', time: 1, data: {} })
    await settle()
    expect(backfillLogLines(h)).toHaveLength(0)
    await deciding
    // No storageDomain here: the attempt starts and stops as
    // executions-unavailable, which still proves exactly one trigger.
    h.listeners.sessionEvent!(session, { seq: 1, type: 'turn/end', time: 2, data: {} })
    await vi.waitFor(() => expect(backfillLogLines(h).length).toBe(1), { timeout: 2000 })
    await plugin.dispose()
  })

  it('a new approval run aborts the queued backfill before it writes anything', async () => {
    const fixture = buildApprovalE2EFixture()
    const seeded = await seedUnsealedExecution(fixture)
    await seedApprovalE2E(fixture)
    const h = harness({ storageDomain: fixture.storageDomain, agents: { get: () => fixture.parent } })
    const plugin = installApproveForMe(h.ctx as unknown as Context, backfillConfig, { toolFamilyActionProjectors: catalogProjectors })
    h.listeners.sessionEvent!(fixture.parent.session, { seq: seeded.turnEndSeq, time: 100 + seeded.turnEndSeq, type: 'turn/end', data: {} })
    // Synchronously start an approval run on the same session lifecycle: the
    // policy wrapper aborts the backfill before its first lane step, so no
    // seal can be promoted while the session is asking again.
    const policy = h.machinePolicy as { decide(request: unknown): Promise<string> }
    await policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })
    await vi.waitFor(() => expect(backfillLogLines(h).some(line => line.includes('aborted'))).toBe(true), { timeout: 2000 })
    const rows = await fixture.sealedReader.read(canonicalJson(fixture.lifecycle))
    expect(rows?.length).toBe(1) // only the seeded historical row
    await plugin.dispose()
  })

  it('never triggers for managed child session events (parentSession recursion guard)', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx as unknown as Context, { ...config, sealBackfill: true })
    const childSession = {
      id: 'child-1',
      header: { id: 'child-1', version: 1, createdAt: 100, parentSession: 'parent-1' },
      eventAt: () => undefined,
    }
    h.listeners.sessionEvent!(childSession, { seq: 0, type: 'turn/end', time: 1, data: {} })
    await settle()
    expect(backfillLogLines(h)).toHaveLength(0)
    await plugin.dispose()
  })
})
})

describe('WP9-b fact retention sweep', () => {
  /** Storage Domain fake with per-table maps, a delete-order log, and an injectable delete failure. */
  function sweepStorage() {
    const tables = new Map<string, Map<string, unknown>>()
    const deleteCalls: { table: string; key: string }[] = []
    let failOnDeleteCall = -1
    const facility = {
      open: async (): Promise<StorageDomainHandle> => ({
        table(name: string) {
          const rows = tables.get(name) ?? new Map<string, unknown>()
          tables.set(name, rows)
          return {
            get: (key: string) => rows.get(key),
            put: async (key: string, value: unknown) => { rows.set(key, value) },
            delete: async (key: string) => {
              const callIndex = deleteCalls.length
              deleteCalls.push({ table: name, key })
              // Persistent from the nth call on: every re-sweep of the oldest
              // lifecycle keeps failing, so the sweep must keep stopping.
              if (failOnDeleteCall >= 0 && callIndex >= failOnDeleteCall) throw new Error('storage down')
              rows.delete(key)
            },
          }
        },
        close: async () => {},
      }),
    } as StorageDomainFacility
    return {
      facility,
      tables,
      deleteCalls,
      /** Make the (0-based) nth and every later delete call throw. */
      failOnDeleteCall(index: number) { failOnDeleteCall = index },
    }
  }

  const lifecycleOf = (id: string): SessionLifecycleIdentityV1 =>
    ({ sessionId: id, sessionFormatVersion: 1, createdAt: 100, cwd: '/workspace' })
  const sessionOf = (id: string) =>
    ({ id, header: { id, version: 1, createdAt: 100, cwd: '/workspace' }, eventAt: () => undefined })

  /** Seed one fully settled execution fact (terminal evidence + result). */
  async function seedSettled(facility: StorageDomainFacility, lifecycle: SessionLifecycleIdentityV1) {
    const effective = createDshAlpha2EffectiveCatalog([approvalE2ESchemas])
    const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, [approvalE2ESchemas])
    const action = createActionSnapshot({
      toolName: 'bash',
      arguments: { command: 'pwd' },
      projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
      semantics: {
        family: DSH_ALPHA2_SHELL_FAMILY,
        value: { operation: 'bash', command: 'pwd', description: 'print the working directory', cwd: '/workspace', runInBackground: false },
      },
      requestedPermissions: [],
    })
    const facts = new DshStorageDomainFactRepositories(facility)
    const record = createToolExecutionFactRecordV2({
      session: lifecycle,
      request: { kind: 'model-tool-call', eventSeq: 3, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      catalogCommitment: commitment,
      toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors.find(item => item.toolName === 'bash')! },
      projection: { projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID, action, observedAt: 103 },
      terminalEvidence: { isError: false, outcome: { kind: 'completed' } },
      result: { eventSeq: 4, eventType: 'tool/result', outcome: { kind: 'completed' } },
    })
    expect(await facts.create(record)).toBe('created')
    return facts
  }

  const getFact = (facts: DshStorageDomainFactRepositories, lifecycle: SessionLifecycleIdentityV1) =>
    facts.get({ session: lifecycle, callId: 'call-1', requestEventSeq: 3 })

  const sweepConfig = (overrides: Record<string, unknown> = {}) => ({
    ...config,
    toolCatalog: validToolCatalog(),
    factRetentionGraceMs: 1_000,
    factRetentionSweepLimit: 2,
    ...overrides,
  })

  const endLifecycle = (h: InstallHarness, id: string, endedAt: number) => {
    h.listeners.sessionEvent!(sessionOf(id), { seq: 0, type: 'user/message', time: endedAt - 500, data: {} })
    h.listeners.sessionEvent!(sessionOf(id), { seq: 1, type: 'turn/end', time: endedAt, data: {} })
  }

  it('turn/end sweep prunes the oldest ended lifecycles up to the sweep limit', async () => {
    const storage = sweepStorage()
    const a = lifecycleOf('session-a')
    const b = lifecycleOf('session-b')
    const c = lifecycleOf('session-c')
    const factsA = await seedSettled(storage.facility, a)
    const factsB = await seedSettled(storage.facility, b)
    const factsC = await seedSettled(storage.facility, c)
    const h = harness({ storageDomain: storage.facility, agents: { get: () => undefined } })
    const plugin = installApproveForMe(h.ctx as unknown as Context, sweepConfig(), { toolFamilyActionProjectors: catalogProjectors })
    const now = Date.now()
    endLifecycle(h, 'session-c', now - 60 * 60_000)
    endLifecycle(h, 'session-a', now - 3 * 60 * 60_000)
    endLifecycle(h, 'session-b', now - 2 * 60 * 60_000)
    // Oldest first within the limit of 2: a and b go, c stays.
    await vi.waitFor(async () => {
      expect(await getFact(factsA, a)).toBeUndefined()
      expect(await getFact(factsB, b)).toBeUndefined()
    }, { timeout: 2000 })
    expect(await getFact(factsC, c)).toBeDefined()
    // The executions table holds exactly c's record + index row.
    expect(storage.tables.get('executions')!.size).toBe(2)
    await plugin.dispose()
  })

  it('a mid-sweep storage failure stops the sweep, keeps later lifecycles, and never throws', async () => {
    const storage = sweepStorage()
    const a = lifecycleOf('session-a')
    const b = lifecycleOf('session-b')
    const factsA = await seedSettled(storage.facility, a)
    const factsB = await seedSettled(storage.facility, b)
    // session-a prunes first (oldest): record delete ok, its index delete (call 1) fails.
    storage.failOnDeleteCall(1)
    const h = harness({ storageDomain: storage.facility, agents: { get: () => undefined } })
    const plugin = installApproveForMe(h.ctx as unknown as Context, sweepConfig(), { toolFamilyActionProjectors: catalogProjectors })
    const now = Date.now()
    endLifecycle(h, 'session-a', now - 3 * 60 * 60_000)
    endLifecycle(h, 'session-b', now - 2 * 60 * 60_000)
    // The failure still removed session-a's record; the sweep then stopped
    // before touching session-b.
    await vi.waitFor(async () => {
      expect(await getFact(factsA, a)).toBeUndefined()
    }, { timeout: 2000 })
    expect(await getFact(factsB, b)).toBeDefined()
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    expect(await getFact(factsB, b)).toBeDefined()
    // Disposal fences the sweep lane and resolves cleanly.
    await expect(plugin.dispose()).resolves.toBeUndefined()
  })

  it('never prunes a lifecycle whose agent is still live', async () => {
    const storage = sweepStorage()
    const live = lifecycleOf('session-live')
    const dead = lifecycleOf('session-dead')
    const factsLive = await seedSettled(storage.facility, live)
    const factsDead = await seedSettled(storage.facility, dead)
    const h = harness({
      storageDomain: storage.facility,
      agents: { get: id => (id === 'session-live' ? {} as never : undefined) },
    })
    const plugin = installApproveForMe(h.ctx as unknown as Context, sweepConfig(), { toolFamilyActionProjectors: catalogProjectors })
    const now = Date.now()
    endLifecycle(h, 'session-live', now - 3 * 60 * 60_000)
    endLifecycle(h, 'session-dead', now - 2 * 60 * 60_000)
    // The dead lifecycle proves the sweep ran to completion; the live one
    // must be untouched.
    await vi.waitFor(async () => {
      expect(await getFact(factsDead, dead)).toBeUndefined()
    }, { timeout: 2000 })
    expect(await getFact(factsLive, live)).toBeDefined()
    await plugin.dispose()
  })

  it('revokes the end marker when the lifecycle shows activity again', async () => {
    const storage = sweepStorage()
    const revived = lifecycleOf('session-revived')
    const dead = lifecycleOf('session-dead')
    const factsRevived = await seedSettled(storage.facility, revived)
    const factsDead = await seedSettled(storage.facility, dead)
    const h = harness({ storageDomain: storage.facility, agents: { get: () => undefined } })
    const plugin = installApproveForMe(h.ctx as unknown as Context, sweepConfig(), { toolFamilyActionProjectors: catalogProjectors })
    const now = Date.now()
    endLifecycle(h, 'session-revived', now - 3 * 60 * 60_000)
    // Newer activity revokes the ended state before the sweep observes it.
    h.listeners.sessionEvent!(sessionOf('session-revived'), { seq: 2, type: 'user/message', time: now - 60_000, data: {} })
    endLifecycle(h, 'session-dead', now - 2 * 60 * 60_000)
    await vi.waitFor(async () => {
      expect(await getFact(factsDead, dead)).toBeUndefined()
    }, { timeout: 2000 })
    expect(await getFact(factsRevived, revived)).toBeDefined()
    await plugin.dispose()
  })
})
