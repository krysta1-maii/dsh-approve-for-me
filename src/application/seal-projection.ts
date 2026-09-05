import {
  activityClassificationFromDescriptorV1,
  createActivityV1,
  createSealV1,
  genesisSealHash,
} from '../domain/sealed-facts.js'
import type { ActivityV1, SealResultStatusV1, SealV1 } from '../domain/sealed-facts.js'
import type { ApprovalSnapshotRecordV1, ToolExecutionFactRecordV1 } from '../domain/dossier.js'

/**
 * WP8-c step 1: the single seal/activity construction formula shared by the
 * live capture bridge (execution-projection-bridge appendSealForResult) and the
 * phase-three background-once backfill (seal-backfill.ts). Keeping one pure
 * function is the hard guarantee that a backfilled seal is byte-identical to
 * the seal the live path would have written: any formula drift breaks the
 * existing sealed-facts/bridge tests before it can diverge at runtime.
 *
 * The function is deliberately total-fail: any ambiguity (zero or multiple
 * matching approval snapshots), a result-less record, an invalid occurredAt,
 * or any shape the strict V1 parsers reject degrades to undefined so the
 * caller fails closed instead of promoting a guess into the ledger.
 */

/**
 * The one binding-authority predicate: an approval snapshot binds this exact
 * execution only when requestEventSeq, callId, toolName, actionHash,
 * projectorId and classification catalog fingerprint are all equal. This is the
 * same filter the live bridge used inline (WP4); zero or more than one match
 * is ambiguity and must never be resolved by picking one.
 */
export function matchApprovalSnapshotsForExecutionV1(
  record: ToolExecutionFactRecordV1,
  snapshots: readonly ApprovalSnapshotRecordV1[],
): readonly ApprovalSnapshotRecordV1[] {
  return Object.freeze(snapshots.filter(snapshot =>
    snapshot.execution.requestEventSeq === record.request.eventSeq
    && snapshot.execution.callId === record.request.callId
    && snapshot.execution.toolName === record.request.toolName
    && snapshot.execution.actionHash === record.projection.actionHash
    && snapshot.execution.projectorId === record.projection.projectorId
    && snapshot.execution.classificationCatalogFingerprint === record.toolClassification.classificationCatalogFingerprint))
}

export interface SealProjectionV1 {
  readonly seal: SealV1
  readonly activity: ActivityV1
}

export interface SealProjectionInputV1 {
  /** Canonical lifecycle fingerprint the chain is keyed under. */
  readonly lifecycleFingerprint: string
  /** Strictly parsed (shape V1) execution fact with its durable result attached. */
  readonly record: ToolExecutionFactRecordV1
  /** Every approval snapshot for this lifecycle; uniqueness is enforced here. */
  readonly approvals: readonly ApprovalSnapshotRecordV1[]
  /** Previous chain-tip seal; undefined starts a new chain at genesis. */
  readonly prior: SealV1 | undefined
  /** Result-event time taken from the live Session (Host clock rule). */
  readonly occurredAt: number
}

/**
 * Construct the seal/activity pair for one approval-bound result exactly as the
 * live capture path does: epoch advances only when the catalog commitment
 * changes, the epoch boundary records the transition, the previous hash links
 * to the chain tip (or genesis), and the activity stays deliberately generic
 * (`tool:<name>`, bounded categories — never ids, arguments, or model text).
 * Returns undefined on any ambiguity or invalid input.
 */
export function projectSealForResultV1(input: SealProjectionInputV1): SealProjectionV1 | undefined {
  try {
    const { lifecycleFingerprint, record, prior, occurredAt } = input
    if (record.result === undefined || !Number.isSafeInteger(occurredAt) || occurredAt < 0) return undefined
    const asked = matchApprovalSnapshotsForExecutionV1(record, input.approvals)
    // An approval snapshot is the only binding authority. No ask, ambiguity, or
    // capture/catalog mismatch can be promoted into the execution ledger.
    if (asked.length !== 1 || asked[0] === undefined) return undefined
    const sameEpoch = prior?.catalog.commitment === record.catalogCommitment.fingerprint
    const epoch = prior === undefined ? 0 : sameEpoch ? prior.catalog.epoch : prior.catalog.epoch + 1
    const classification = activityClassificationFromDescriptorV1(record.toolClassification.descriptor)
    const status: SealResultStatusV1 = record.result.outcome.kind === 'sandbox-denied'
      ? 'sandbox-denied'
      : record.result.outcome.kind === 'tool-error' ? 'tool-error' : 'completed'
    const seal = createSealV1({
      lifecycleFingerprint,
      sourceSeq: record.request.eventSeq,
      request: {
        eventSeq: record.request.eventSeq,
        eventType: record.request.eventType,
        callId: record.request.callId,
        toolName: record.request.toolName,
      },
      approvalAsked: { eventSeq: asked[0].approvalAskedSeq, requestId: asked[0].approvalRequestId },
      actionHash: record.projection.actionHash,
      projectorId: record.projection.projectorId,
      catalog: {
        epoch,
        headerEventSeq: record.catalogCommitment.requestHeaderEventSeq,
        commitment: record.catalogCommitment.fingerprint,
      },
      wireSchemaFingerprint: record.toolClassification.descriptor.toolSchemaFingerprint,
      result: { eventSeq: record.result.eventSeq, status },
      epochBoundary: { previousEpoch: prior?.catalog.epoch ?? null, changed: prior !== undefined && !sameEpoch },
      previousSealHash: prior?.sealHash ?? genesisSealHash(lifecycleFingerprint),
    })
    // Deliberately generic and bounded: never derive an ID, argument, result body, or model text.
    const activity = createActivityV1({
      lifecycleFingerprint,
      sourceSeq: record.request.eventSeq,
      occurredAt,
      classification,
      targetSummary: `tool:${record.request.toolName}`,
      resultCategory: status,
      sourceSealHash: seal.sealHash,
    })
    return Object.freeze({ seal, activity })
  } catch {
    return undefined
  }
}
