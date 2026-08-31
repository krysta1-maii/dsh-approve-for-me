import { describe, expect, it } from 'vitest'
import {
  InMemoryApprovalSnapshotRepository,
  InMemoryExecutionFactRepository,
  createActionSnapshot,
} from '../../src/index.js'
import type {
  ApprovalSnapshotRecordV1,
  SessionLifecycleIdentityV1,
  ToolExecutionFactRecordV1,
} from '../../src/index.js'
import { createDshAlpha1CatalogCommitment, createDshAlpha1EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const session: SessionLifecycleIdentityV1 = { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 }
const schemas = [{ name: 'bash', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
const effective = createDshAlpha1EffectiveCatalog(schemas)
const commitment = createDshAlpha1CatalogCommitment(effective, 'native', 0, schemas)

function executionFact(): ToolExecutionFactRecordV1 {
  return {
    version: 1,
    catalogCommitment: commitment,
    session,
    request: { kind: 'model-tool-call', eventSeq: 5, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
    toolClassification: {
      classificationCatalogFingerprint: effective.dossier.fingerprint,
      descriptor: effective.dossier.descriptors[0]!,
    },
    projection: {
      projectorId: 'default-v1',
      action: createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } }),
      actionHash: hash('a'),
      observedAt: 1,
    },
  }
}

function approvalSnapshot(): ApprovalSnapshotRecordV1 {
  return {
    version: 1,
    session,
    approvalRequestId: 'ask-1',
    approvalAskedSeq: 5,
    execution: { requestEventSeq: 5, callId: 'call-1', toolName: 'bash', actionHash: hash('a'), classificationCatalogFingerprint: effective.dossier.fingerprint, projectorId: 'default-v1' },
    environment: { version: 1, kind: 'native-header-only' },
  }
}

describe('in-memory fact repositories', () => {
  it('stores and reads execution facts by session/callId/seq', async () => {
    const repo = new InMemoryExecutionFactRepository()
    await expect(repo.create(executionFact())).resolves.toBe('created')
    await expect(repo.create(executionFact())).resolves.toBe('identical')
    await expect(repo.get({ session, callId: 'call-1', requestEventSeq: 5 })).resolves.toEqual(executionFact())
    await expect(repo.get({ session, callId: 'missing', requestEventSeq: 5 })).resolves.toBeUndefined()
  })

  it('isolates records that reuse a session id across lifecycle identities', async () => {
    const executions = new InMemoryExecutionFactRepository()
    const approvals = new InMemoryApprovalSnapshotRepository()
    const reused: SessionLifecycleIdentityV1 = { ...session, cwd: '/other-project' }
    await executions.create(executionFact())
    await approvals.create(approvalSnapshot())
    await expect(executions.get({ session: reused, callId: 'call-1', requestEventSeq: 5 })).resolves.toBeUndefined()
    await expect(approvals.get({ session: reused, approvalRequestId: 'ask-1', approvalAskedSeq: 5 })).resolves.toBeUndefined()
    await expect(executions.list(session)).resolves.toEqual([executionFact()])
    await expect(approvals.list(reused)).resolves.toEqual([])
  })

  it('attaches only the matching durable result once and detects conflicts', async () => {
    const repo = new InMemoryExecutionFactRepository()
    await repo.create(executionFact())
    const result = { eventSeq: 6, eventType: 'tool/result' as const, outcome: { kind: 'completed' as const } }
    await expect(repo.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('updated')
    await expect(repo.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('identical')
    await expect(repo.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result: { eventSeq: 7, eventType: 'tool/result', outcome: { kind: 'completed' } } })).resolves.toBe('conflict')
    await expect(repo.attachResult({ session, callId: 'missing', requestEventSeq: 5, result })).resolves.toBe('missing')
  })

  it('creates and reads approval snapshots idempotently', async () => {
    const repo = new InMemoryApprovalSnapshotRepository()
    await expect(repo.create(approvalSnapshot())).resolves.toBe('created')
    await expect(repo.create(approvalSnapshot())).resolves.toBe('identical')
    await expect(repo.get({ session, approvalRequestId: 'ask-1', approvalAskedSeq: 5 })).resolves.toEqual(approvalSnapshot())
  })

  it('reports a conflict instead of claiming success for a contradicting snapshot', async () => {
    const repo = new InMemoryApprovalSnapshotRepository()
    await repo.create(approvalSnapshot())
    await expect(repo.create({
      ...approvalSnapshot(),
      execution: { ...approvalSnapshot().execution, projectorId: 'other-v1' },
    })).resolves.toBe('conflict')
    // Original row is not overwritten.
    await expect(repo.get({ session, approvalRequestId: 'ask-1', approvalAskedSeq: 5 })).resolves.toEqual(approvalSnapshot())
  })
})
