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
import type { GateFailureCode } from './application/gate-failure.js'
import { DefaultReviewCoordinator } from './application/review-coordinator.js'
import { DefaultReviewerDirectory } from './application/reviewer-directory.js'
import { SerialLanes } from './application/serial-lanes.js'
import { DefaultActionCapture } from './ports/action-projector.js'
import type { ActionProjector } from './ports/action-projector.js'
import { ToolFamilyActionProjectorRegistry } from './ports/tool-family-action-projector.js'
import { createCaptureBridge, createDefaultActionProjector } from './dsh/action-capture.js'
import { DshExecutionFactProjectionBridge } from './dsh/execution-projection-bridge.js'
import { DshStorageDomainSealedFacts } from './dsh/storage-domain-sealed-facts.js'
import { DshScopedEffectiveCatalogResolver } from './dsh/effective-tool-catalog.js'
import { createDshAlpha2StockProjectorRegistry } from './dsh/stock-tools.js'
import {
  DossierGateFactProjector,
  sealedCurrentCatalogInForce,
  SourceBackedGateFactResolver,
} from './application/source-backed-gate-facts.js'
import type { SealedFactsReader } from './application/source-backed-gate-facts.js'
import type { LiveAgentRegistry } from './ports/parent-session-facts.js'
import { deriveRequesterDepthV1, readSealedParentSessionFacts } from './dsh/parent-session-fact-source.js'
import { createSealedDossierCompiler } from './application/sealed-dossier-compiler.js'
import { assembleRecentExcerpts } from './application/recent-excerpts.js'
import { InMemoryDossierCompilationMetrics } from './application/instrumented-dossier-compiler.js'
import type { DossierCompilationMetricsSink, DossierCompilationMetricsSnapshotV1 } from './ports/dossier-compilation-metrics.js'
import { InMemoryReviewerTelemetry } from './application/reviewer-telemetry.js'
import type { ReviewerTelemetrySink, ReviewerTelemetrySnapshotV1 } from './ports/reviewer-telemetry.js'
import { InMemoryGateFailureMetrics } from './application/gate-failure-metrics.js'
import type { GateFailureMetricsSink, GateFailureMetricsSnapshotV1 } from './ports/gate-failure-metrics.js'
import { createMachinePolicyAdapter } from './dsh/machine-policy-adapter.js'
import type { PatchedMachineApprovalPolicyLike } from './dsh/machine-policy-adapter.js'
import { createManagedReviewerPort } from './dsh/managed-controller.js'
import { DefaultGatePipeline } from './application/gate-pipeline.js'
import type { GatePreReview } from './application/gate-pipeline.js'
import { InMemoryAllowCache, InMemoryExactDenialBreaker } from './application/breaker.js'
import { DshStorageDomainGateDecisionRecordStore } from './dsh/storage-domain-decision-record.js'
import type { StorageDomainFacility } from './dsh/storage-domain-decision-record.js'
import { createReasonCodeRouteHandler, REASON_CODE_ROUTE_PATH } from './application/reason-code-route.js'
import { createLedgerHealthRouteHandler, LEDGER_HEALTH_ROUTE_PATH } from './application/ledger-health-route.js'
import {
  DshStorageDomainApprovalSnapshotRepository,
  DshStorageDomainExecutionFactRepository,
  DshStorageDomainFactRepositories,
} from './dsh/storage-domain-fact-repositories.js'
import { DefaultPreReviewCoordinator } from './application/pre-review-coordinator.js'
import { InMemorySealedDispositionRegistry } from './application/sealed-decision.js'
import { createTrustEnvelopeEvaluator } from './application/trust-envelope.js'
import { createReviewerProvider } from './reviewer/provider.js'
import { dangerFullAccessRiskForPolicy } from './reviewer/policy.js'
import { hashAction, REVIEWER_PROVIDER } from './domain/protocol.js'
import { canonicalJson, parseUniqueJson, snapshotJson } from './domain/json.js'
import type { JsonValue } from './domain/json.js'
import { resolveStoredActionV2 } from './domain/dossier.js'
import type { ActionSnapshot, RequestedPermission } from './domain/protocol.js'
import type { ParentAuthority } from './ports/managed-reviewer.js'
import type { GateMachinePolicyV1 } from './approval-gate/machine-policy.js'
import { resolveReviewerModelRouteFromDshCatalog } from './dsh/reviewer-model-catalog.js'
import { createExtractorProvider } from './reviewer/extractor-provider.js'
import { DefaultExtractionChannel } from './application/extraction-channel.js'
import { DefaultAuthorizationExtractionCoordinator, boundedSyncTailDeadline } from './application/authorization-extraction-coordinator.js'
import type { AuthorizationLiveEventView } from './application/authorization-verification.js'
import { SealBackfillRunner } from './application/seal-backfill.js'
import type { SealBackfillLiveEventView } from './application/seal-backfill.js'
import type { PruneLifecycleResult } from './application/fact-repositories.js'
import type { SessionLifecycleIdentityV1 } from './domain/records.js'
import { DshStorageDomainAuthorizationLedger } from './dsh/storage-domain-authorization-ledger.js'
import { AUTHORIZATION_EXTRACTOR_VERSION, createExtractorProviderData, EXTRACTION_PROVIDER } from './domain/extraction-protocol.js'

export interface ApproveForMePlugin {
  readonly config: NormalizedConfig
  /** Non-sensitive bounded compiler baseline measurements. */
  getDossierCompilationMetrics(): DossierCompilationMetricsSnapshotV1
  /** Non-sensitive bounded Reviewer execution measurements. */
  getReviewerTelemetryMetrics(): ReviewerTelemetrySnapshotV1
  /** WP5-a §4.4 scalar-only gate failure reason-code totals. */
  getGateFailureMetrics(): GateFailureMetricsSnapshotV1
  /**
   * WP5-c: read-only, metadata-only reason code for an approval request id.
   * Resolves the typed Gate failure code recorded on the most recent
   * post-facts-failure decision row, or `undefined` when there is none or the
   * read cannot be satisfied. It never exposes a dossier, action, rationale or
   * authorizing channel — a read miss degrades to the renderer's generic line.
   */
  readApprovalReasonCode(requestId: string): Promise<GateFailureCode | undefined>
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

interface LiveSessionBinding {
  readonly id?: unknown
  readonly header?: { readonly id?: unknown; readonly parentSession?: unknown; readonly delegationDepth?: unknown }
  readonly seq?: unknown
  readonly eventAt?: (seq: number) => { readonly type: string; readonly data: unknown } | undefined
}

/**
 * Bind the approval ask to exactly one live Agent/Session and confirm its unique
 * durable approval/asked audit event. The ask is located with a bounded,
 * tail-anchored eventAt back-scan (window = maxSealedTailEvents) mirroring the
 * sealed reader and execution-bridge cold-start rule; it never materializes the
 * full session log. Window selection reuses the shared bounded-tail knob already
 * governing the sealed ledger, so every bounded live-session view is O(maxSealedTailEvents)
 * instead of O(N). A zero, duplicate, or out-of-window ask fails closed (integrity).
 */
function validateLiveApprovalBinding(agent: Agent, requestId: string, callId: string, toolName: string, maxSealedTailEvents: number): string {
  const session = agent.session as unknown as LiveSessionBinding
  const agentId = String((agent as unknown as { id?: unknown }).id ?? '')
  const sessionId = typeof session.id === 'string' ? session.id : ''
  if (sessionId.length === 0 || agentId !== sessionId || session.header?.id !== sessionId
    || typeof session.eventAt !== 'function' || typeof session.seq !== 'number') {
    throw new GateFailure('integrity', 'approval ask is not bound to an exact live Agent/Session')
  }
  const tail = session.seq
  if (!Number.isSafeInteger(tail) || tail < 0) {
    throw new GateFailure('integrity', 'approval ask is not bound to an exact live Agent/Session')
  }
  const lower = Math.max(0, tail - maxSealedTailEvents)
  let matched = 0
  for (let seq = tail - 1; seq >= lower; seq -= 1) {
    const event = session.eventAt!(seq)
    if (event === undefined) continue
    if (event.type !== 'approval/asked') continue
    const data = event.data as Record<string, unknown>
    if (data.id === requestId && data.callId === callId && data.toolName === toolName) matched += 1
  }
  if (matched !== 1) throw new GateFailure('integrity', 'approval ask does not have one matching durable audit event')
  return sessionId
}

interface SealedSessionEventView {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}


/** Read the exact approval/asked event at its seq and project the ask-time ref/time. */
function askRef(seq: number, session: { eventAt?: (seq: number) => SealedSessionEventView | undefined })
  : { readonly ref: { readonly seq: number; readonly type: string; readonly turn?: number; readonly step?: number } | undefined; readonly frozenAt: number | undefined } | undefined {
  const event = session.eventAt?.(seq)
  if (event === undefined || event.type !== 'approval/asked') return undefined
  const data = event.data as { turn?: unknown; step?: unknown } | undefined
  const turn = data === undefined || !Number.isSafeInteger(data.turn) ? undefined : data.turn as number
  const step = data === undefined || !Number.isSafeInteger(data.step) ? undefined : data.step as number
  if (!Number.isSafeInteger(event.time) || event.time < 0) return undefined
  return {
    ref: Object.freeze({ seq, type: event.type as string, ...(turn === undefined ? {} : { turn }), ...(step === undefined ? {} : { step }) }),
    frozenAt: event.time as number,
  }
}

/**
 * Mount the complete DSH business adapter on the standard Guarded Continuable
 * `dsh-managed-agent` Host. Composition order matters: channel → provider →
 * registration → adapters → hooks, so the decision tool never waits on a
 * half-initialized manager.
 */
/**
 * Optional Cordis service probe. On a real Cordis context, plain property
 * access to a non-injected service throws `cannot get property "<name>"
 * without inject` (the context Proxy get-trap enforces declared injections —
 * confirmed live on the web profile, WP8-a hot incident 2026-09-06), so
 * optional capabilities MUST be discovered through `ctx.get(name)`, which
 * returns undefined for absent or inactive providers. Plain-object test
 * harnesses expose no `get`; only those fall back to a direct property
 * read. A context that HAS `get` is never touched with property access.
 */
function probeOptionalService<T>(ctx: unknown, name: string): T | undefined {
  const withGet = ctx as { get?: (name: string) => unknown }
  if (typeof withGet.get === 'function') return withGet.get(name) as T | undefined
  return (ctx as Record<string, unknown>)[name] as T | undefined
}

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
  // The extractor submission channel (WP7-c2b, brief decisions 5/6) is created
  // alongside the decision channel so the extractor provider's submit closure
  // is complete before either provider is registered; mount rollback can then
  // always fence it.
  let rollbackExtractionChannel: DefaultExtractionChannel | undefined
  const extractionChannel = rollbackExtractionChannel = new DefaultExtractionChannel()
  // One complete deadline covers fact repair/compilation as well as Reviewer I/O.
  const lifecycle = new ApprovalRunLifecycle(normalized.timeoutMs)
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
  let extractorRegistration: ManagedProviderRegistration | undefined
  let rollbackAuthorizationLedger: DshStorageDomainAuthorizationLedger | undefined
  let rollbackLanes: SerialLanes | undefined
  let rollbackDurableFacts: DshStorageDomainFactRepositories | undefined
  let rollbackRecords: DshStorageDomainGateDecisionRecordStore | undefined
  let rollbackLedger: DshStorageDomainSealedFacts | undefined
  let rollbackSealBackfill: SealBackfillRunner | undefined
  let stopPreExecute = () => {}
  let stopPostExecute = () => {}
  let stopResult = () => {}
  let stopSessionEvent = () => {}
  let stopMachinePolicy = () => {}
  // WP9-b: fact-retention sweep fencing. The lane never rejects; disposal and
  // mount rollback both abort the sweep and await the lane before the fact
  // domain closes.
  let retentionSweepLane: Promise<void> = Promise.resolve()
  let retentionSweepAborted = false
  // WP8-a: presentational reason-code route disposer; a no-op when the host has
  // no webServer (CLI profile) or registration failed.
  let stopReasonCodeRoute = () => {}
  // WP8-b: presentational ledger-health route disposer; same no-op discipline.
  let stopLedgerHealthRoute = () => {}
  try {
  const acquiredRegistration = registration = ctx.managedAgents.registerProvider(createReviewerProvider({
    submitDecision: {
      submit: (payload, actualReviewerSessionId) =>
        channel.submit(payload, { actualReviewerSessionId }),
    },
  }))
  const port = createManagedReviewerPort(acquiredRegistration.controller)
  // Decision 5: the Authorization Extractor is a second managed provider with
  // Reviewer-level isolation; its only output is the typed extraction
  // submission, staged through the one-shot extraction channel whose identity
  // binding comes from the ACTUAL extractor Session (mirroring the decision
  // tool discipline).
  const acquiredExtractorRegistration = extractorRegistration = ctx.managedAgents.registerProvider(createExtractorProvider({
    submitExtraction: {
      submit: (payload, actualExtractorSessionId) =>
        extractionChannel.submit(payload, { actualExtractorSessionId }),
    },
  }))
  const extractorPort = createManagedReviewerPort(acquiredExtractorRegistration.controller)
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
    probeOptionalService<StorageDomainFacility>(ctx, 'storageDomain'),
  )
  const executionFacts = new DshStorageDomainExecutionFactRepository(durableFacts)
  const approvalSnapshots = new DshStorageDomainApprovalSnapshotRepository(durableFacts)
  const ledger = rollbackLedger = new DshStorageDomainSealedFacts(
    probeOptionalService<StorageDomainFacility>(ctx, 'storageDomain'),
    () => ctx.logger.error(new Error('approval ledger storage unavailable')),
  )
  // Private authorization drawer (WP7-a, decision 9). A degraded drawer can
  // never AMPLIFY an approval (absent rows = fewer authorizations). But a
  // polluted/failed drawer READ on the approval path is hard 'unavailable'
  // (ledger-storage-unavailable, plan §4.4) — the gate fails closed rather
  // than adjudicating over a storage state it cannot trust. The turn-end
  // extraction path, by contrast, degrades silently (fewer rows, retry next
  // turn) because it never gates a decision.
  const authorizationLedger = rollbackAuthorizationLedger = new DshStorageDomainAuthorizationLedger(
    probeOptionalService<StorageDomainFacility>(ctx, 'storageDomain'),
    () => ctx.logger.error(new Error('authorization ledger storage unavailable')),
  )
  // WP8-c: background-once seal backfill runner. Created unconditionally (it
  // never triggers unless config.sealBackfill is on); every storage read is
  // fail-closed and the ledger writes ride the same create-once append lane.
  const sealBackfill = rollbackSealBackfill = new SealBackfillRunner({
    listExecutions: async (session, signal) => {
      try {
        return await executionFacts.list(session, signal)
      } catch {
        return undefined
      }
    },
    listApprovals: async (session, signal) => {
      try {
        return await approvalSnapshots.list(session, signal)
      } catch {
        return undefined
      }
    },
    readSealed: lifecycleFingerprint => ledger.read(lifecycleFingerprint),
    appendSealed: (seal, activity) => ledger.append(seal, activity),
    // No closed-world projector registry (programmatic projector path): an
    // old row can never be re-resolved, so backfill stops — fail closed.
    projectorResolvable: (toolName, projectorId) => configuredProjectors?.matchesProjector(toolName, projectorId) ?? false,
    now: () => Date.now(),
    log: line => ctx.logger.error(new Error(line)),
  })
  // Decision 6: one coordinator serves both triggers. The idle trigger covers
  // root user/message events; the approval path additionally runs one
  // synchronous tail catch-up before the sealed facts read. extract() never
  // throws into either path: a missed extraction only means the drawer holds
  // fewer rows, and the checkpoint idempotence makes every retry safe.
  const authorizationCoordinator = new DefaultAuthorizationExtractionCoordinator<Agent, string>({
    port: extractorPort,
    channel: extractionChannel,
    ledger: authorizationLedger,
    preset: createExtractorProviderData({
      generation: normalized.preset.generation,
      modelRoute: normalized.preset.modelRoute,
      extractorVersion: AUTHORIZATION_EXTRACTOR_VERSION,
    }),
    lane: lanes,
    timeoutMs: normalized.timeoutMs,
    maxDeliveryAttemptsPerChild: normalized.maxDeliveryAttemptsPerChild,
    maxExtractionEvents: normalized.maxAuthorizationExtractionEvents,
  })
  const registry: LiveAgentRegistry = {
    get: sessionId => (ctx as unknown as { agents?: { get?(id: string): Agent | undefined } }).agents?.get?.(sessionId),
  }
  const sealedFacts: SealedFactsReader = {
    read: ({ agent, approvalRequestId, callId, toolName, maxSealedTailEvents, signal }) =>
      readSealedParentSessionFacts({ agent, registry, ledger, executionFacts, authorizationLedger, approvalRequestId, callId, toolName, maxSealedTailEvents, allowGenesis: normalized.genesisReview, ...(signal === undefined ? {} : { signal }) }),
  }
  const compileSealed = createSealedDossierCompiler({
    maxHotPacketBytes: normalized.maxHotPacketBytes,
    // S-3 (WP4-b4-2b): the per-excerpt byte budget must come from the same config
    // source as the assembler (assembleRecentExcerpts) so production assembly and
    // compile-time validation agree even at a non-default maxRecentExcerptBytes.
    maxRecentExcerptBytes: normalized.maxRecentExcerptBytes,
    // T1 (WP4 终审): consume the maxLedgerEntries knob so the sealed ledger row
    // count is bounded at compile time; a packet whose activity rows exceed it
    // fails closed as ledger-budget-overflow.
    maxLedgerEntries: normalized.maxLedgerEntries,
    // Decision 7 (WP7-c1): bound the authorization drawer row count entering
    // the hot packet; an over-budget drawer fails closed as the same
    // ledger-budget-overflow code as a ledger row overflow.
    maxAuthorizationEntries: normalized.maxAuthorizationEntries,
  })
  // The approval hot path compiles exclusively through createSealedDossierCompiler.
  // The complete-footprint DefaultDossierCompiler is a manual/debug entry provided
  // by the exported class itself (src/index.ts), so no runtime wiring is retained
  // here. The public getDossierCompilationMetrics()/dossierMetricsSink surface
  // stays for API stability and reports the empty legacy baseline (WP4-b §7: the
  // manual full-compile harness builds the class from the export directly).
  const dossierMetrics = new InMemoryDossierCompilationMetrics()
  // WP5-a §4.4: scalar-only gate failure counter; observe is best-effort and
  // never authorizing. It exposes per-reason-code totals for the tamper,
  // storage, projection and capacity classes.
  const gateFailureMetrics = new InMemoryGateFailureMetrics()
  const factStore = new SourceBackedGateFactResolver({
    sealedFacts,
    compileSealed,
    maxSealedTailEvents: normalized.maxSealedTailEvents,
    // WP10-a: genesis first-approval review switch (config genesisReview,
    // default true). Off preserves the legacy empty-ledger ->
    // sealed-current-missing delegate path byte-for-byte.
    genesisReview: normalized.genesisReview,
    // WP5-a: the resolver carries this generation/policy/reviewer-config metadata
    // so a source-backed failure can be recorded as a metadata-only audit row.
    generation: normalized.preset.generation,
    policyVersion: normalized.preset.policyVersion,
    reviewerConfigurationFingerprint: normalized.preset.configurationFingerprint,
    projector: new DossierGateFactProjector(
      normalized.preset.generation,
      normalized.preset.configurationFingerprint,
      normalized.preset.policyVersion,
      dangerFullAccessRiskForPolicy(normalized.preset.policyVersion),
    ),
    async snapshotInput(pending, signal, deadlineAt) {
      if (signal?.aborted) return undefined
      const session = pending.agent.session as unknown as {
        header?: { version?: unknown; createdAt?: unknown; cwd?: unknown; parentSession?: unknown; delegationDepth?: unknown }
        eventAt?: (seq: number) => SealedSessionEventView | undefined
      }
      const approvalAskedSeq = await executionProjection.awaitApprovalSnapshot(
        pending.agent,
        pending.requestId,
        pending.callId,
        pending.toolName,
        signal,
      )
      if (approvalAskedSeq === undefined || signal?.aborted) return undefined
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
      // Decision 6 (§5): synchronous drawer tail catch-up before the sealed
      // facts read covers every user/message in (checkpoint, approvalAskedSeq)
      // the idle trigger missed. This runs even when the idle extractor is
      // disabled; the result is deliberately ignored in every case -- a missed
      // extraction only means the drawer holds fewer rows and must never
      // block the approval. extract() itself never throws; the try/catch is
      // defense in depth on the hot path.
      try {
        const lifecycleFingerprint = canonicalJson(lifecycle)
        // The tail shares the run's wall clock but never its whole budget:
        // boundedSyncTailDeadline slices at most a quarter of the remaining
        // run deadline so a slow/absent extractor cannot starve the actual
        // decision (artifact-smoke evidence: a full-budget tail consumed the
        // machine deadline and the ask ended 'unavailable' without ever
        // reaching the composed answerer).
        const tailDeadline = deadlineAt === undefined ? undefined : boundedSyncTailDeadline(Date.now(), deadlineAt)
        if (tailDeadline !== undefined) await authorizationCoordinator.extract({
          authority: pending.authority,
          lifecycleFingerprint,
          // Re-bind to the session instance (WP6-b5): a bare eventAt reference
          // drops the receiver and would poison every live re-verification.
          eventAt: seq => session.eventAt?.(seq) as AuthorizationLiveEventView | undefined,
          throughSeq: approvalAskedSeq - 1,
          deadlineAt: tailDeadline,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        // Degrade to the drawer as it already stands; never fail the ask.
      }
      let projectedExecutions = await executionFacts.list(lifecycle, signal)
      const projectedApprovals = await approvalSnapshots.list(lifecycle, signal)
      if (signal?.aborted) return undefined
      const currentSnapshots = projectedApprovals.filter(snapshot =>
        snapshot.approvalRequestId === pending.requestId && snapshot.approvalAskedSeq === approvalAskedSeq)
      const currentRequestEventSeq = currentSnapshots.length === 1
        ? currentSnapshots[0]!.execution.requestEventSeq
        : undefined
      const repaired = await executionProjection.repairHistoricalResults(
        pending.agent,
        projectedExecutions,
        approvalAskedSeq,
        signal,
        currentRequestEventSeq,
      )
      if (signal?.aborted) return undefined
      if (repaired > 0) projectedExecutions = await executionFacts.list(lifecycle, signal)
      if (signal?.aborted || currentSnapshots.length !== 1 || currentRequestEventSeq === undefined) return undefined
      const approvalSnapshot = currentSnapshots[0]!
      const executionFact = projectedExecutions.find(item =>
        item.request.eventSeq === currentRequestEventSeq && item.request.callId === pending.callId && item.request.toolName === pending.toolName)
      if (executionFact === undefined) return undefined
      // Live catalog re-validation for the current (as-yet-unsealed) action:
      // the capture-frozen commitment must still be in force at the ask (wire
      // schemas match the bound header, and no later header supersedes it),
      // exactly as the full-history catalogAnchored path enforced.
      const inForce = sealedCurrentCatalogInForce({
        recordedHeaderEventSeq: executionFact.catalogEvidence.requestHeaderEventSeq,
        requestEventSeq: executionFact.request.eventSeq,
        wireSchemasDigest: executionFact.catalogEvidence.wireSchemasDigest,
        eventAt: seq => session.eventAt?.(seq) as { readonly type: string; readonly data: unknown } | undefined,
      })
      if (inForce.kind !== 'ok') return undefined
      // WP9-a: the stored execution fact references its action arguments by
      // digest. Re-derive the full action from the live source-call arguments
      // and bind it to the stored actionHash commitment; this live-verified
      // action is what the sealed dossier/compiler consume (byte-identical to
      // the v1 stored action for honest data, fail-closed on any mismatch).
      let resolvedAction: ActionSnapshot | undefined
      {
        const sourceEvent = session.eventAt?.(approvalSnapshot.execution.requestEventSeq)
        const sourceData = sourceEvent?.data as Record<string, unknown> | undefined
        let liveArguments: JsonValue | undefined
        try {
          const raw = sourceData?.arguments
          liveArguments = typeof raw === 'string' ? parseUniqueJson(raw) : snapshotJson(raw)
        } catch {
          liveArguments = undefined
        }
        if (sourceEvent !== undefined && liveArguments !== undefined) {
          const action = resolveStoredActionV2(executionFact.projection.action, liveArguments)
          resolvedAction = action !== undefined && hashAction(action) === executionFact.projection.actionHash ? action : undefined
        }
      }
      if (resolvedAction === undefined) return undefined
      const asked = askRef(approvalAskedSeq, session)
      if (asked === undefined || asked.ref === undefined || asked.frozenAt === undefined) return undefined
      const freeze = {
        parent: {
          sessionId: lifecycle.sessionId,
          sessionFormatVersion: lifecycle.sessionFormatVersion,
          createdAt: lifecycle.createdAt,
          ...(cwd === undefined ? {} : { cwd }),
        },
        throughSeq: approvalAskedSeq,
        currentTurn: asked.ref.turn ?? 0,
        currentStep: asked.ref.step ?? 0,
        frozenAt: asked.frozenAt,
      }
      const parentSessionId = typeof session.header?.parentSession === 'string' && session.header.parentSession.length > 0
        ? session.header.parentSession
        : undefined
      // WP4-c S-5: requester depth comes from the one shared derivation used by
      // sessionIdentity (header + runtime evidence, fail-closed), so the depth
      // can never fork between the plugin and the verified identity path.
      const effectiveDelegationDepth = deriveRequesterDepthV1({
        headerDelegationDepth: session.header?.delegationDepth as number | undefined,
        runtimeSubagentDepth: (pending.agent as unknown as { options?: { subagentDepth?: unknown } }).options?.subagentDepth as number | undefined,
      })
      if (effectiveDelegationDepth === undefined) return undefined
      // Assemble the bounded recent-transcript excerpt channel (WP4-b4-2a). It is
      // an intent-understanding aid for the Reviewer, never an authorization fact:
      // any assembly failure or empty result degrades to no excerpts (the current
      // action's authority is unchanged) rather than blocking the approval flow.
      let excerpts: readonly { readonly seq: number; readonly text: string }[] | undefined
      let excerptTruncated: number | undefined
      try {
        const excerptResult = assembleRecentExcerpts({
          askedSeq: approvalAskedSeq,
          maxRecentExcerptBytes: normalized.maxRecentExcerptBytes,
          eventAt: seq => session.eventAt?.(seq) as unknown as { readonly seq: number; readonly type: string; readonly time: number; readonly data: unknown } | undefined,
        })
        if (excerptResult.excerpts.length > 0 || excerptResult.truncated > 0) {
          excerpts = excerptResult.excerpts
          excerptTruncated = excerptResult.truncated
        }
      } catch {
        // Degrade to no excerpts; never fail the approval hot path.
        excerpts = undefined
        excerptTruncated = undefined
      }
      return {
        agent: pending.agent,
        approvalRequestId: pending.requestId,
        callId: pending.callId,
        toolName: pending.toolName,
        executionFact,
        approvalSnapshot,
        resolvedAction,
        approvalAsked: asked.ref,
        freeze,
        requester: { effectiveDelegationDepth, ...(parentSessionId === undefined ? {} : { parentSessionId }) },
        ...(excerpts === undefined ? {} : { excerpts }),
        ...(excerptTruncated === undefined ? {} : { excerptTruncated }),
        ...(signal === undefined ? {} : { signal }),
      }
    },
  })
  const executionProjection = new DshExecutionFactProjectionBridge(
    actionProjector,
    exec => scopedCatalogs.forExecution(exec),
    executionFacts,
    approvalSnapshots,
    captures,
    ledger,
    normalized.maxSealedTailEvents,
  )
  // The target profile supplies the alpha.1 Storage Domain form. An absent or
  // failed domain remains non-authorizing: record confirmation returns
  // unavailable, so no automatic grant can escape the durability boundary.
  const records = rollbackRecords = new DshStorageDomainGateDecisionRecordStore(
    probeOptionalService<StorageDomainFacility>(ctx, 'storageDomain'),
  )
  // WP8-a: read-only reason-code renderer transport. The web GUI host provides
  // the webServer service; the CLI profile does not, so probe via ctx.get (plain
  // property access throws on real Cordis contexts) and skip silently. The route is purely
  // presentational — a failing/absent registration (or host) can never affect
  // authorization, so registration failure is logged and never fails the mount.
  {
    const webServer = probeOptionalService<{
      register(route: { kind: 'exact'; path: string; handler: unknown }): () => void
    }>(ctx, 'webServer')
    if (webServer !== undefined && typeof webServer.register === 'function') {
      try {
        stopReasonCodeRoute = webServer.register({
          kind: 'exact',
          path: REASON_CODE_ROUTE_PATH,
          handler: createReasonCodeRouteHandler(requestId => records.readReasonCode(requestId)),
        })
        if (typeof stopReasonCodeRoute !== 'function') stopReasonCodeRoute = () => {}
      } catch (error) {
        stopReasonCodeRoute = () => {}
        ctx.logger.error(error)
      }
    }
  }
  // WP8-b: read-only ledger-health transport (seal-chain counts + authorization
  // drawer counts + extractor watermark). Same ctx.get probe, no-webServer skip,
  // and never-fail-the-mount discipline as WP8-a: the route only ever exposes
  // bounded scalars, and a degraded store merely omits its segment.
  {
    const webServer = probeOptionalService<{
      register(route: { kind: 'exact'; path: string; handler: unknown }): () => void
    }>(ctx, 'webServer')
    if (webServer !== undefined && typeof webServer.register === 'function') {
      try {
        stopLedgerHealthRoute = webServer.register({
          kind: 'exact',
          path: LEDGER_HEALTH_ROUTE_PATH,
          handler: createLedgerHealthRouteHandler({
            seal: () => ledger.health(),
            authorization: () => authorizationLedger.health(),
            clock: () => Date.now(),
          }),
        })
        if (typeof stopLedgerHealthRoute !== 'function') stopLedgerHealthRoute = () => {}
      } catch (error) {
        stopLedgerHealthRoute = () => {}
        ctx.logger.error(error)
      }
    }
  }

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
        deadlineAt: input.deadlineAt,
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
    gateFailureMetrics,
    mode: normalized.mode,
    // No automatic path may run until the source adapter supplies a complete,
    // source-verified dossier for this exact approval ask.
    requireVerifiedDossier: true,
  })

  // Every AFM decision uses the single machine-policy path. An empty catalog
  // is a non-authorizing pipeline state, never a reason to restore a legacy
  // approval/request answerer.
  const gate: GateMachinePolicyV1 = { id: 'dsh-approve-for-me/v1', decide: request => pipeline.decide(request) }

  // WP8-c: per-session in-flight approval run counts. A turn/end only triggers
  // a backfill when no run is in flight, and a newly started run aborts any
  // running backfill for that session's lifecycle (the idle assumption is
  // invalidated the moment the Host asks again).
  const pendingApprovalRuns = new Map<string, number>()
  // WP9-b: bounded in-process registry of observed session lifecycles for the
  // fact-retention sweep. The Storage Domain offers no global enumeration
  // (per-record layout, index rows keyed by an unrecoverable digest), so the
  // known-lifecycle set is exactly what this process observed; lifecycles
  // from earlier processes are not swept (sanctioned limitation, WP9-b
  // report). The registry is sweep-only state: it never authorizes anything
  // and is dropped at cap instead of evicting pruning candidates silently.
  const RETENTION_REGISTRY_CAP = 4096
  interface RetentionEntry { readonly lifecycle: SessionLifecycleIdentityV1; endedAt: number | undefined }
  const retentionEntries = new Map<string, RetentionEntry>()
  const observeRetentionEvent = (session: unknown, event: unknown): void => {
    if (!normalized.factRetention) return
    const binding = session as {
      readonly id?: unknown
      readonly header?: { readonly version?: unknown; readonly createdAt?: unknown; readonly cwd?: unknown }
    } | undefined
    const sessionId = typeof binding?.id === 'string' ? binding.id : ''
    const header = binding?.header
    const version = header?.version
    const createdAt = header?.createdAt
    if (sessionId.length === 0 || !Number.isSafeInteger(version) || (version as number) < 0
      || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0) return
    const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    if (header?.cwd !== undefined && cwd === undefined) return
    const eventType = (event as { readonly type?: unknown } | undefined)?.type
    const eventTime = (event as { readonly time?: unknown } | undefined)?.time
    // A doubtfully shaped event time must never arm a deletion clock.
    if (!Number.isSafeInteger(eventTime) || (eventTime as number) < 0 || Object.is(eventTime, -0)) return
    const lifecycle: SessionLifecycleIdentityV1 = {
      sessionId,
      sessionFormatVersion: version as number,
      createdAt: createdAt as number,
      ...(cwd === undefined ? {} : { cwd }),
    }
    const fingerprint = canonicalJson(lifecycle)
    const entry = retentionEntries.get(fingerprint)
    // turn/end is the only observed end marker; any later activity
    // (user/message, tool events, another turn) revokes it.
    const endedAt = eventType === 'turn/end' ? eventTime as number : undefined
    if (entry === undefined) {
      if (retentionEntries.size >= RETENTION_REGISTRY_CAP) return
      retentionEntries.set(fingerprint, { lifecycle, endedAt })
      return
    }
    entry.endedAt = endedAt
  }
  const agentsRegistry = (ctx as unknown as { agents?: { get?(id: string): Agent | undefined } }).agents
  /**
   * WP9-b: one bounded, oldest-first, single-lane retention sweep. Examines
   * at most factRetentionSweepLimit ended lifecycles; each prune re-checks
   * every condition fail-closed (liveness, grace, pending approvals, storage
   * integrity). 'unavailable' (or any unexpected throw) stops the whole
   * sweep; the specific skips do not. The sweep never rejects.
   */
  const runRetentionSweep = (): void => {
    if (!normalized.factRetention || retentionSweepAborted) return
    retentionSweepLane = retentionSweepLane.then(async (): Promise<void> => {
      if (retentionSweepAborted) return
      const now = Date.now()
      const candidates = [...retentionEntries.values()]
        .flatMap(entry => entry.endedAt === undefined ? [] : [{ entry, endedAt: entry.endedAt }])
        .sort((left, right) => left.endedAt - right.endedAt)
        .slice(0, normalized.factRetentionSweepLimit)
      for (const { entry } of candidates) {
        if (retentionSweepAborted) return
        const sessionId = entry.lifecycle.sessionId
        // Fail closed on liveness doubt: a registry that cannot be consulted
        // reads as live, so nothing is ever pruned on missing evidence.
        const live = typeof agentsRegistry?.get !== 'function' || agentsRegistry.get(sessionId) !== undefined
        let result: PruneLifecycleResult
        try {
          result = await durableFacts.pruneLifecycle(entry.lifecycle, {
            graceMs: normalized.factRetentionGraceMs,
            now,
            endedAt: entry.endedAt,
            live,
            hasPendingApprovals: (pendingApprovalRuns.get(sessionId) ?? 0) > 0,
          })
        } catch {
          return
        }
        if (result === 'unavailable') return
      }
    }).catch(() => {
      // The sweep is observational housekeeping; it must never take down the
      // Host process.
    })
  }
  const abortBackfillForAgentSession = (agent: Agent): void => {
    const session = agent.session as unknown as {
      id?: unknown
      header?: { version?: unknown; createdAt?: unknown; cwd?: unknown }
    } | undefined
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    const header = session?.header
    if (sessionId.length === 0 || header === undefined || header === null
      || !Number.isSafeInteger(header.version) || (header.version as number) < 0
      || !Number.isSafeInteger(header.createdAt) || (header.createdAt as number) < 0) return
    const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    const lifecycle = {
      sessionId,
      sessionFormatVersion: header.version as number,
      createdAt: header.createdAt as number,
      ...(cwd === undefined ? {} : { cwd }),
    }
    sealBackfill.abort(canonicalJson(lifecycle))
  }
  const machinePolicy = createMachinePolicyAdapter({
    gate,
    mode: normalized.mode,
    timeoutMs: normalized.timeoutMs,
    lifecycle,
    resolveActionHash: ({ agent, callId, requestId, toolName }) => {
      if (callId === undefined) {
        throw new GateFailure('integrity', 'cannot resolve action hash for an approval ask without a tool call id')
      }
      const parentSessionId = validateLiveApprovalBinding(agent, requestId, callId, toolName, normalized.maxSealedTailEvents)
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
      // WP9-b: feed the bounded retention registry; a newly ended lifecycle
      // arms one bounded sweep (the startup sweep precedes any observation,
      // so the turn/end retrigger is what keeps the bounded prune actually
      // reaching candidates within a long-running process).
      observeRetentionEvent(session, event)
      if ((event as { type?: unknown }).type === 'turn/end') runRetentionSweep()
      const agent = (ctx as unknown as { agents?: { get?(id: string): Agent | undefined } }).agents?.get?.(sessionId)
      if (agent !== undefined) {
        void executionProjection.observeSessionEvent(agent, event as never).catch(() => {
          // A failed observer write is non-authorizing; an unhandled rejection
          // must not be able to take down the Host process.
        })
        // Decision 6 idle trigger: one incremental drawer extraction per root
        // session user/message. Managed child sessions carry a parentSession
        // header, so the Reviewer/Extractor's own events can never re-enter
        // this hook (recursion guard). A failed extraction only means the
        // drawer holds fewer rows -- the next root user/message or the
        // approval-time catch-up retries, and checkpoint idempotence makes
        // retries safe -- so the promise is deliberately fire-and-forget.
        if (normalized.authorizationExtractorEnabled && sessionId.length > 0) {
          const binding = session as unknown as {
            eventAt?: (seq: number) => AuthorizationLiveEventView | undefined
            header?: { version?: unknown; createdAt?: unknown; cwd?: unknown; parentSession?: unknown }
          }
          const header = binding.header
          const eventSeq = (event as { seq?: unknown }).seq
          if ((event as { type?: unknown }).type === 'user/message'
            && (header?.parentSession === undefined || header.parentSession === '')
            && Number.isSafeInteger(header?.version) && (header?.version as number) >= 0
            && Number.isSafeInteger(header?.createdAt) && (header?.createdAt as number) >= 0
            && Number.isSafeInteger(eventSeq) && (eventSeq as number) >= 0
            && typeof binding.eventAt === 'function') {
            const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
            // Same lifecycle key set as the sealed reader (parent-session-fact-source):
            // { sessionId, sessionFormatVersion, createdAt, cwd? } -- the drawer
            // rows and the sealed facts must hash under one fingerprint.
            const lifecycle = {
              sessionId,
              sessionFormatVersion: header!.version as number,
              createdAt: header!.createdAt as number,
              ...(cwd === undefined ? {} : { cwd }),
            }
            const authority: ParentAuthority<Agent, string> = { live: agent, sessionId }
            const lifecycleFingerprint = canonicalJson(lifecycle)
            // No-op guard: an event that cannot change the drawer must never
            // run ensureExtractorChild / arm the channel / deliver. Drawer rows
            // only ever exist behind an extraction checkpoint, so a session
            // with NO checkpoint and NO extractor child (the managed directory
            // list is the only valid childSession evidence, spec: discovery
            // only) holds no incremental state worth waking the model for --
            // and the approval-time catch-up still initializes the drawer.
            // Fail-closed toward extraction: any binding/reader doubt runs it.
            void (async () => {
              try {
                const tip = await authorizationLedger.readCheckpoint(lifecycleFingerprint)
                if (tip !== undefined && tip !== null && (eventSeq as number) <= tip.throughSeq) return
                const children = await extractorPort.list(sessionId)
                if (tip === null
                  && !children.some(child => child.provider === EXTRACTION_PROVIDER && child.parentSessionId === sessionId)) {
                  return
                }
              } catch {
                // Reader/directory doubt: fall through and extract.
              }
              await authorizationCoordinator.extract({
                authority,
                lifecycleFingerprint,
                eventAt: seq => binding.eventAt?.(seq) as AuthorizationLiveEventView | undefined,
                throughSeq: eventSeq as number,
              })
            })().catch(() => {})
          }
        }
      }
      // WP8-c: background-once seal backfill trigger. Root sessions only (the
      // parentSession header is the recursion guard that keeps managed child
      // sessions from ever re-entering here) and only when the config switch
      // is on. A turn/end with no in-flight approval run and an empty writer
      // lane queues exactly one attempt per lifecycle per process; new
      // user/message activity or a new approval run aborts it (the append-only
      // create-once ledger makes a mid-run abort safe).
      if (normalized.sealBackfill && sessionId.length > 0) {
        const backfillBinding = session as unknown as {
          eventAt?: (seq: number) => SealBackfillLiveEventView | undefined
          header?: { version?: unknown; createdAt?: unknown; cwd?: unknown; parentSession?: unknown }
        }
        const backfillHeader = backfillBinding.header
        const backfillEventType = (event as { type?: unknown }).type
        if ((backfillHeader?.parentSession === undefined || backfillHeader.parentSession === '')
          && Number.isSafeInteger(backfillHeader?.version) && (backfillHeader?.version as number) >= 0
          && Number.isSafeInteger(backfillHeader?.createdAt) && (backfillHeader?.createdAt as number) >= 0
          && typeof backfillBinding.eventAt === 'function') {
          const backfillCwd = typeof backfillHeader?.cwd === 'string' && backfillHeader.cwd.length > 0 ? backfillHeader.cwd : undefined
          const backfillLifecycle = {
            sessionId,
            sessionFormatVersion: backfillHeader!.version as number,
            createdAt: backfillHeader!.createdAt as number,
            ...(backfillCwd === undefined ? {} : { cwd: backfillCwd }),
          }
          const backfillFingerprint = canonicalJson(backfillLifecycle)
          if (backfillEventType === 'user/message') {
            sealBackfill.abort(backfillFingerprint)
          } else if (backfillEventType === 'turn/end'
            && !pendingApprovalRuns.has(sessionId)
            && !sealBackfill.isRunning(backfillFingerprint)) {
            const started = sealBackfill.attempt({
              lifecycle: backfillLifecycle,
              lifecycleFingerprint: backfillFingerprint,
              eventAt: seq => backfillBinding.eventAt?.(seq) as SealBackfillLiveEventView | undefined,
            })
            if (started !== 'already-attempted') {
              // Fire-and-forget: the runner logs a bounded scalar line for
              // every outcome and never rejects.
              void started.catch(() => {})
            }
          }
        }
      }
    })
    // The machine policy is the commit point: every fallible event hook is
    // installed first, so a partial mount can never leave authorization armed.
    // WP8-c: wrap the policy so every approval run start/settle updates the
    // per-session in-flight count and a start aborts that session's backfill.
    const trackedMachinePolicy: PatchedMachineApprovalPolicyLike = {
      id: machinePolicy.id,
      async decide(request) {
        const sessionId = String(request.agent?.session?.id ?? '')
        if (sessionId.length > 0) {
          pendingApprovalRuns.set(sessionId, (pendingApprovalRuns.get(sessionId) ?? 0) + 1)
          abortBackfillForAgentSession(request.agent)
        }
        try {
          return await machinePolicy.decide(request)
        } finally {
          const remaining = (pendingApprovalRuns.get(sessionId) ?? 1) - 1
          if (remaining <= 0) pendingApprovalRuns.delete(sessionId)
          else pendingApprovalRuns.set(sessionId, remaining)
        }
      },
    }
    stopMachinePolicy = approval.registerMachinePolicy(trackedMachinePolicy)
    // WP9-b: bounded startup sweep; every observed turn/end retriggers one
    // (each run stays within factRetentionSweepLimit, oldest first).
    runRetentionSweep()
  let disposal: Promise<void> | undefined
  return {
    config: normalized,
    getDossierCompilationMetrics: () => dossierMetrics.snapshot(),
    getReviewerTelemetryMetrics: () => reviewerTelemetry.snapshot(),
    getGateFailureMetrics: () => gateFailureMetrics.snapshot(),
    readApprovalReasonCode: async requestId => {
      // WP5-c: the reason-code read is presentational and never authorizing. Any
      // store failure or missing row degrades to `undefined` (renderer safe line).
      try {
        return await records.readReasonCode(requestId)
      } catch {
        return undefined
      }
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      // Fence observers and policy first, abort active work, then drain every
      // writer before unregistering the provider and closing durable domains.
      stopMachinePolicy()
      stopSessionEvent()
      stopResult()
      stopPostExecute()
      stopPreExecute()
      stopReasonCodeRoute()
      stopLedgerHealthRoute()
      disposal = (async () => {
        const errors: unknown[] = []
        // The extraction channel closes BEFORE the lane drain so every in-flight
        // extraction settles immediately as 'disposed'; draining lanes then
        // waits for those settlements, and only after that do the drawers close.
        for (const close of [
          () => lifecycle.dispose(),
          () => extractionChannel.dispose(),
          () => lanes.drain(),
          // WP8-c: abort in-flight backfills and drain their writer lane before
          // the sealed ledger closes underneath them.
          () => sealBackfill.dispose(),
          () => ledger.drain(),
          () => authorizationLedger.drain(),
        ]) {
          try { await close() } catch (error) { errors.push(error) }
        }
        try { channel.dispose() } catch (error) { errors.push(error) }
        try { await acquiredRegistration.dispose() } catch (error) { errors.push(error) }
        try { await acquiredExtractorRegistration.dispose() } catch (error) { errors.push(error) }
        // WP9-b: fence the retention sweep before the fact domain closes.
        retentionSweepAborted = true
        try { await retentionSweepLane } catch (error) { errors.push(error) }
        for (const close of [() => durableFacts.drain(), () => records.drain()]) {
          try { await close() } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'dsh-approve-for-me disposal failed')
      })()
      return disposal
    },
  }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const stop of [stopMachinePolicy, stopSessionEvent, stopResult, stopPostExecute, stopPreExecute, stopReasonCodeRoute, stopLedgerHealthRoute]) {
      try { stop() } catch (reason) { rollbackErrors.push(reason) }
    }
    const rollback = (async () => {
      // WP9-b: the sweep is normally armed only after the last mount step, but
      // fence it here too so a mid-mount failure can never leak a pruning
      // lane past rollback.
      retentionSweepAborted = true
      for (const close of [
        () => lifecycle.dispose(),
        () => rollbackExtractionChannel?.dispose(),
        () => rollbackLanes?.drain(),
        () => rollbackSealBackfill?.dispose(),
        () => rollbackLedger?.drain(),
        () => rollbackAuthorizationLedger?.drain(),
        () => retentionSweepLane,
        () => rollbackDurableFacts?.drain(),
        () => rollbackRecords?.drain(),
      ]) {
        try { await close() } catch (reason) { rollbackErrors.push(reason) }
      }
      try { channel.dispose() } catch (reason) { rollbackErrors.push(reason) }
      try { await registration?.dispose() } catch (reason) { rollbackErrors.push(reason) }
      try { await extractorRegistration?.dispose() } catch (reason) { rollbackErrors.push(reason) }
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
