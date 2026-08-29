import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Config, normalizeConfig } from './config.js'
import type { Config as ApproveForMeConfig, NormalizedConfig } from './config.js'
import { DefaultDecisionChannel } from './application/decision-channel.js'
import { GateFailure } from './application/gate-failure.js'
import { DefaultReviewCoordinator } from './application/review-coordinator.js'
import { DefaultReviewerDirectory } from './application/reviewer-directory.js'
import { SerialLanes } from './application/serial-lanes.js'
import { DefaultActionCapture } from './ports/action-projector.js'
import { createCaptureBridge, createDefaultActionProjector } from './dsh/action-capture.js'
import { createMachinePolicyAdapter } from './dsh/machine-policy-adapter.js'
import type { PatchedMachineApprovalPolicyLike } from './dsh/machine-policy-adapter.js'
import { createManagedReviewerPort } from './dsh/managed-controller.js'
import { DefaultGatePipeline } from './application/gate-pipeline.js'
import type { GatePreReview } from './application/gate-pipeline.js'
import { InMemoryAllowCache, InMemoryExactDenialBreaker } from './application/breaker.js'
import { InMemoryGateActionFactStore } from './application/capture-gate-facts.js'
import { DshStorageDomainGateDecisionRecordStore } from './dsh/storage-domain-decision-record.js'
import type { StorageDomainFacility } from './dsh/storage-domain-decision-record.js'
import { DefaultPreReviewCoordinator } from './application/pre-review-coordinator.js'
import { InMemorySealedDispositionRegistry } from './application/sealed-decision.js'
import { createToolApprovalClassifier } from './application/tool-classifier.js'
import { createTrustEnvelopeEvaluator } from './application/trust-envelope.js'
import { createReviewerProvider } from './reviewer/provider.js'
import { hashAction } from './domain/protocol.js'
import type { RequestedPermission } from './domain/protocol.js'
import type { ParentAuthority } from './ports/managed-reviewer.js'
import type { GateMachinePolicyV1 } from './approval-gate/machine-policy.js'

export interface ApproveForMePlugin {
  readonly config: NormalizedConfig
  dispose(): Promise<void>
}

/**
 * Programmatic install options beyond the serializable Config. Code-level
 * projection strategies are injected ports, never loader data.
 */
export interface ApproveForMeInstallOptions {
  /** Project requested permissions from exact DSH execution facts. */
  projectPermissions?(execution: ToolExecution): readonly RequestedPermission[]
}

export { Config }

interface LiveSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

function deriveLiveGateScope(agent: Agent, requestId: string, callId: string, toolName: string): {
  readonly sessionId: string
  readonly turn: number
  readonly directUserFrontierSeq: number
  readonly rootRequester: boolean
} {
  const session = agent.session as unknown as { id?: unknown; header?: { id?: unknown; parentSession?: unknown; delegationDepth?: unknown }; events?: readonly LiveSessionEvent[] }
  const agentId = String((agent as unknown as { id?: unknown }).id ?? '')
  const sessionId = typeof session.id === 'string' ? session.id : ''
  if (sessionId.length === 0 || agentId !== sessionId || session.header?.id !== sessionId || !Array.isArray(session.events)) {
    throw new GateFailure('integrity', 'approval ask is not bound to an exact live Agent/Session')
  }
  const asked = session.events.filter(event => event.type === 'approval/asked' && (() => {
    const data = event.data as Record<string, unknown>
    return data.id === requestId && data.callId === callId && data.toolName === toolName
  })())
  if (asked.length !== 1) throw new GateFailure('integrity', 'approval ask does not have one matching durable audit event')
  const ask = asked[0]!
  let turn: number | undefined
  let directUserFrontierSeq: number | undefined
  for (const event of session.events) {
    if (event.seq > ask.seq) break
    const data = event.data as Record<string, unknown>
    if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) turn = data.turn as number
    if (event.type === 'user/message' && (data.source as Record<string, unknown> | undefined)?.kind === 'user') directUserFrontierSeq = event.seq
  }
  if (turn === undefined || directUserFrontierSeq === undefined) {
    throw new GateFailure('integrity', 'approval ask lacks a derived turn or direct-user frontier')
  }
  const depth = session.header.delegationDepth
  const rootRequester = session.header.parentSession === undefined && (depth === undefined || depth === 0)
  return { sessionId, turn, directUserFrontierSeq, rootRequester }
}

/**
 * Mount the complete DSH business adapter on the standard Guarded Continuable
 * `dsh-managed-agent` Host. Composition order matters: channel → provider →
 * registration → adapters → hooks, so the decision tool never waits on a
 * half-initialized manager.
 */
export function installApproveForMe(
  ctx: Context,
  config: ApproveForMeConfig,
  options: ApproveForMeInstallOptions = {},
): ApproveForMePlugin {
  const normalized = normalizeConfig(config)
  const channel = new DefaultDecisionChannel()
  const captures = new DefaultActionCapture<Agent, string>()
  const bridge = createCaptureBridge(createDefaultActionProjector(options.projectPermissions), captures)

  const registration = ctx.managedAgents.registerProvider(createReviewerProvider({
    submitDecision: {
      submit: (payload, actualReviewerSessionId) =>
        channel.submit(payload, { actualReviewerSessionId }),
    },
  }))
  const port = createManagedReviewerPort(registration.controller)
  const lanes = new SerialLanes()
  const coordinator = new DefaultReviewCoordinator({
    port,
    directory: new DefaultReviewerDirectory(port),
    channel,
    lane: lanes,
    timeoutMs: normalized.timeoutMs,
    preset: normalized.preset,
  })
  const classifier = createToolApprovalClassifier(normalized.toolCatalog)
  const trustEnvelope = createTrustEnvelopeEvaluator(normalized.trustEnvelope)
  const breaker = new InMemoryExactDenialBreaker()
  const allowCache = new InMemoryAllowCache()
  const seals = new InMemorySealedDispositionRegistry()
  const factStore = new InMemoryGateActionFactStore()
  // The target profile supplies the alpha.1 Storage Domain form. An absent or
  // failed domain remains non-authorizing: record confirmation returns
  // unavailable, so no automatic grant can escape the durability boundary.
  const records = new DshStorageDomainGateDecisionRecordStore(
    (ctx as unknown as { storageDomain?: StorageDomainFacility }).storageDomain,
  )

  // Pipeline pre-review uses the same ReviewCoordinator, sealing each result in
  // the in-memory registry so a later ask can replay instead of re-reviewing.
  const preReview: GatePreReview = {
    async preReview(input) {
      const authority = factStore.authorityFor(input.parentSessionId) as ParentAuthority<Agent, string> | undefined
      if (authority === undefined) throw new GateFailure('integrity', 'no live parent authority for pre-review')
      const pre = new DefaultPreReviewCoordinator<Agent, string>(coordinator, seals)
      return pre.preReview({
        authority,
        requestId: input.requestId,
        callId: input.callId,
        action: input.action,
        ...input.reason === undefined ? {} : { reason: input.reason },
        ...input.signal === undefined ? {} : { signal: input.signal },
        generation: input.generation,
        configurationFingerprint: input.configurationFingerprint,
        issuedAt: Date.now(),
        deadlineAt: Date.now() + normalized.timeoutMs,
      })
    },
  }

  const pipeline = new DefaultGatePipeline({
    classifier,
    trustEnvelope,
    breaker,
    allowCache,
    seals,
    facts: factStore,
    preReview,
    records,
    mode: normalized.mode,
    // No automatic path may run until the source adapter supplies a complete,
    // source-verified dossier for this exact approval ask.
    requireVerifiedDossier: true,
  })

  // Every AFM decision uses the single machine-policy path. An empty catalog
  // is a non-authorizing pipeline state, never a reason to restore a legacy
  // approval/request answerer.
  const gate: GateMachinePolicyV1 = { id: 'dsh-approve-for-me/v1', decide: request => pipeline.decide(request) }

  const machinePolicy = createMachinePolicyAdapter({
    gate,
    mode: normalized.mode,
    resolveActionHash: ({ agent, callId, requestId, toolName }) => {
      if (callId === undefined) {
        throw new GateFailure('integrity', 'cannot resolve action hash for an approval ask without a tool call id')
      }
      const scope = deriveLiveGateScope(agent, requestId, callId, toolName)
      const parentSessionId = scope.sessionId
      const captured = captures.lookup(agent, callId, toolName)
      if (captured === undefined) {
        throw new GateFailure('integrity', `cannot resolve action hash for uncaptured tool call "${toolName}" (${callId})`)
      }
      const descriptor = normalized.toolCatalog.descriptors.find(item => item.toolName === toolName)
      const toolSchemaFingerprint = descriptor?.toolSchemaFingerprint ?? ''
      const actionHash = hashAction(captured)
      const classification = classifier.classify({ toolName, toolSchemaFingerprint })
      factStore.register({
        parentSessionId,
        actionHash,
        action: captured,
        toolSchemaFingerprint,
        classification,
        breakerKey: {
          parentLifecycleFingerprint: parentSessionId,
          turn: scope.turn,
          directUserFrontierSeq: scope.directUserFrontierSeq,
          actionHash,
        },
        allowCacheKey: {
          parentLifecycleFingerprint: parentSessionId,
          turn: scope.turn,
          directUserFrontierSeq: scope.directUserFrontierSeq,
          actionHash,
          configurationFingerprint: normalized.preset.configurationFingerprint,
          generation: normalized.preset.generation,
        },
        rootRequester: scope.rootRequester,
        directChildOrigin: !scope.rootRequester,
        generation: normalized.preset.generation,
        configurationFingerprint: normalized.preset.configurationFingerprint,
        authority: { live: agent, sessionId: parentSessionId },
      })
      return actionHash
    },
  })
  const approvalService = ctx as unknown as {
    approval?: { registerMachinePolicy?: (policy: PatchedMachineApprovalPolicyLike) => () => void }
  }
  if (approvalService.approval?.registerMachinePolicy === undefined) {
    throw new Error(
      'the patched @deepseek-ai/dsh-user-approval fork (registerMachinePolicy) is not installed; '
      + 'refusing to mount a second approval/request authorization path',
    )
  }
  const stopMachinePolicy = approvalService.approval.registerMachinePolicy(machinePolicy)

  const stopPreExecute = ctx.on('tools/pre-execute', bridge.preExecute, { prepend: true })
  const stopResult = ctx.on('tools/result', bridge.observeResult)

  return {
    config: normalized,
    async dispose(): Promise<void> {
      stopMachinePolicy()
      stopResult()
      stopPreExecute()
      await lanes.drain()
      await records.drain()
      channel.dispose()
      await registration.dispose()
    },
  }
}

/**
 * Loader entrypoint. The Cordis effect exclusively owns the provider disposer,
 * so unload and HMR revoke the Controller before a replacement can register.
 */
export function apply(ctx: Context, config: ApproveForMeConfig): void {
  ctx.effect(() => {
    const plugin = installApproveForMe(ctx, config)
    return () => plugin.dispose()
  }, 'dsh-approve-for-me.install()')
}
