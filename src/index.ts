// Domain protocol and JSON helpers.
export {
  JsonSnapshotError,
  canonicalJson,
  freezeJson,
  snapshotJson,
} from './domain/json.js'
export type { JsonPrimitive, JsonValue } from './domain/json.js'
export {
  DECISION_PAYLOAD_HASH_DOMAIN,
  DECISION_TOOL_SCHEMA_HASH_DOMAIN,
  DOSSIER_HASH_DOMAIN,
  PACKET_HASH_DOMAIN,
  POLICY_ARTIFACT_HASH_DOMAIN,
  artifactBytes,
  caseArtifactKey,
  createApprovalReviewPacketV1,
  hashApprovalDecisionPayload,
  hashApprovalReviewPacket,
  hashDecisionToolSchema,
  hashGuardianDossier,
  hashGuardianPolicyArtifact,
  parseApprovalReviewPacketV1,
  parseGuardianCaseArtifactV1,
  parseGuardianPolicyArtifactV1,
  parseReviewDecisionRecord,
  reviewRecordKey,
  validateCaseCaptureConfig,
} from './domain/records.js'
export type {
  ApprovalReviewPacketV1,
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
  recomputeDossierHash,
  sealSourceVerifiedDossier,
  validateDelegationToolCatalog,
  validateToolTrajectorySection,
} from './domain/dossier.js'
export type {
  ApprovalReviewPacketCodecV1,
  ApprovalSnapshotRecordV1,
  CodeDispatchRequestRefV1,
  DelegationReceiptFactRecordV1,
  DossierCompilationResultV1,
  DossierMetricsV1,
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
  ActionSnapshot,
  ActionSnapshotInput,
  ApprovalDecision,
  ApprovalDecisionKind,
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

// Application services (no DSH imports).
export {
  DefaultDecisionChannel,
  ReviewProtocolError,
} from './application/decision-channel.js'
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
export type { ReviewCoordinator, ReviewCoordinatorOptions } from './application/review-coordinator.js'

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

// Approval-gate ports (DSH-neutral).
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
  REVIEWER_POLICY_VERSION,
  createPolicyRegistry,
  createReviewerPolicyV1,
} from './reviewer/policy.js'
export type { PolicyRegistry, ReviewerPolicy } from './reviewer/policy.js'
export {
  SUBMIT_DECISION_TOOL,
  createDecisionTool,
} from './reviewer/decision-tool.js'
export type { DecisionSubmitter, ScopedDecisionTool } from './reviewer/decision-tool.js'

// DSH adapters.
export { createManagedReviewerPort } from './dsh/managed-controller.js'
export {
  createCaptureBridge,
  createDefaultActionProjector,
} from './dsh/action-capture.js'
export type { CaptureBridge } from './dsh/action-capture.js'
export { createApprovalAnswerer } from './dsh/approval-answerer.js'
export type { ApprovalAnswerer, ApprovalAnswererOptions } from './dsh/approval-answerer.js'
export { createMachinePolicyAdapter } from './dsh/machine-policy-adapter.js'
export type {
  MachinePolicyAdapterOptions,
  PatchedApprovalRequestLike,
  PatchedMachineApprovalPolicyLike,
} from './dsh/machine-policy-adapter.js'

// Application gate pieces (DSH-neutral).
export { createDelegatingGate } from './application/delegating-gate.js'
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
export { DefaultGatePipeline } from './application/gate-pipeline.js'
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
export { InMemoryGateActionFactStore } from './application/capture-gate-facts.js'
export type { GateFactRegistration } from './application/capture-gate-facts.js'
export {
  InMemoryDecisionRecordStorageBackend,
  ReviewDecisionRecordStore,
} from './application/record-storage.js'
export { InMemoryCaseCaptureSink } from './application/case-capture.js'
export type {
  CaseCaptureSink,
  InMemoryCaseCaptureStats,
} from './application/case-capture.js'
export { DefaultDossierCompiler } from './application/dossier-compiler.js'
export type {
  DecisionRecordStorageBackend,
  DecisionRecordStore,
  StorageWriteResult,
} from './application/record-storage.js'

// Cordis plugin entry and serializable config.
export { Config, inject, name, normalizeConfig } from './config.js'
export type { Config as ApproveForMeConfig, NormalizedConfig } from './config.js'
export {
  apply,
  installApproveForMe,
} from './plugin.js'
export type { ApproveForMeInstallOptions, ApproveForMePlugin } from './plugin.js'
