import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParentAuthority } from '../../src/ports/managed-reviewer.js'
import { DossierGateFactProjector, SourceBackedGateFactResolver, fingerprintGateConfigurationV1 } from '../../src/application/source-backed-gate-facts.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import { createActionSnapshot, hashAction } from '../../src/domain/protocol.js'

const agent = { id: 'session-1', session: { id: 'session-1' } } as unknown as Agent
const authority = { sessionId: 'session-1' } as unknown as ParentAuthority<Agent, string>
const reviewerConfigurationFingerprint = `sha256:${'9'.repeat(64)}`
const request = {
  requestId: 'ask-1', parentSessionId: 'session-1', callId: 'call-1',
  toolName: 'bash', actionHash: 'hash-1', mode: 'auto' as const,
}

function resolver() {
  const snapshot = vi.fn()
  const compile = vi.fn()
  const snapshotInput = vi.fn()
  return {
    snapshot, compile, snapshotInput,
    resolver: new SourceBackedGateFactResolver({
      factSource: { snapshot } as never,
      compiler: { compile } as never,
      projector: { project: vi.fn() },
      snapshotInput,
    }),
  }
}

describe('DossierGateFactProjector', () => {
  it('rebuilds cache scope from branded direct-user evidence only', () => {
    const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
    const actionHash = hashAction(action)
    const schemas = [{ name: 'bash', description: 'bash schema', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
    const effective = createDshAlpha2EffectiveCatalog(schemas)
    const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
    const projector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v2')
    const projectInput = {
      request: { ...request, actionHash }, pending: { ...request, actionHash, agent, authority },
      facts: {
        session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1, effectiveDelegationDepth: 0 },
        approvalBinding: { event: { seq: 2, type: 'approval/asked' }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' },
        approvalSnapshots: [{
          version: 1,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          approvalRequestId: 'ask-1', approvalAskedSeq: 2,
          execution: { requestEventSeq: 1, callId: 'call-1', toolName: 'bash', actionHash, classificationCatalogFingerprint: effective.dossier.fingerprint, projectorId: action.projectorId },
          environment: { version: 1, kind: 'native-header-only' },
        }],
        executionFacts: [{
          version: 1, catalogCommitment: commitment,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          request: { kind: 'model-tool-call', eventSeq: 1, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
          toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0] },
          projection: { projectorId: action.projectorId, action, actionHash, observedAt: 1 },
        }],
        eventProjection: { classificationCatalog: effective.dossier },
      },
      verifiedDossier: {
        dossier: {
          freeze: { currentTurn: 3 },
          environment: { requestHeader: { tools: schemas } },
          interaction: { delegations: { entries: [] }, turns: [{ turn: 3, directUserMessages: [{ event: { seq: 7 }, content: [{ type: 'text', text: 'Run pwd.' }], surfaceState: 'visible' }] }] },
          currentTurnTools: { attempts: [{
            request: { kind: 'model-tool-call', issuedIn: { seq: 0 }, blockIndex: 0, callId: 'call-1', toolName: 'bash', rawArguments: '{"command":"pwd"}', callEvent: { seq: 1 } },
            outcome: { kind: 'pending' },
          }] },
          pendingApproval: { callId: 'call-1', toolName: 'bash', action, actionHash, confinement: { kind: 'unconfined-composition' }, earlierSandboxDenials: [] },
        },
      },
    }
    const facts = projector.project(projectInput as never)
    expect(facts).toMatchObject({ rootRequester: true, breakerKey: { turn: 3, directUserFrontierSeq: 7, actionHash }, policyVersion: 'policy-v2' })
    expect(facts?.classification).toEqual({ kind: 'classified', classification: 'body-escalation' })
    expect(facts?.configurationFingerprint).toBe(fingerprintGateConfigurationV1(reviewerConfigurationFingerprint, commitment.fingerprint))
    expect(facts?.assessment).toMatchObject({ authorization: { level: 'absent', sourceRefs: ['event:7'] } })

    const consumedByDelegation = projector.project({
      ...projectInput,
      verifiedDossier: {
        ...projectInput.verifiedDossier,
        dossier: {
          ...projectInput.verifiedDossier.dossier,
          interaction: {
            ...projectInput.verifiedDossier.dossier.interaction,
            delegations: { entries: [{ attempt: {
              request: { kind: 'model-tool-call', issuedIn: { seq: 8 }, blockIndex: 0, callId: 'delegate-1', toolName: 'subagent', rawArguments: '{}', callEvent: { seq: 8 } },
              outcome: { kind: 'completed' },
            } }] },
          },
        },
      },
    } as never)
    expect(consumedByDelegation).toMatchObject({
      assessment: { authorization: { level: 'unknown', targetCovered: false, sideEffectsCovered: false, sourceRefs: ['event:7'] } },
    })

    const retryJustification = 'Retry the exact sandbox-denied command.'
    const retryAction = createActionSnapshot({
      toolName: 'bash',
      arguments: { command: 'pwd', sandbox_permissions: 'workspace-write', justification: retryJustification },
      requestedPermissions: [{ kind: 'sandbox', scope: 'workspace-write', details: { justification: retryJustification } }],
    })
    const retryActionHash = hashAction(retryAction)
    const directive = `/approve-for-me ${JSON.stringify({
      version: 1,
      scope: 'next-action',
      allow: { toolName: 'bash', arguments: retryAction.arguments, requestedPermissions: retryAction.requestedPermissions },
    })}`
    const sandboxRetry = projector.project({
      request: { ...request, actionHash: retryActionHash },
      pending: { ...request, actionHash: retryActionHash, agent, authority },
      facts: {
        ...projectInput.facts,
        approvalBinding: { event: { seq: 11, type: 'approval/asked' }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' },
        approvalSnapshots: [{
          ...projectInput.facts.approvalSnapshots[0],
          approvalAskedSeq: 11,
          execution: { ...projectInput.facts.approvalSnapshots[0]!.execution, requestEventSeq: 10, actionHash: retryActionHash, projectorId: retryAction.projectorId },
        }],
        executionFacts: [{
          ...projectInput.facts.executionFacts[0]!,
          request: { ...projectInput.facts.executionFacts[0]!.request, eventSeq: 10 },
          projection: { ...projectInput.facts.executionFacts[0]!.projection, projectorId: retryAction.projectorId, action: retryAction, actionHash: retryActionHash },
        }],
      },
      verifiedDossier: {
        dossier: {
          ...projectInput.verifiedDossier.dossier,
          interaction: {
            delegations: { entries: [] },
            turns: [{ turn: 3, directUserMessages: [{ event: { seq: 7 }, content: [{ type: 'text', text: directive }], surfaceState: 'visible' }] }],
          },
          currentTurnTools: { attempts: [{
            request: { kind: 'model-tool-call', issuedIn: { seq: 8 }, blockIndex: 0, callId: 'denied-1', toolName: 'bash', rawArguments: '{"command":"pwd"}', callEvent: { seq: 8 } },
            outcome: { kind: 'sandbox-denied', mode: 'read-only' },
          }] },
          pendingApproval: {
            callId: 'call-1', toolName: 'bash', action: retryAction, actionHash: retryActionHash,
            confinement: { kind: 'unconfined-composition' },
            earlierSandboxDenials: [{ source: { event: { seq: 9, type: 'tool/result' }, requestEventSeq: 8, callId: 'denied-1' } }],
          },
        },
      },
    } as never)
    expect(sandboxRetry).toMatchObject({
      assessment: {
        authorization: {
          level: 'explicit', targetCovered: true, sideEffectsCovered: false,
          sourceRefs: ['event:7'], sandboxDenialCandidateRefs: ['event:9'],
        },
      },
    })

    const withoutUserFrontier = projector.project({
      request: { ...request, actionHash }, pending: { ...request, actionHash, agent, authority },
      facts: {
        session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1, effectiveDelegationDepth: 0 },
        approvalBinding: { event: { seq: 2, type: 'approval/asked' }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' },
        approvalSnapshots: [{
          version: 1,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          approvalRequestId: 'ask-1', approvalAskedSeq: 2,
          execution: { requestEventSeq: 1, callId: 'call-1', toolName: 'bash', actionHash, classificationCatalogFingerprint: effective.dossier.fingerprint, projectorId: action.projectorId },
          environment: { version: 1, kind: 'native-header-only' },
        }],
        executionFacts: [{
          version: 1, catalogCommitment: commitment,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          request: { kind: 'model-tool-call', eventSeq: 1, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
          toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0] },
          projection: { projectorId: action.projectorId, action, actionHash, observedAt: 1 },
        }],
        eventProjection: { classificationCatalog: effective.dossier },
      },
      verifiedDossier: {
        dossier: { freeze: { currentTurn: 3 }, environment: { requestHeader: { tools: schemas } }, interaction: { delegations: { entries: [] }, turns: [] }, currentTurnTools: { attempts: [] }, pendingApproval: { callId: 'call-1', toolName: 'bash', action, actionHash, confinement: { kind: 'unconfined-composition' }, earlierSandboxDenials: [] } },
      },
    } as never)
    expect(withoutUserFrontier).toBeUndefined()
  })
})

describe('SourceBackedGateFactResolver', () => {
  it('does not consult a source without the complete exact ask correlation', async () => {
    const subject = resolver()
    const { requestId: _requestId, ...withoutRequestId } = request
    await expect(subject.resolver.resolve(withoutRequestId)).resolves.toBeUndefined()
    await expect(subject.resolver.resolve({ ...request, actionHash: 'other' })).resolves.toBeUndefined()
    expect(subject.snapshotInput).not.toHaveBeenCalled()
    expect(subject.snapshot).not.toHaveBeenCalled()
  })

  it('registration is metadata only and rejects conflicting replacement', () => {
    const subject = resolver()
    const pending = { ...request, agent, authority }
    subject.resolver.register(pending)
    expect(subject.resolver.authorityFor('session-1')).toBe(authority)
    expect(() => subject.resolver.register({ ...pending })).toThrow(/already registered/)
  })

  it('requires an exact source snapshot and a ready branded compilation', async () => {
    const subject = resolver()
    subject.resolver.register({ ...request, agent, authority })
    subject.snapshotInput.mockResolvedValue({
      agent, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash',
    })
    subject.snapshot.mockReturnValue({ source: 'facts' })
    subject.compile.mockReturnValue({ kind: 'incomplete' })
    await expect(subject.resolver.resolve(request)).resolves.toBeUndefined()

    subject.snapshotInput.mockResolvedValue({
      agent, approvalRequestId: 'ask-1', callId: 'wrong', toolName: 'bash',
    })
    await expect(subject.resolver.resolve(request)).resolves.toBeUndefined()
    expect(subject.snapshot).toHaveBeenCalledTimes(1)
  })
})
