import { describe, expect, it } from 'vitest'
import {
  activityClassificationFromDescriptorV1,
  canonicalJson,
  createActionSnapshot,
  DSH_ALPHA2_SHELL_FAMILY,
  DSH_ALPHA2_SHELL_PROJECTOR_ID,
  genesisSealHash,
  hashAction,
  matchApprovalSnapshotsForExecutionV1,
  projectSealForResultV1,
} from '../../src/index.js'
import type { ApprovalSnapshotRecordV1, ToolExecutionFactRecordV1 } from '../../src/index.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import { approvalE2ESchemas } from '../helpers/approval-e2e.js'

/*
 * WP8-c step 1: the shared seal/activity construction formula. These tests pin
 * the formula itself (construction correctness + ambiguity rejection); the
 * pre-existing execution-projection-bridge and sealed-facts suites (unchanged)
 * pin the live path against the same function, so formula drift fails twice.
 */

const schemas = [approvalE2ESchemas]

function buildFixture(command = 'ls') {
  const effective = createDshAlpha2EffectiveCatalog(schemas)
  const dossier = effective.dossier
  const lifecycle = Object.freeze({ sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 10 })
  const lifecycleFingerprint = canonicalJson(lifecycle)
  const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
  const descriptor = dossier.descriptors.find(item => item.toolName === 'bash')!
  const action = createActionSnapshot({
    toolName: 'bash',
    arguments: { command },
    projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
    semantics: {
      family: DSH_ALPHA2_SHELL_FAMILY,
      value: { operation: 'bash', command, description: 'run ' + command, cwd: '/workspace', runInBackground: false },
    },
    requestedPermissions: [],
  })
  const record: ToolExecutionFactRecordV1 = {
    version: 1,
    session: lifecycle,
    request: { kind: 'model-tool-call', eventSeq: 2, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
    catalogCommitment: commitment,
    toolClassification: { classificationCatalogFingerprint: dossier.fingerprint, descriptor },
    projection: { projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID, action, actionHash: hashAction(action), observedAt: 12 },
    result: { eventSeq: 4, eventType: 'tool/result', outcome: { kind: 'completed' } },
  }
  const approval = (requestId: string, askedSeq = 3): ApprovalSnapshotRecordV1 => Object.freeze({
    version: 1,
    session: lifecycle,
    approvalRequestId: requestId,
    approvalAskedSeq: askedSeq,
    execution: Object.freeze({
      requestEventSeq: 2,
      callId: 'call-1',
      toolName: 'bash',
      actionHash: hashAction(action),
      classificationCatalogFingerprint: dossier.fingerprint,
      projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
    }),
    environment: Object.freeze({ version: 1, kind: 'native-header-only' }),
  })
  // A genuinely different commitment (headerEventSeq 1) so the epoch-advance
  // branch observes a real fingerprint change; 1 < rootEventSeq keeps the
  // strict record parse valid.
  const nextCommitment = createDshAlpha2CatalogCommitment(effective, 'native', 1, schemas)
  return {
    lifecycle,
    lifecycleFingerprint,
    commitment,
    nextCommitment,
    descriptor,
    record,
    approval,
    action,
  }
}

describe('projectSealForResultV1 (WP8-c shared formula)', () => {
  it('constructs a genesis seal/activity pair bound to the unique asked snapshot', () => {
    const f = buildFixture()
    const projection = projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: f.record,
      approvals: [f.approval('ask-1')],
      prior: undefined,
      occurredAt: 104,
    })
    expect(projection).toBeDefined()
    expect(projection!.seal).toMatchObject({
      version: 1,
      lifecycleFingerprint: f.lifecycleFingerprint,
      sourceSeq: 2,
      request: { eventSeq: 2, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      approvalAsked: { eventSeq: 3, requestId: 'ask-1' },
      actionHash: hashAction(f.action),
      projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
      catalog: { epoch: 0, headerEventSeq: 0, commitment: f.commitment.fingerprint },
      result: { eventSeq: 4, status: 'completed' },
      epochBoundary: { previousEpoch: null, changed: false },
      previousSealHash: genesisSealHash(f.lifecycleFingerprint),
    })
    expect(projection!.activity).toMatchObject({
      lifecycleFingerprint: f.lifecycleFingerprint,
      sourceSeq: 2,
      occurredAt: 104,
      classification: activityClassificationFromDescriptorV1(f.descriptor),
      targetSummary: 'tool:bash',
      resultCategory: 'completed',
      sourceSealHash: projection!.seal.sealHash,
    })
  })

  it('continues the epoch for the same catalog commitment and advances it on change', () => {
    const f = buildFixture()
    const first = projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: f.record,
      approvals: [f.approval('ask-1')],
      prior: undefined,
      occurredAt: 104,
    })!
    const secondRecord: ToolExecutionFactRecordV1 = Object.freeze({
      ...f.record,
      request: Object.freeze({ kind: 'model-tool-call', eventSeq: 6, eventType: 'tool/call', callId: 'call-2', toolName: 'bash' }),
      projection: Object.freeze({ ...f.record.projection, observedAt: 16 }),
      result: Object.freeze({ eventSeq: 8, eventType: 'tool/result', outcome: Object.freeze({ kind: 'completed' }) }),
    })
    const secondApproval = Object.freeze({
      ...f.approval('ask-2', 7),
      execution: Object.freeze({ ...f.approval('ask-2', 7).execution, requestEventSeq: 6, callId: 'call-2' }),
    })
    const sameEpochSeal = projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: secondRecord,
      approvals: [secondApproval],
      prior: first.seal,
      occurredAt: 108,
    })!
    expect(sameEpochSeal.seal.catalog.epoch).toBe(0)
    expect(sameEpochSeal.seal.epochBoundary).toEqual({ previousEpoch: 0, changed: false })
    expect(sameEpochSeal.seal.previousSealHash).toBe(first.seal.sealHash)

    // A different catalog commitment advances the epoch and records the boundary.
    const changedCommitmentRecord: ToolExecutionFactRecordV1 = Object.freeze({
      ...secondRecord,
      catalogCommitment: f.nextCommitment,
      result: Object.freeze({ eventSeq: 9, eventType: 'tool/result', outcome: Object.freeze({ kind: 'completed' }) }),
    })
    const epochSeal = projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: changedCommitmentRecord,
      approvals: [secondApproval],
      prior: sameEpochSeal.seal,
      occurredAt: 109,
    })!
    expect(epochSeal.seal.catalog.epoch).toBe(1)
    expect(epochSeal.seal.catalog.commitment).toBe(f.nextCommitment.fingerprint)
    expect(epochSeal.seal.epochBoundary).toEqual({ previousEpoch: 0, changed: true })
    expect(epochSeal.seal.previousSealHash).toBe(sameEpochSeal.seal.sealHash)
  })

  it.each([
    ['tool-error', Object.freeze({ kind: 'tool-error' }), 'tool-error'],
    ['sandbox-denied', Object.freeze({ kind: 'sandbox-denied', mode: 'read-only' }), 'sandbox-denied'],
  ] as const)('maps the %s outcome category onto seal and activity', (_name, outcome, status) => {
    const f = buildFixture()
    const record: ToolExecutionFactRecordV1 = Object.freeze({
      ...f.record,
      result: Object.freeze({ eventSeq: 4, eventType: 'tool/result', outcome }),
    })
    const projection = projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record,
      approvals: [f.approval('ask-1')],
      prior: undefined,
      occurredAt: 104,
    })
    expect(projection).toBeDefined()
    expect(projection!.seal.result.status).toBe(status)
    expect(projection!.activity.resultCategory).toBe(status)
  })

  it('rejects zero or multiple matching approval snapshots (ambiguity fails closed)', () => {
    const f = buildFixture()
    const base = {
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: f.record,
      prior: undefined,
      occurredAt: 104,
    }
    expect(projectSealForResultV1({ ...base, approvals: [] })).toBeUndefined()
    expect(projectSealForResultV1({ ...base, approvals: [f.approval('ask-1'), f.approval('ask-2', 5)] })).toBeUndefined()
  })

  it('rejects a result-less record and an invalid occurredAt', () => {
    const f = buildFixture()
    const { result: _ignoredResult, ...resultLessRest } = f.record
    void _ignoredResult
    const resultLess: ToolExecutionFactRecordV1 = resultLessRest
    expect(projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: resultLess,
      approvals: [f.approval('ask-1')],
      prior: undefined,
      occurredAt: 104,
    })).toBeUndefined()
    expect(projectSealForResultV1({
      lifecycleFingerprint: f.lifecycleFingerprint,
      record: f.record,
      approvals: [f.approval('ask-1')],
      prior: undefined,
      occurredAt: -1,
    })).toBeUndefined()
  })

  it('only matches snapshots bound on every identity field', () => {
    const f = buildFixture()
    const matched = f.approval('ask-1')
    expect(matchApprovalSnapshotsForExecutionV1(f.record, [matched])).toHaveLength(1)
    const perturbations: Array<ApprovalSnapshotRecordV1> = [
      Object.freeze({ ...matched, execution: Object.freeze({ ...matched.execution, callId: 'other-call' }) }),
      Object.freeze({ ...matched, execution: Object.freeze({ ...matched.execution, toolName: 'other-tool' }) }),
      Object.freeze({ ...matched, execution: Object.freeze({ ...matched.execution, requestEventSeq: 99 }) }),
      Object.freeze({ ...matched, execution: Object.freeze({ ...matched.execution, actionHash: 'sha256:' + '0'.repeat(64) }) }),
      Object.freeze({ ...matched, execution: Object.freeze({ ...matched.execution, projectorId: 'other-projector' }) }),
      Object.freeze({ ...matched, execution: Object.freeze({ ...matched.execution, classificationCatalogFingerprint: 'other-catalog' }) }),
    ]
    for (const perturbed of perturbations) {
      expect(matchApprovalSnapshotsForExecutionV1(f.record, [perturbed])).toHaveLength(0)
    }
  })
})
