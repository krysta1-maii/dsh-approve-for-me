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

const hash = (char: string) => `sha256:${char.repeat(64)}`
const session: SessionLifecycleIdentityV1 = { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000 }

function executionFact(): ToolExecutionFactRecordV1 {
  return {
    version: 1,
    session,
    request: { kind: 'model-tool-call', eventSeq: 5, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
    toolClassification: {
      classificationCatalogFingerprint: hash('c'),
      descriptor: { classification: 'ordinary', toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' },
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
    environment: { version: 1, sessionId: 'parent-1' },
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

  it('attaches only the matching durable result once and detects conflicts', async () => {
    const repo = new InMemoryExecutionFactRepository()
    await repo.create(executionFact())
    const result = { eventSeq: 6, eventType: 'tool/result' as const }
    await expect(repo.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('updated')
    await expect(repo.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result })).resolves.toBe('identical')
    await expect(repo.attachResult({ session, callId: 'call-1', requestEventSeq: 5, result: { eventSeq: 7, eventType: 'tool/result' } })).resolves.toBe('conflict')
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
      environment: { version: 1, sessionId: 'parent-other' },
    })).resolves.toBe('conflict')
    // Original row is not overwritten.
    await expect(repo.get({ session, approvalRequestId: 'ask-1', approvalAskedSeq: 5 })).resolves.toEqual(approvalSnapshot())
  })
})
