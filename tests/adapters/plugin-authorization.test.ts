import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  installApproveForMe,
  parseApprovalReviewPacketV2,
  parseApprovalReviewPacketV1,
  parseApprovalReviewRequest,
} from '../../src/index.js'
import type { Config } from '../../src/index.js'
import { approvalE2ESchemas, buildApprovalE2EFixture, seedApprovalE2E } from '../helpers/approval-e2e.js'

/*
 * WP7-c2b plugin-level wiring tests: the authorization extractor provider, the
 * extraction channel, the private drawer, and the extraction coordinator are
 * composed in src/plugin.ts (brief decisions 5/6/7/9). The harness mirrors
 * tests/adapters/plugin.test.ts with two managed providers: the Reviewer and
 * the Extractor each get their own registration, controller, child session id
 * and scoped submit tool, and the session/event hook is observable.
 */

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

interface ExtractionDelivery {
  request: Record<string, unknown>
  window: readonly { seq: number; text: string }[]
}

interface Harness {
  ctx: Context
  registeredNames: string[]
  disposeRegistration: ReturnType<typeof vi.fn>
  disposeExtractorRegistration: ReturnType<typeof vi.fn>
  extractionDeliveries: ExtractionDelivery[]
  /** Provider names whose controller.create actually ran (child ensure). */
  createCalls: string[]
  reviewerDeliveries: number
  deliveredPacket: { request: ReturnType<typeof parseApprovalReviewRequest>; dossier: unknown } | undefined
  listeners: {
    preExecute: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    sessionEvent: ((session: unknown, event: unknown) => unknown) | undefined
  }
  machinePolicy: unknown | undefined
}

function harness(options: {
  storageDomain?: StorageDomainFacility
  agents?: { get(id: string): Agent | undefined }
  proposeExtractionEntries?: (request: Record<string, unknown>, window: readonly { seq: number; text: string }[]) => readonly Record<string, unknown>[]
} = {}): Harness {
  const listeners: Harness['listeners'] = { preExecute: undefined, sessionEvent: undefined }
  const registeredNames: string[] = []
  const disposeRegistration = vi.fn(async () => {})
  const disposeExtractorRegistration = vi.fn(async () => {})
  const extractionDeliveries: ExtractionDelivery[] = []
  const createCalls: string[] = []
  let reviewerDeliveries = 0
  let deliveredPacket: Harness['deliveredPacket']
  let machinePolicy: unknown | undefined
  const scoped = new Map<string, { childTool?: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }; resultObserver?: (exec: unknown, result: unknown) => unknown }>()
  const child: { id: string; session: { id: string; append: (type: string, data: unknown) => void } } = {
    id: 'reviewer-1',
    session: {
      id: 'reviewer-1',
      append: () => {},
    },
  }
  const ctx = {
    managedAgents: {
      registerProvider(provider: ManagedAgentProvider): ManagedProviderRegistration {
        registeredNames.push(provider.name)
        const childSessionId = provider.name === REVIEWER_PROVIDER ? 'reviewer-1' : 'extractor-1'
        const dispose = provider.name === REVIEWER_PROVIDER ? disposeRegistration : disposeExtractorRegistration
        return {
          controller: {
            async create(_parent: unknown, createOptions: { providerData?: unknown; label: string }) {
              createCalls.push(provider.name)
              const composition = provider.materialize({
                source: 'startup',
                parentSessionId: SessionId('parent-1'),
                childSessionId: SessionId(childSessionId),
                descriptor: {
                  version: 1,
                  provider: provider.name,
                  label: createOptions.label,
                  providerData: createOptions.providerData as never,
                },
              })
              const captured: { childTool?: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }; resultObserver?: (exec: unknown, result: unknown) => unknown } = {}
              composition.setup?.({
                agent: child,
                systemPrompt: {
                  suppressRuntimeContext: () => () => {},
                  section: () => () => {},
                },
                tools: {
                  restrict: () => () => {},
                  register: (tool: unknown) => {
                    captured.childTool = tool as { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }
                    return () => {}
                  },
                },
                on: (event: string, listener: (...args: unknown[]) => unknown) => {
                  if (event === 'tools/result') captured.resultObserver = listener as (exec: unknown, result: unknown) => unknown
                  return () => {}
                },
              } as never)
              scoped.set(provider.name, captured)
              return SessionId(childSessionId)
            },
            async list() { return [] },
            async rotate() { return SessionId(childSessionId) },
            async renew() { return SessionId(childSessionId) },
            async deliver(_parent: unknown, _childId: unknown, content: readonly unknown[]) {
              const raw = (content[0] as { text: string } | undefined)?.text.split('\n').at(-1)
              if (raw === undefined) throw new Error('managed delivery carried no text block')
              const rawJson = JSON.parse(raw) as Record<string, unknown>
              if (provider.name === EXTRACTION_PROVIDER) {
                const window = (rawJson.window as readonly { seq: number; text: string }[] | undefined) ?? []
                extractionDeliveries.push({ request: rawJson, window })
                const tool = scoped.get(provider.name)?.childTool
                if (tool === undefined) throw new Error('extraction tool was not materialized')
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
                await tool.execute(submission, exec)
                scoped.get(provider.name)?.resultObserver?.(exec, { isError: false, value: { recorded: true }, content: [] })
                return MessageId('message-extract-1')
              }
              let packet: { request: ReturnType<typeof parseApprovalReviewRequest>; dossier: unknown }
              try {
                const parsed = parseApprovalReviewPacketV2(rawJson)
                packet = { request: parsed.request, dossier: parsed.dossier }
              } catch {
                const parsed = parseApprovalReviewPacketV1(rawJson)
                packet = { request: parsed.request, dossier: parsed.dossier }
              }
              reviewerDeliveries += 1
              deliveredPacket = packet
              const tool = scoped.get(REVIEWER_PROVIDER)?.childTool
              if (tool === undefined) throw new Error('decision tool was not materialized')
              const exec = {
                callId: 'child-call-1',
                rootCallId: 'child-call-1',
                name: SUBMIT_DECISION_TOOL,
                arguments: decisionFor(packet.request),
                agent: { id: 'reviewer-1', session: { id: 'reviewer-1' } },
                signal: new AbortController().signal,
                token: Symbol('token'),
                deferContext: () => {},
                concludeTurn: () => {},
              }
              await tool.execute(exec.arguments, exec)
              scoped.get(REVIEWER_PROVIDER)?.resultObserver?.(exec, { isError: false, value: { recorded: true }, content: [] })
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
        return () => { machinePolicy = undefined }
      },
    },
    tools: { schemas: vi.fn(() => [approvalE2ESchemas]) },
    llm: {
      listProviders: vi.fn(() => [{ id: 'deepseek', name: 'DeepSeek' }]),
      listModels: vi.fn(async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
      resolveModelInfo: vi.fn(async () => ({ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' })),
    },
    on(event: 'tools/pre-execute' | 'tools/result' | 'session/event', listener: (...args: unknown[]) => unknown) {
      if (event === 'tools/pre-execute') listeners.preExecute = listener as Harness['listeners']['preExecute']
      if (event === 'session/event') listeners.sessionEvent = listener as Harness['listeners']['sessionEvent']
      return () => {}
    },
    logger: { error: vi.fn() },
    storageDomain: options.storageDomain,
    agents: options.agents,
  }
  return {
    ctx: ctx as unknown as Context,
    registeredNames,
    disposeRegistration,
    disposeExtractorRegistration,
    extractionDeliveries,
    createCalls,
    get reviewerDeliveries() { return reviewerDeliveries },
    get deliveredPacket() { return deliveredPacket },
    listeners,
    get machinePolicy() { return machinePolicy },
  }
}

/** Small settle helper: extraction is fire-and-forget through a serial lane. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('installApproveForMe authorization wiring (WP7-c2b)', () => {
  it('registers the Reviewer and the Extractor providers and unregisters both on an idempotent dispose', async () => {
    const h = harness()
    const plugin = installApproveForMe(h.ctx, config)
    expect(h.registeredNames).toEqual([REVIEWER_PROVIDER, EXTRACTION_PROVIDER])

    const disposal = plugin.dispose()
    expect(plugin.dispose()).toBe(disposal)
    await disposal
    expect(h.disposeRegistration).toHaveBeenCalledOnce()
    expect(h.disposeExtractorRegistration).toHaveBeenCalledOnce()
  })

  it('no-op guard: the first-ever root user/message on a session with no extractor child and no checkpoint wakes nothing', async () => {
    const fixture = buildApprovalE2EFixture({ padEvents: 0 })
    const h = harness({
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
    })
    const plugin = installApproveForMe(h.ctx, config)

    // Drawer rows only ever exist behind an extraction checkpoint, so there is
    // nothing incremental to extract here: the model must not be woken, no
    // child ensured, no channel armed.
    const userMessage = fixture.events.find(event => event.type === 'user/message')!
    h.listeners.sessionEvent!(fixture.parent.session, userMessage)
    await settle()
    expect(h.extractionDeliveries).toHaveLength(0)
    expect(h.createCalls).toEqual([])

    await plugin.dispose()
  })

  it('triggers exactly one incremental extraction per root user/message once the drawer exists, and skips the replayed checkpoint', async () => {
    const fixture = buildApprovalE2EFixture({ padEvents: 0 })
    await seedApprovalE2E(fixture)
    const h = harness({
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
    })
    const plugin = installApproveForMe(h.ctx, config)
    const session = fixture.parent.session as any
    session.snapshotEvents = vi.fn(() => fixture.events)
    session.eventAt = (seq: number) => fixture.events[seq]

    // The approval-time sync tail initializes the drawer (extractor child +
    // checkpoint through askedSeq - 1).
    await h.listeners.preExecute!({
      agent: fixture.parent, callId: 'call-1', rootCallId: 'call-1', name: 'bash',
      arguments: { command: 'pwd', description: 'print the working directory' },
      signal: new AbortController().signal, token: Symbol('wp7c2b-idle'),
    } as never, async () => ({ kind: 'ask' } as never))
    const policy = h.machinePolicy as { decide(request: { agent: typeof fixture.parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    fixture.appendCurrentAsk()
    await expect(policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('allowed-once')
    expect(h.createCalls).toContain(EXTRACTION_PROVIDER)

    // A later root user/message is incremental work: exactly one extraction
    // on top of the approval-time sync-tail delivery.
    expect(h.extractionDeliveries).toHaveLength(1)
    const followUp = {
      seq: fixture.events.length, time: 100 + fixture.events.length, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'please also show disk usage' }] },
    }
    fixture.events.push(followUp)
    h.listeners.sessionEvent!(fixture.parent.session, followUp)
    await vi.waitFor(() => expect(h.extractionDeliveries).toHaveLength(2))
    const delivery = h.extractionDeliveries[1]!
    expect(delivery.request.parentSessionId).toBe('parent-1')
    expect(delivery.request.extractorSessionId).toBe('extractor-1')
    expect(delivery.request.throughSeq).toBe(followUp.seq)
    expect(delivery.window.map(item => item.seq)).toEqual([followUp.seq])
    // The Reviewer delivered exactly once (the approval); idle runs never ask it.
    expect(h.reviewerDeliveries).toBe(1)

    // Replaying the same event is a checkpoint no-op: no second delivery.
    h.listeners.sessionEvent!(fixture.parent.session, followUp)
    await settle()
    expect(h.extractionDeliveries).toHaveLength(2)

    await plugin.dispose()
  })

  it('never triggers on managed child session events (recursion guard)', async () => {
    const fixture = buildApprovalE2EFixture({ padEvents: 0 })
    const childAgent = {
      id: 'extractor-1',
      session: {
        id: 'extractor-1',
        header: { id: 'extractor-1', parentSession: 'parent-1', version: 0, createdAt: 100 },
        eventAt: () => undefined,
      },
    } as unknown as Agent
    const h = harness({
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'extractor-1' ? childAgent : undefined },
    })
    const plugin = installApproveForMe(h.ctx, config)

    h.listeners.sessionEvent!(childAgent.session, {
      seq: 1, time: 101, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'forward this to the extractor' }] },
    })
    await settle()
    expect(h.extractionDeliveries).toHaveLength(0)
    await plugin.dispose()
  })

  it('keeps the idle trigger dark when disabled but still sync-tails the drawer at approval time, branding the sealed dossier', async () => {
    const fixture = buildApprovalE2EFixture({ padEvents: 0 })
    await seedApprovalE2E(fixture)
    const h = harness({
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
      proposeExtractionEntries: (_request, window) => window
        .filter(item => item.text === 'now print the working directory')
        .map(item => ({
          sourceSeq: item.seq,
          quote: 'now print the working directory',
          effect: 'grant',
          coverage: 'turn',
          summary: 'user asked to print the working directory',
        })),
    })
    const plugin = installApproveForMe(h.ctx, { ...config, authorizationExtractor: { enabled: false } })

    // Idle trigger: disabled -> a root user/message event wakes nothing.
    const userMessage = fixture.events.find(event => event.type === 'user/message')!
    h.listeners.sessionEvent!(fixture.parent.session, userMessage)
    await settle()
    expect(h.extractionDeliveries).toHaveLength(0)

    const session = fixture.parent.session as any
    session.snapshotEvents = vi.fn(() => fixture.events)
    session.eventAt = (seq: number) => fixture.events[seq]

    await h.listeners.preExecute!({
      agent: fixture.parent, callId: 'call-1', rootCallId: 'call-1', name: 'bash',
      arguments: { command: 'pwd', description: 'print the working directory' },
      signal: new AbortController().signal, token: Symbol('wp7c2b'),
    } as never, async () => ({ kind: 'ask' } as never))

    const policy = h.machinePolicy as { decide(request: { agent: typeof fixture.parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    fixture.appendCurrentAsk()
    // The sync-tail catch-up runs even with the idle extractor disabled (§5):
    // the extraction is delivered during the decide, before the sealed read.
    await expect(policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('allowed-once')
    expect(h.extractionDeliveries).toHaveLength(1)

    // End-to-end drawer branding: the entry written by the sync-tail extraction
    // survived Host verification and the live re-bind of the sealed read.
    const authorizations = (h.deliveredPacket as any)?.dossier?.interaction?.sealed?.authorizations
    expect(authorizations).toBeDefined()
    const target = fixture.events.find(event => event.type === 'user/message'
      && (event.data as { content: readonly { text: string }[] }).content[0]!.text === 'now print the working directory')!
    expect(authorizations).toContainEqual(expect.objectContaining({
      sourceSeq: target.seq,
      occurredAt: target.time,
      effect: 'grant',
      coverage: 'turn',
      quote: 'now print the working directory',
    }))

    await plugin.dispose()
  })

  it('brands exactly the end-of-window authorization statement into the dossier of a >256-event mature session', async () => {
    // Mature session: 1000 pad events (>256) and two earlier task-only user
    // messages. The newest user/message -- at the end of the extraction
    // window -- is a real standing authorization statement; the extractor
    // proposes ONLY that statement, and the branded dossier must carry
    // exactly that row and nothing from the older messages.
    const fixture = buildApprovalE2EFixture({ padEvents: 1000 })
    await seedApprovalE2E(fixture)
    const statement = 'You are authorized to run pwd in /workspace for the rest of this session.'
    const h = harness({
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
      proposeExtractionEntries: (_request, window) => window
        .filter(item => item.text === statement)
        .map(item => ({
          sourceSeq: item.seq,
          quote: item.text,
          effect: 'grant',
          coverage: 'session',
          summary: 'standing authorization to run pwd in /workspace',
        })),
    })
    const plugin = installApproveForMe(h.ctx, config)
    const session = fixture.parent.session as any
    session.snapshotEvents = vi.fn(() => fixture.events)
    session.eventAt = (seq: number) => fixture.events[seq]

    await h.listeners.preExecute!({
      agent: fixture.parent, callId: 'call-1', rootCallId: 'call-1', name: 'bash',
      arguments: { command: 'pwd', description: 'print the working directory' },
      signal: new AbortController().signal, token: Symbol('wp7c2b-mature'),
    } as never, async () => ({ kind: 'ask' } as never))

    // Append the authorization statement as the NEWEST event, then the ask
    // one seq later (appendCurrentAsk is bypassed because the statement
    // intentionally sits between the tool call and the ask).
    const statementSeq = fixture.askedSeq
    fixture.events.push({
      seq: statementSeq, time: 100 + statementSeq, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: statement }] },
    })
    fixture.events.push({
      seq: statementSeq + 1, time: 100 + statementSeq + 1, type: 'approval/asked',
      data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 2, step: 0 },
    })

    const policy = h.machinePolicy as { decide(request: { agent: typeof fixture.parent; toolName: string; callId: string; requestId: string }): Promise<string> }
    await expect(policy.decide({ agent: fixture.parent, toolName: 'bash', callId: 'call-1', requestId: 'ask-1' })).resolves.toBe('allowed-once')
    // The approval-time sync tail ran the first (and only) extraction.
    expect(h.extractionDeliveries).toHaveLength(1)

    const authorizations = (h.deliveredPacket as any)?.dossier?.interaction?.sealed?.authorizations
    expect(authorizations).toBeDefined()
    // Exactly one drawer row: the end-of-window statement and nothing else.
    expect(authorizations).toHaveLength(1)
    expect(authorizations[0]).toMatchObject({
      sourceSeq: statementSeq,
      occurredAt: 100 + statementSeq,
      effect: 'grant',
      coverage: 'session',
      quote: statement,
    })

    await plugin.dispose()
  })

  it('dispose is idempotent and closes the extraction channel before draining the authorization ledger', async () => {
    const fixture = buildApprovalE2EFixture({ padEvents: 0 })
    const h = harness({
      storageDomain: fixture.storageDomain,
      agents: { get: id => id === 'parent-1' ? fixture.parent : undefined },
    })
    const channelDispose = vi.spyOn(DefaultExtractionChannel.prototype, 'dispose')
    const ledgerDrain = vi.spyOn(DshStorageDomainAuthorizationLedger.prototype, 'drain')
    try {
      const plugin = installApproveForMe(h.ctx, config)
      const disposal = plugin.dispose()
      expect(plugin.dispose()).toBe(disposal)
      await disposal
      expect(channelDispose).toHaveBeenCalledOnce()
      expect(ledgerDrain).toHaveBeenCalledOnce()
      expect(h.disposeRegistration).toHaveBeenCalledOnce()
      expect(h.disposeExtractorRegistration).toHaveBeenCalledOnce()
    } finally {
      channelDispose.mockRestore()
      ledgerDrain.mockRestore()
    }
  })
})
