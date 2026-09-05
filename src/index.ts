// Domain protocol and JSON helpers.
export {
  JsonSnapshotError,
  canonicalJson,
  freezeJson,
  snapshotJson,
} from './domain/json.js'
export type { JsonPrimitive, JsonValue } from './domain/json.js'
export { activityClassificationFromDescriptorV1, chainTipHash, createActivityV1, createSealV1, DEFAULT_MAX_SEALED_HISTORY_WINDOW, genesisSealHash, parseActivityV1, parseSealV1, sealHash, sealedFactKey } from './domain/sealed-facts.js'
export type { ActivityV1, SealV1, SealResultStatusV1 } from './domain/sealed-facts.js'
export {
  DECISION_PAYLOAD_HASH_DOMAIN,
  DECISION_TOOL_SCHEMA_HASH_DOMAIN,
  DOSSIER_HASH_DOMAIN,
  PACKET_HASH_DOMAIN,
  POLICY_ARTIFACT_HASH_DOMAIN,
  artifactBytes,
  caseArtifactKey,
  createApprovalReviewPacketV1,
  createApprovalReviewPacketV2,
  hashApprovalDecisionPayload,
  hashApprovalReviewPacket,
  hashDecisionToolSchema,
  hashGuardianDossier,
  hashGuardianPolicyArtifact,
  parseApprovalReviewPacketV1,
  parseApprovalReviewPacketV2,
  parseGuardianCaseArtifactV1,
  parseGuardianPolicyArtifactV1,
  parseReviewDecisionRecord,
  reviewRecordKey,
  validateCaseCaptureConfig,
} from './domain/records.js'
export type {
  ApprovalReviewPacketV1,
  ApprovalReviewPacketV2,
  GuardianCaseArtifactV1,
  GuardianCaseAttemptObservationV1,
  GuardianCaseCaptureConfigV1,
  GuardianPolicyArtifactV1,
  ReviewDecisionGuardianV1,
  ReviewDecisionRecordAttemptOutcome,
  ReviewDecisionRecordV1,
  ReviewerRecoveryRecordV1,
  SessionLifecycleIdentityV1,
} from './domain/records.js'
export {
  assertDossierShape,
  effectiveToolBindingFromSchemaV1,
  effectiveToolBindingsFromRequestHeaderV1,
  fingerprintDelegationToolCatalogV1,
  isApprovalEnvironmentEvidenceV1,
  recomputeDossierHash,
  validateDelegationToolCatalog,
  validateToolTrajectorySection,
} from './domain/dossier.js'
export type {
  AgentDeliveryV1,
  ApprovalEnvironmentEvidenceV1,
  ApprovalReviewPacketCodecV1,
  ApprovalSnapshotRecordV1,
  CatalogEpochSummaryV1,
  CodeDispatchRequestRefV1,
  DirectUserMessageV1,
  InteractionSectionV1,
  InteractionTurnV1,
  PrincipalDelegationLedgerV1,
  TurnEndSummaryV1,
  DelegationReceiptFactRecordV1,
  DossierCompilationResultV1,
  EffectiveToolBindingV1,
  DossierMetricsV1,
  DossierSectionMetricsV1,
  DossierCompletenessV1,
  ConfinementProjectionV1,
  DelegationCatalogValidationV1,
  DelegationToolClassificationCatalogV1,
  DelegationToolDescriptorV1,
  DossierFreezeV1,
  EventRefV1,
  GuardianDossierCompiler,
  GuardianDossierCompilerDependencies,
  GuardianDossierV1,
  InstructionMessageV1,
  InstructionSectionV1,
  NativeToolRequestRefV1,
  ParentSessionFactSnapshotV1,
  PendingApprovalSectionV1,
  PrincipalDelegationEntryV1,
  PrincipalDelegationOperationV1,
  PrincipalDelegationProjector,
  PrincipalDelegationReceiptV1,
  PrincipalSessionIdentityV1,
  ProcessTailV1,
  SessionFactEventEnvelopeV1,
  SessionFactEventV1,
  SemanticActionBindingV1,
  SourceVerifiedDossierV1,
  ToolAttemptOutcomeV1,
  ToolAttemptV1,
  ToolExecutionFactRecordV1,
  ToolRequestKeyV1,
  ToolRequestRefV1,
  ToolTrajectorySectionV1,
} from './domain/dossier.js'

export {
  APPROVAL_PROTOCOL_VERSION,
  REVIEWER_PROVIDER,
  approvalReviewPacketContent,
  approvalReviewRequestContent,
  createActionSnapshot,
  createApprovalReviewRequest,
  createReviewerProviderData,
  fingerprintReviewerConfiguration,
  hashAction,
  parseActionSnapshot,
  parseApprovalDecision,
  parseApprovalReviewRequest,
  parseReviewerProviderData,
  resolveApprovalDecision,
} from './domain/protocol.js'
export type {
  ActionSemanticsV1,
  ActionSnapshot,
  ActionSnapshotInput,
  ApprovalDecision,
  ApprovalDecisionKind,
  DecisionAuthorizationAssessmentV1,
  SandboxDenialRelationV1,
  ApprovalOutcome,
  ApprovalResolution,
  ApprovalReviewRequest,
  ApprovalRisk,
  CreateApprovalReviewOptions,
  RequestedPermission,
  RequestedPermissionKind,
  ReviewerConfiguration,
  ReviewerModelRoute,
  ReviewerProviderDataV1,
  ReviewerTextBlock,
  ReviewMode,
  UserAuthorization,
} from './domain/protocol.js'

export { assessVerifiedActionV1, permitsAutomaticFastPath, RISK_RULES_V1, validateDecisionAssessmentV1 } from './domain/risk-assessment.js'
export type { AssessVerifiedActionOptionsV1, AuthorizationAssessmentV1, DangerEscalationRiskV1, DirectUserAuthorizationEvidenceV1, RiskAssessmentV1, RiskCategoryV1, RiskEvidenceV1, RiskRuleV1, DecisionAssessmentValidityV1 } from './domain/risk-assessment.js'

// Application services (no DSH imports).
export {
  DefaultDecisionChannel,
  ReviewProtocolError,
} from './application/decision-channel.js'
export {
  DefaultExtractionChannel,
} from './application/extraction-channel.js'
export type {
  AuthorizationExtractionRequest,
  ExtractionChannel,
  ExtractionSubmissionContext,
  SubmitExtractionResult,
} from './application/extraction-channel.js'
export type {
  DecisionChannel,
  DecisionSubmissionContext,
  ReviewClock,
  ReviewFailureCode,
  SubmitDecisionResult,
} from './application/decision-channel.js'
export { SerialLanes } from './application/serial-lanes.js'
export {
  DefaultReviewerDirectory,
} from './application/reviewer-directory.js'
export type { ReviewerDirectory } from './application/reviewer-directory.js'
export {
  DefaultReviewCoordinator,
} from './application/review-coordinator.js'
export type { ReviewCoordinator, ReviewCoordinatorOptions, ReviewExecutionSummaryV1, ReviewOutcomeV1 } from './application/review-coordinator.js'

// Ports.
export type {
  ParentAuthority,
  ManagedOwnedReviewer,
  ManagedReviewerPort,
} from './ports/managed-reviewer.js'
export {
  DefaultActionCapture,
} from './ports/action-projector.js'
export type {
  ActionCapture,
  ActionProjector,
} from './ports/action-projector.js'
export { ToolFamilyActionProjectorRegistry } from './ports/tool-family-action-projector.js'
export type { ToolFamilyActionProjector } from './ports/tool-family-action-projector.js'

// Approval-gate ports (DSH-neutral).
export { fingerprintApprovalToolCatalogV1 } from './approval-gate/catalog.js'
export type {
  AllowCacheKeyV1,
  AllowCacheV1,
  ApprovalToolCatalog,
  ExactDenialBreakerKeyV1,
  ExactDenialBreakerV1,
  GateMachineDecisionV1,
  GateMachinePolicyV1,
  GateMachineRequestV1,
  SealedDispositionKind,
  SealedDispositionLookupV1,
  SealedDispositionRegistryV1,
  SealedDispositionV1,
  ToolApprovalClass,
  ToolApprovalClassificationResult,
  ToolApprovalClassifier,
  ToolApprovalDescriptor,
  TrustEnvelopeConfigV1,
  TrustEnvelopeEvaluationV1,
  TrustEnvelopeEvaluatorV1,
  TrustEnvelopeInputV1,
  TrustEnvelopeRejectReasonV1,
  TrustEnvelopeToolFamily,
} from './approval-gate/index.js'

// Reviewer composition (real DSH types).
export {
  REVIEWER_SECTION,
  createReviewerProvider,
} from './reviewer/provider.js'
export type { ReviewerProviderOptions } from './reviewer/provider.js'
export {
  REVIEWER_DECISION_PARAMETERS,
  REVIEWER_DECISION_PARAMETERS_V2,
  REVIEWER_POLICY_VERSION,
  REVIEWER_POLICY_VERSION_V2,
  REVIEWER_POLICY_VERSION_V3,
  REVIEWER_POLICY_VERSION_V4,
  createPolicyRegistry,
  createReviewerPolicyV1,
  createReviewerPolicyV2,
  createReviewerPolicyV3,
  createReviewerPolicyV4,
  dangerFullAccessRiskForPolicy,
} from './reviewer/policy.js'
export type { PolicyRegistry, ReviewerPolicy } from './reviewer/policy.js'
export {
  SUBMIT_DECISION_TOOL,
  createDecisionTool,
} from './reviewer/decision-tool.js'
export type { DecisionSubmitter, ScopedDecisionTool } from './reviewer/decision-tool.js'
export {
  EXTRACTION_SUBMISSION_PARAMETERS,
  SUBMIT_EXTRACTION_TOOL,
  createExtractionTool,
} from './reviewer/extraction-tool.js'
export type {
  ExtractionSubmitter,
  ScopedExtractionTool,
} from './reviewer/extraction-tool.js'
export {
  AUTHORIZATION_EXTRACTOR_SYSTEM_PROMPT,
  EXTRACTOR_SECTION,
  createExtractorProvider,
} from './reviewer/extractor-provider.js'
export type { ExtractorProviderOptions } from './reviewer/extractor-provider.js'

// DSH adapters.
export { createManagedReviewerPort } from './dsh/managed-controller.js'
export {
  createCaptureBridge,
  createDefaultActionProjector,
  createFilesystemActionProjector,
  createNetworkActionProjector,
  createShellProcessActionProjector,
} from './dsh/action-capture.js'
export type { CaptureBridge, FilesystemToolNames, NetworkToolNames } from './dsh/action-capture.js'
export {
  DSH_ALPHA2_ARGUMENT_SEMANTICS_ID,
  DSH_ALPHA2_FILESYSTEM_FAMILY,
  DSH_ALPHA2_FILESYSTEM_PROJECTOR_ID,
  DSH_ALPHA2_NETWORK_FAMILY,
  DSH_ALPHA2_NETWORK_PROJECTOR_ID,
  DSH_ALPHA2_OPAQUE_FAMILY,
  DSH_ALPHA2_OPAQUE_PROJECTOR_ID,
  DSH_ALPHA2_SHELL_FAMILY,
  DSH_ALPHA2_SHELL_PROJECTOR_ID,
  createDshAlpha2DossierCatalog,
  createDshAlpha2StockProjectorRegistry,
  createDshAlpha2StockToolCatalog,
} from './dsh/stock-tools.js'
export {
  DshScopedEffectiveCatalogResolver,
  createDshAlpha2EffectiveCatalog,
} from './dsh/effective-tool-catalog.js'
export type { DshAlpha2EffectiveCatalog, ScopedToolSchemas } from './dsh/effective-tool-catalog.js'
export { DshExecutionFactProjectionBridge } from './dsh/execution-projection-bridge.js'
export { createMachinePolicyAdapter } from './dsh/machine-policy-adapter.js'
export { DshStorageDomainGateDecisionRecordStore } from './dsh/storage-domain-decision-record.js'
export { DshStorageDomainSealedFacts } from './dsh/storage-domain-sealed-facts.js'
export type { SealedFactWriteResult } from './dsh/storage-domain-sealed-facts.js'
export {
  DshStorageDomainApprovalSnapshotRepository,
  DshStorageDomainExecutionFactRepository,
  DshStorageDomainFactRepositories,
} from './dsh/storage-domain-fact-repositories.js'
export type { StorageDomainFacility, StorageDomainHandle, StorageDomainTable } from './dsh/storage-domain-decision-record.js'
export type {
  MachinePolicyAdapterOptions,
  PatchedApprovalRequestLike,
  PatchedMachineApprovalPolicyLike,
} from './dsh/machine-policy-adapter.js'

// Application gate pieces (DSH-neutral).
export { GateFailure, gateFailureOutcome, GATE_FAILURE_CODES } from './application/gate-failure.js'
export { ApprovalRunLifecycle } from './application/approval-run-lifecycle.js'
export type { GateFailureCode, GateFailureCorrelationV1 } from './application/gate-failure.js'
export {
  InMemoryAllowCache,
  InMemoryExactDenialBreaker,
} from './application/breaker.js'
export { InMemorySealedDispositionRegistry } from './application/sealed-decision.js'
export { createToolApprovalClassifier } from './application/tool-classifier.js'
export { createTrustEnvelopeEvaluator } from './application/trust-envelope.js'
export { DefaultPreReviewCoordinator } from './application/pre-review-coordinator.js'
export type {
  PreReviewCoordinator,
  PreReviewInput,
} from './application/pre-review-coordinator.js'
export { DefaultGatePipeline, parseGateDecisionRecord } from './application/gate-pipeline.js'
export type {
  GateActionFactResolver,
  GateActionFacts,
  GateDecisionRecord,
  GateDecisionRecordResult,
  GateDecisionRecordStore,
  GatePipeline,
  GatePipelineDependencies,
  GatePreReview,
  GatePreReviewInput,
} from './application/gate-pipeline.js'
export { InMemoryGateDecisionRecordStore } from './application/decision-record.js'
export { InMemoryReviewerTelemetry } from './application/reviewer-telemetry.js'
export type {
  ReviewerTelemetryFailureV1,
  ReviewerTelemetryObservationV1,
  ReviewerTelemetrySink,
  ReviewerTelemetrySnapshotV1,
} from './ports/reviewer-telemetry.js'
export { InMemoryGateFailureMetrics } from './application/gate-failure-metrics.js'
export type {
  GateFailureMetricsObservationV1,
  GateFailureMetricsSink,
  GateFailureMetricsSnapshotV1,
} from './ports/gate-failure-metrics.js'
export { InMemoryGateActionFactStore } from './application/capture-gate-facts.js'
export type { GateFactRegistration } from './application/capture-gate-facts.js'
export {
  DossierGateFactProjector,
  SourceBackedGateFactResolver,
  gateFailureCodeForUnavailableSubcode,
} from './application/source-backed-gate-facts.js'
export type {
  PendingSourceBackedAsk,
  SourceBackedFactProjector,
  SourceBackedGateFactResolverDependencies,
} from './application/source-backed-gate-facts.js'
export {
  InMemoryDecisionRecordStorageBackend,
  ReviewDecisionRecordStore,
} from './application/record-storage.js'
export { FileDecisionRecordStorageBackend } from './application/file-record-storage.js'
export { InMemoryCaseCaptureSink } from './application/case-capture.js'
export type {
  CaseCaptureSink,
  InMemoryCaseCaptureStats,
} from './application/case-capture.js'
export { DefaultDossierCompiler } from './application/dossier-compiler.js'
export { createSealedDossierCompiler } from './application/sealed-dossier-compiler.js'
export type {
  CompileSealed,
  SealedDossierCompileInputV1,
  SealedDossierCompilerOptions,
  SealedDossierCurrentFactsV1,
} from './application/sealed-dossier-compiler.js'
export {
  assembleRecentExcerpts,
  DEFAULT_MAX_RECENT_EXCERPT_EVENTS,
} from './application/recent-excerpts.js'
export type {
  AssembleRecentExcerptsInput,
  RecentExcerptEventView,
  RecentExcerptV1,
  RecentExcerptsResult,
} from './application/recent-excerpts.js'
export {
  InMemoryDossierCompilationMetrics,
  InstrumentedDossierCompiler,
} from './application/instrumented-dossier-compiler.js'
export type {
  DossierCompilationMetricsSink,
  DossierCompilationMetricsSnapshotV1,
  DossierCompilationObservationV1,
  DossierSectionAggregateV1,
} from './ports/dossier-compilation-metrics.js'
export { DefaultPrincipalDelegationProjector } from './application/delegation-projector.js'
export {
  AUTHORIZATION_LEDGER_VERSION,
  authorizationChainTipHash,
  authorizationEntryHash,
  authorizationLedgerKey,
  createAuthorizationEntryV1,
  createExtractionCheckpointV1,
  extractionCheckpointChainTipHash,
  extractionCheckpointHash,
  extractionInputHash,
  DEFAULT_MAX_AUTHORIZATION_ENTRIES,
  genesisAuthorizationHash,
  genesisExtractionCheckpointHash,
  MAX_AUTHORIZATION_QUOTE_BYTES,
  MAX_AUTHORIZATION_SUMMARY_BYTES,
  parseAuthorizationEntryV1,
  parseExtractionCheckpointV1,
} from './domain/authorization-ledger.js'
export type {
  AuthorizationCoverageV1,
  AuthorizationEffectV1,
  AuthorizationEntryV1,
  ExtractionCheckpointV1,
} from './domain/authorization-ledger.js'
export {
  AUTHORIZATION_EXTRACTOR_VERSION,
  EXTRACTION_PROVIDER,
  EXTRACTION_PROTOCOL_VERSION,
  createExtractorProviderData,
  fingerprintExtractorConfiguration,
  parseAuthorizationExtractionSubmissionV1,
  parseExtractorProviderData,
} from './domain/extraction-protocol.js'
export type {
  AuthorizationExtractionSubmissionV1,
  ExtractedAuthorizationCandidateV1,
  ExtractorProviderDataV1,
} from './domain/extraction-protocol.js'
export {
  collectAuthorizationInputWindow,
  DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS,
  verifyAuthorizationEntriesLiveV1,
  verifyAuthorizationEntryLiveV1,
} from './application/authorization-verification.js'
export type {
  AuthorizationEventAt,
  AuthorizationInputItemV1,
  AuthorizationInputWindowV1,
  AuthorizationLiveEventView,
} from './application/authorization-verification.js'
export { DefaultAuthorizationExtractionCoordinator } from './application/authorization-extraction-coordinator.js'
export type {
  AuthorizationExtractionCoordinator,
  AuthorizationExtractionCoordinatorOptions,
  AuthorizationExtractionStatus,
} from './application/authorization-extraction-coordinator.js'
export { DshStorageDomainAuthorizationLedger } from './dsh/storage-domain-authorization-ledger.js'
export type { AuthorizationLedgerWriteResult } from './dsh/storage-domain-authorization-ledger.js'
export { extractUserText } from './application/recent-excerpts.js'
export { DshParentSessionFactSource, deriveRequesterDepthV1, readSealedParentSessionFacts } from './dsh/parent-session-fact-source.js'
export type { RequesterDepthEvidenceV1, SealedFactsReadResult, SealedFactsUnavailableSubcodeV1, SealedParentSessionFactsV1 } from './dsh/parent-session-fact-source.js'
export type { LiveAgentRegistry, ParentSessionFactSource } from './ports/parent-session-facts.js'
export {
  InMemoryApprovalSnapshotRepository,
  InMemoryExecutionFactRepository,
} from './application/fact-repositories.js'
export type {
  ApprovalSnapshotRepository,
  ExecutionFactRepository,
} from './application/fact-repositories.js'
export type {
  DecisionRecordStorageBackend,
  DecisionRecordStore,
  StorageWriteResult,
} from './application/record-storage.js'

// Cordis plugin entry, loader config, and live user-settings projection.
export {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
  ApproveForMeSettings,
  Config,
  configWithReviewerSettings,
  inject,
  name,
  normalizeConfig,
  reviewerSettingsFromConfig,
} from './config.js'
export type {
  ApproveForMeSettings as ApproveForMeSettingsValue,
  Config as ApproveForMeConfig,
  NormalizedConfig,
} from './config.js'
export {
  apply,
  installApproveForMe,
} from './plugin.js'
export type { ApproveForMeInstallOptions, ApproveForMePlugin } from './plugin.js'
export { resolveReviewerModelRouteFromDshCatalog } from './dsh/reviewer-model-catalog.js'
export type {
  ResolvedReviewerModelRoute,
  ReviewerModelCatalog,
} from './dsh/reviewer-model-catalog.js'
