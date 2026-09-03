import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type { ManagedProviderRegistration } from 'dsh-managed-agent'
import {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
  ApproveForMeSettings,
  Config,
  configWithReviewerSettings,
  normalizeConfig,
  reviewerSettingsFromConfig,
} from './config.js'
import type {
  ApproveForMeSettings as ApproveForMeSettingsValue,
  Config as ApproveForMeConfig,
  NormalizedConfig,
} from './config.js'
import { DefaultDecisionChannel } from './application/decision-channel.js'
import { ApprovalRunLifecycle } from './application/approval-run-lifecycle.js'
import { GateFailure } from './application/gate-failure.js'
import { DefaultReviewCoordinator } from './application/review-coordinator.js'
import { DefaultReviewerDirectory } from './application/reviewer-directory.js'
import { SerialLanes } from './application/serial-lanes.js'
import { DefaultActionCapture } from './ports/action-projector.js'
import type { ActionProjector } from './ports/action-projector.js'
import { ToolFamilyActionProjectorRegistry } from './ports/tool-family-action-projector.js'
import { createCaptureBridge, createDefaultActionProjector } from './dsh/action-capture.js'
import { DshExecutionFactProjectionBridge } from './dsh/execution-projection-bridge.js'
import { DshScopedEffectiveCatalogResolver } from './dsh/effective-tool-catalog.js'
import { createDshAlpha2StockProjectorRegistry } from './dsh/stock-tools.js'
import { DossierGateFactProjector, SourceBackedGateFactResolver } from './application/source-backed-gate-facts.js'
import { DshParentSessionFactSource } from './dsh/parent-session-fact-source.js'
import { DefaultDossierCompiler } from './application/dossier-compiler.js'
import { InMemoryDossierCompilationMetrics, InstrumentedDossierCompiler } from './application/instrumented-dossier-compiler.js'
import type { DossierCompilationMetricsSink, DossierCompilationMetricsSnapshotV1 } from './ports/dossier-compilation-metrics.js'
import { InMemoryReviewerTelemetry } from './application/reviewer-telemetry.js'
import type { ReviewerTelemetrySink, ReviewerTelemetrySnapshotV1 } from './ports/reviewer-telemetry.js'
import { DefaultPrincipalDelegationProjector } from './application/delegation-projector.js'
import { createMachinePolicyAdapter } from './dsh/machine-policy-adapter.js'
import type { PatchedMachineApprovalPolicyLike } from './dsh/machine-policy-adapter.js'
import { createManagedReviewerPort } from './dsh/managed-controller.js'
import { DefaultGatePipeline } from './application/gate-pipeline.js'
import type { GatePreReview } from './application/gate-pipeline.js'
import { InMemoryAllowCache, InMemoryExactDenialBreaker } from './application/breaker.js'
import { DshStorageDomainGateDecisionRecordStore } from './dsh/storage-domain-decision-record.js'
import type { StorageDomainFacility } from './dsh/storage-domain-decision-record.js'
import {
  DshStorageDomainApprovalSnapshotRepository,
  DshStorageDomainExecutionFactRepository,
  DshStorageDomainFactRepositories,
} from './dsh/storage-domain-fact-repositories.js'
import { DefaultPreReviewCoordinator } from './application/pre-review-coordinator.js'
import { InMemorySealedDispositionRegistry } from './application/sealed-decision.js'
import { createTrustEnvelopeEvaluator } from './application/trust-envelope.js'
import { createReviewerProvider } from './reviewer/provider.js'
import { hashAction, REVIEWER_PROVIDER } from './domain/protocol.js'
import type { RequestedPermission } from './domain/protocol.js'
import type { ParentAuthority } from './ports/managed-reviewer.js'
import type { GateMachinePolicyV1 } from './approval-gate/machine-policy.js'
import { resolveReviewerModelRouteFromDshCatalog } from './dsh/reviewer-model-catalog.js'

export interface ApproveForMePlugin {
  readonly config: NormalizedConfig
  /** Non-sensitive bounded compiler baseline measurements. */
  getDossierCompilationMetrics(): DossierCompilationMetricsSnapshotV1
  /** Non-sensitive bounded Reviewer execution measurements. */
  getReviewerTelemetryMetrics(): ReviewerTelemetrySnapshotV1
  dispose(): Promise<void>
}

/** Internal mount failure whose acquired-provider rollback must fence retries. */
class ApproveForMeMountError extends Error {
  readonly rollback: Promise<void>

  constructor(cause: unknown, rollback: Promise<void>) {
    super(cause instanceof Error ? cause.message : 'dsh-approve-for-me mount failed', { cause })
    this.name = 'ApproveForMeMountError'
    this.rollback = rollback
  }
}

/**
 * Programmatic install options beyond the serializable Config. Code-level
 * projection strategies are injected ports, never loader data.
 */
export interface ApproveForMeInstallOptions {
  /** Project requested permissions from exact DSH execution facts. */
  projectPermissions?(execution: ToolExecution): readonly RequestedPermission[]
  /**
   * Optional closed-world tool-family action projector. When supplied it
   * replaces the legacy generic projection; unprojectable tools stay
   * uncaptured and therefore cannot receive an automatic approval.
   */
  actionProjector?: ActionProjector<ToolExecution>
  /**
   * Closed-world projector registry used by catalog-bound automatic approvals.
   * A non-empty catalog requires this port; generic projectors cannot satisfy
   * semantic identity bindings.
   */
  toolFamilyActionProjectors?: ToolFamilyActionProjectorRegistry<ToolExecution>
  /** Best-effort non-sensitive compiler metrics consumer. */
  dossierMetricsSink?: DossierCompilationMetricsSink
  /** Best-effort scalar-only Reviewer telemetry consumer. */
  reviewerTelemetrySink?: ReviewerTelemetrySink
}

export { Config }

interface LiveSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

function validateLiveApprovalBinding(agent: Agent, requestId: string, callId: string, toolName: string): string {
  const session = agent.session as unknown as { id?: unknown; header?: { id?: unknown; parentSession?: unknown; delegationDepth?: unknown }; snapshotEvents?: () => readonly LiveSessionEvent[] }
  const agentId = String((agent as unknown as { id?: unknown }).id ?? '')
  const sessionId = typeof session.id === 'string' ? session.id : ''
  if (sessionId.length === 0 || agentId !== sessionId || session.header?.id !== sessionId || typeof (session as { snapshotEvents?: unknown }).snapshotEvents !== 'function') {
    throw new GateFailure('integrity', 'approval ask is not bound to an exact live Agent/Session')
  }
  const events = session.snapshotEvents!()
  if (!Array.isArray(events)) {
    throw new GateFailure('integrity', 'approval ask is not bound to an exact live Agent/Session')
  }
  const asked = events.filter(event => event.type === 'approval/asked' && (() => {
    const data = event.data as Record<string, unknown>
    return data.id === requestId && data.callId === callId && data.toolName === toolName
  })())
  if (asked.length !== 1) throw new GateFailure('integrity', 'approval ask does not have one matching durable audit event')
  return sessionId
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
  const approvalService = ctx as unknown as {
    approval?: { registerMachinePolicy?: (policy: PatchedMachineApprovalPolicyLike) => () => void }
  }
  const approval = approvalService.approval
  if (approval?.registerMachinePolicy === undefined) {
    throw new Error(
      'the patched @deepseek-ai/dsh-user-approval fork (registerMachinePolicy) is not installed; '
      + 'refusing to mount a second approval/request authorization path',
    )
  }
  const toolRuntime = (ctx as unknown as { tools?: { schemas?: (agent: Agent) => readonly unknown[] } }).tools
  if (typeof toolRuntime?.schemas !== 'function') {
    throw new TypeError('dsh-approve-for-me requires scoped ctx.tools.schemas(agent)')
  }
  const scopedCatalogs = new DshScopedEffectiveCatalogResolver(
    { schemas: agent => toolRuntime.schemas!(agent) },
    normalized.toolCatalog.descriptors.length === 0 ? undefined : normalized.toolCatalog,
  )
  // Full case capture requires a host-private durable store with lifecycle-bound
  // TTL, quota reconciliation, deletion, and redacted-export controls. This
  // composition has no such adapter yet, so accepting it would falsely imply
  // operational retention. Keep the default-off capability explicit.
  if (normalized.caseCapture.mode === 'full') {
    throw new Error('caseCapture.mode "full" requires a host-private durable case-capture adapter, which is not available')
  }
  const channel = new DefaultDecisionChannel()
  const lifecycle = new ApprovalRunLifecycle()
  const captures = new DefaultActionCapture<Agent, string>()
  const configuredProjectors = options.toolFamilyActionProjectors
    ?? (normalized.toolCatalog.descriptors.length === 0
      ? undefined
      : createDshAlpha2StockProjectorRegistry(normalized.toolCatalog))
  if (normalized.toolCatalog.descriptors.length > 0) {
    const registered = configuredProjectors
    if (registered === undefined) {
      throw new TypeError('a non-empty toolCatalog requires a closed-world toolFamilyActionProjectors registry')
    }
    const catalogToolNames = new Set(normalized.toolCatalog.descriptors.map(descriptor => descriptor.toolName))
    for (const descriptor of normalized.toolCatalog.descriptors) {
      if (!registered.matches(descriptor.toolName, descriptor.actionSemanticsFamily, descriptor.actionProjectorId)) {
        throw new TypeError(`toolCatalog descriptor ${descriptor.toolName} has no matching registered semantic projector`)
      }
    }
    for (const toolName of registered.registeredToolNames()) {
      if (!catalogToolNames.has(toolName)) {
        throw new TypeError(`registered semantic projector tool ${toolName} is absent from toolCatalog`)
      }
    }
  }
  // Loader installations project through the same per-execution catalog that
  // durable execution facts consume. Programmatic projectors remain supported,
  // but they are still corroborated against the scoped/header catalog below.
  const actionProjector = configuredProjectors
    ?? options.actionProjector
    ?? (options.projectPermissions === undefined
      ? scopedCatalogs.actionProjector
      : createDefaultActionProjector(options.projectPermissions))
  const bridge = createCaptureBridge(actionProjector, captures)

  let registration: ManagedProviderRegistration | undefined
  let rollbackLanes: SerialLanes | undefined
  let rollbackDurableFacts: DshStorageDomainFactRepositories | undefined
  let rollbackRecords: DshStorageDomainGateDecisionRecordStore | undefined
  let stopPreExecute = () => {}
  let stopPostExecute = () => {}
  let stopResult = () => {}
  let stopSessionEvent = () => {}
  let stopMachinePolicy = () => {}
  try {
  const acquiredRegistration = registration = ctx.managedAgents.registerProvider(createReviewerProvider({
    submitDecision: {
      submit: (payload, actualReviewerSessionId) =>
        channel.submit(payload, { actualReviewerSessionId }),
    },
  }))
  const port = createManagedReviewerPort(acquiredRegistration.controller)
  const lanes = rollbackLanes = new SerialLanes()
  const reviewerTelemetry = new InMemoryReviewerTelemetry()
  const reviewerTelemetrySink: ReviewerTelemetrySink = {
    observe(observation) {
      reviewerTelemetry.observe(observation)
      try { options.reviewerTelemetrySink?.observe(observation) } catch { /* optional telemetry never authorizes */ }
    },
  }
  const coordinator = new DefaultReviewCoordinator({
    port,
    directory: new DefaultReviewerDirectory(port, REVIEWER_PROVIDER, normalized.maxDeliveryAttemptsPerChild),
    channel,
    lane: lanes,
    timeoutMs: normalized.timeoutMs,
    preset: normalized.preset,
    telemetry: reviewerTelemetrySink,
  })
  const trustEnvelope = createTrustEnvelopeEvaluator(normalized.trustEnvelope)
  const breaker = new InMemoryExactDenialBreaker()
  const allowCache = new InMemoryAllowCache()
  const seals = new InMemorySealedDispositionRegistry()
  // Parent-session facts must survive a cold resume. Failed Storage Domain
  // access remains non-authorizing because the source-backed resolver cannot
  // correlate an approval ask without both sidecars.
  const durableFacts = rollbackDurableFacts = new DshStorageDomainFactRepositories(
    (ctx as unknown as { storageDomain?: StorageDomainFacility }).storageDomain,
  )
  const executionFacts = new DshStorageDomainExecutionFactRepository(durableFacts)
  const approvalSnapshots = new DshStorageDomainApprovalSnapshotRepository(durableFacts)
  const factSource = new DshParentSessionFactSource({
    get: sessionId => (ctx as unknown as { agents?: { get?(id: string): Agent | undefined } }).agents?.get?.(sessionId),
  })
  const dossierMetrics = new InMemoryDossierCompilationMetrics()
  const compiler = new InstrumentedDossierCompiler(
    new DefaultDossierCompiler({
      delegationProjector: new DefaultPrincipalDelegationProjector(),
      maxDossierBytes: normalized.maxDossierBytes,
    }),
    {
      observe(observation) {
        dossierMetrics.observe(observation)
        try { options.dossierMetricsSink?.observe(observation) } catch { /* optional telemetry never authorizes */ }
      },
    },
  )
  const factStore = new SourceBackedGateFactResolver({
    factSource,
    compiler,
    projector: new DossierGateFactProjector(
      normalized.preset.generation,
      normalized.preset.configurationFingerprint,
      normalized.preset.policyVersion,
    ),
    async snapshotInput(pending, signal) {
      if (signal?.aborted) return undefined
      await executionProjection.awaitApprovalSnapshot(pending.agent, pending.requestId, pending.callId, pending.toolName)
      if (signal?.aborted) return undefined
      const session = pending.agent.session as unknown as { header?: { version?: unknown; createdAt?: unknown; cwd?: unknown } }
      const version = session.header?.version
      const createdAt = session.header?.createdAt
      const cwd = session.header?.cwd
      if (!Number.isSafeInteger(version) || (version as number) < 0
        || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0
        || (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0))) return undefined
      const lifecycle = {
        sessionId: pending.authority.sessionId,
        sessionFormatVersion: version as number,
        createdAt: createdAt as number,
        ...(cwd === undefined ? {} : { cwd }),
      }
      return {
        agent: pending.agent,
        approvalRequestId: pending.requestId,
        callId: pending.callId,
        toolName: pending.toolName,
        executionFacts: await executionFacts.list(lifecycle),
        approvalSnapshots: await approvalSnapshots.list(lifecycle),
        ...signal === undefined ? {} : { signal },
      }
    },
  })
  const executionProjection = new DshExecutionFactProjectionBridge(
    actionProjector,
    exec => scopedCatalogs.forExecution(exec),
    executionFacts,
    approvalSnapshots,
    captures,
  )
  // The target profile supplies the alpha.1 Storage Domain form. An absent or
  // failed domain remains non-authorizing: record confirmation returns
  // unavailable, so no automatic grant can escape the durability boundary.
  const records = rollbackRecords = new DshStorageDomainGateDecisionRecordStore(
    (ctx as unknown as { storageDomain?: StorageDomainFacility }).storageDomain,
  )

  // Pipeline pre-review uses the same ReviewCoordinator, sealing each result in
  // the in-memory registry so a later ask can replay instead of re-reviewing.
  const preReview: GatePreReview = {
    async preReview(input) {
      const authority = factStore.authorityFor(input.parentSessionId) as ParentAuthority<Agent, string> | undefined
      if (authority === undefined) throw new GateFailure('integrity', 'no live parent authority for pre-review')
      const pre = new DefaultPreReviewCoordinator<Agent, string>(coordinator, seals)
      const issuedAt = Date.now()
      return pre.preReview({
        authority,
        requestId: input.requestId,
        callId: input.callId,
        action: input.action,
        ...input.verifiedDossier === undefined ? {} : { verifiedDossier: input.verifiedDossier },
        ...input.assessment === undefined ? {} : { assessment: input.assessment },
        ...input.reason === undefined ? {} : { reason: input.reason },
        ...input.signal === undefined ? {} : { signal: input.signal },
        generation: input.generation,
        configurationFingerprint: input.configurationFingerprint,
        ...input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion },
        issuedAt,
        deadlineAt: issuedAt + normalized.timeoutMs,
      })
    },
  }

  const pipeline = new DefaultGatePipeline({
    trustEnvelope,
    breaker,
    allowCache,
    seals,
    facts: factStore,
    preReview,
    records,
    reviewerTelemetry: reviewerTelemetrySink,
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
    lifecycle,
    resolveActionHash: ({ agent, callId, requestId, toolName }) => {
      if (callId === undefined) {
        throw new GateFailure('integrity', 'cannot resolve action hash for an approval ask without a tool call id')
      }
      const parentSessionId = validateLiveApprovalBinding(agent, requestId, callId, toolName)
      const captured = captures.lookup(agent, callId, toolName)
      if (captured === undefined) {
        throw new GateFailure('integrity', `cannot resolve action hash for uncaptured tool call "${toolName}" (${callId})`)
      }
      const actionHash = hashAction(captured)
      // This stores correlation metadata only. Scope, tool schema, action and
      // decision keys must be rebuilt from durable Session facts by the resolver.
      factStore.register({
        agent,
        requestId,
        callId,
        toolName,
        actionHash,
        authority: { live: agent, sessionId: parentSessionId },
      })
      return actionHash
    },
  })
  stopPreExecute = ctx.on('tools/pre-execute', (exec, next) =>
      bridge.preExecute(exec, () => executionProjection.preExecute(exec, next)), { prepend: true })
    stopPostExecute = ctx.on('tools/post-execute', (exec, result, next) =>
      executionProjection.postExecute(exec, result, next), { prepend: true })
    stopResult = ctx.on('tools/result', (exec, result) => {
      bridge.observeResult(exec)
      executionProjection.observeResult(exec, result)
      scopedCatalogs.release(exec)
    })
    stopSessionEvent = ctx.on('session/event', (session, event) => {
      const sessionId = String((session as unknown as { id?: unknown }).id ?? '')
      const agent = (ctx as unknown as { agents?: { get?(id: string): Agent | undefined } }).agents?.get?.(sessionId)
      if (agent !== undefined) {
        void executionProjection.observeSessionEvent(agent, event as never).catch(() => {
          // A failed observer write is non-authorizing; an unhandled rejection
          // must not be able to take down the Host process.
        })
      }
    })
    // The machine policy is the commit point: every fallible event hook is
    // installed first, so a partial mount can never leave authorization armed.
    stopMachinePolicy = approval.registerMachinePolicy(machinePolicy)
  let disposal: Promise<void> | undefined
  return {
    config: normalized,
    getDossierCompilationMetrics: () => dossierMetrics.snapshot(),
    getReviewerTelemetryMetrics: () => reviewerTelemetry.snapshot(),
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      // Authorization and observers are revoked synchronously; concurrent
      // callers then join one complete ordered drain.
      stopMachinePolicy()
      stopSessionEvent()
      stopResult()
      stopPostExecute()
      stopPreExecute()
      disposal = (async () => {
        const errors: unknown[] = []
        for (const close of [
          () => lifecycle.dispose(),
          () => lanes.drain(),
          () => durableFacts.drain(),
          () => records.drain(),
        ]) {
          try { await close() } catch (error) { errors.push(error) }
        }
        try { channel.dispose() } catch (error) { errors.push(error) }
        try { await acquiredRegistration.dispose() } catch (error) { errors.push(error) }
        if (errors.length > 0) throw new AggregateError(errors, 'dsh-approve-for-me disposal failed')
      })()
      return disposal
    },
  }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const stop of [stopMachinePolicy, stopSessionEvent, stopResult, stopPostExecute, stopPreExecute]) {
      try { stop() } catch (reason) { rollbackErrors.push(reason) }
    }
    const rollback = (async () => {
      for (const close of [
        () => lifecycle.dispose(),
        () => rollbackLanes?.drain(),
        () => rollbackDurableFacts?.drain(),
        () => rollbackRecords?.drain(),
      ]) {
        try { await close() } catch (reason) { rollbackErrors.push(reason) }
      }
      try { channel.dispose() } catch (reason) { rollbackErrors.push(reason) }
      try { await registration?.dispose() } catch (reason) { rollbackErrors.push(reason) }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(rollbackErrors, 'dsh-approve-for-me mount rollback failed')
      }
    })()
    // Direct programmatic callers may only inspect the thrown error; observe the
    // rollback here while the loader additionally fences retries on the promise.
    void rollback.catch(reason => ctx.logger.error(reason))
    throw new ApproveForMeMountError(error, rollback)
  }
}

/**
 * Loader entrypoint. The Cordis effect exclusively owns the provider disposer,
 * so unload and HMR revoke the Controller before a replacement can register.
 */
export async function apply(ctx: Context, config: ApproveForMeConfig): Promise<void> {
  // Reject an invalid composition entry before registering any optional runtime
  // integration. The settings source can only replace the Reviewer route.
  normalizeConfig(config)
  const entrySettings = reviewerSettingsFromConfig(config)
  let settingsSource: () => ApproveForMeSettingsValue = () => entrySettings
  let topologyGeneration = 0
  let active: ApproveForMePlugin | undefined
  let disposed = false
  let started = false
  let settingsFaulted = false
  let retirementTail: Promise<void> = Promise.resolve()
  let latestReconcile: Promise<void> = Promise.resolve()
  let lookupAbort: AbortController | undefined
  const pending = new Set<Promise<void>>()

  /** Revoke the current policy synchronously and fence every late lookup. */
  const suspend = (): { readonly generation: number; readonly retirement: Promise<void> } => {
    const generation = ++topologyGeneration
    lookupAbort?.abort()
    lookupAbort = undefined
    const invalidated = active
    active = undefined
    if (invalidated !== undefined) {
      // dispose() revokes the machine policy before its first await. Keep a
      // failed teardown poisonous: uncertain leftovers must never be overlaid.
      const retirement = invalidated.dispose()
      retirementTail = retirementTail.then(() => retirement)
      // Keep the rejecting tail as a poison barrier, but observe it even when a
      // settings-registration throw prevents any reconcile from awaiting it.
      void retirementTail.catch(error => ctx.logger.error(error))
    }
    return { generation, retirement: retirementTail }
  }

  /** Resolve routes concurrently; only the newest generation may commit. */
  const reconcile = async (): Promise<void> => {
    const { generation, retirement } = suspend()
    const requestedConfig = configWithReviewerSettings(config, settingsSource())
    const normalized = normalizeConfig(requestedConfig)
    const controller = new AbortController()
    lookupAbort = controller
    await retirement
    if (disposed || settingsFaulted || generation !== topologyGeneration) return
    try {
      await resolveReviewerModelRouteFromDshCatalog(
        ctx.llm,
        normalized.preset.modelRoute,
        controller.signal,
      )
    } catch {
      // Missing, ambiguous, stale, or aborted routes are non-authorizing. A
      // settings correction or adapters-updated event retries the fresh catalog.
      return
    }
    if (disposed || generation !== topologyGeneration || controller.signal.aborted) return
    try {
      active = installApproveForMe(ctx, requestedConfig)
    } catch (error) {
      if (error instanceof ApproveForMeMountError) {
        retirementTail = retirementTail.then(() => error.rollback)
        void retirementTail.catch(reason => ctx.logger.error(reason))
        await retirementTail
      }
      throw error
    }
  }

  const track = (task: Promise<void>): Promise<void> => {
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    latestReconcile = task
    return task
  }
  const scheduleReconcile = () => {
    const task = track(reconcile())
    void task.catch(error => ctx.logger.error(error))
  }

  // Await the optional injection fiber before the first reconcile. When the
  // service is absent the pending fiber settles immediately; when present, its
  // stored section is authoritative before any policy can be armed.
  const settingsFiber = ctx.inject(['settings'], settingsCtx => {
    // A late provider attachment must retire the fallback policy before reading
    // a possibly-invalid stored section. A registration failure then stays dark
    // across later topology signals until a successful attachment clears it.
    settingsFaulted = true
    suspend()
    let attaching = true
    settingsCtx.settings.installSection(
      ctx,
      APPROVE_FOR_ME_SETTINGS_NAMESPACE,
      ApproveForMeSettings,
      entrySettings,
      {
        setSource(source) {
          settingsSource = source
        },
        validate(value) {
          // Keep loader and user-selected routes under the same config boundary.
          normalizeConfig(configWithReviewerSettings(config, value))
        },
        onChange() {
          if (started && !attaching) scheduleReconcile()
        },
      },
    )
    attaching = false
    settingsFaulted = false
    if (started) scheduleReconcile()
  })
  await settingsFiber

  const stopTopology = ctx.on('llm/adapters-updated', () => {
    if (started) scheduleReconcile()
  })
  ctx.effect(() => async () => {
    started = false
    disposed = true
    stopTopology()
    const { retirement } = suspend()
    await Promise.allSettled([...pending])
    await retirement
  }, 'dsh-approve-for-me.install()')

  started = true
  await track(reconcile())
  // A topology signal racing startup may supersede the first lookup; do not
  // report the loader ready until the newest generation has also settled.
  while (latestReconcile !== undefined) {
    const observed = latestReconcile
    await observed
    if (observed === latestReconcile) break
  }
}
