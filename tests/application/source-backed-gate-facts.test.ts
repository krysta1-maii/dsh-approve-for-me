import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParentAuthority } from '../../src/ports/managed-reviewer.js'
import {
  DossierGateFactProjector,
  SourceBackedGateFactResolver,
  assertApprovalSourceEventBudget,
  fingerprintGateConfigurationV1,
} from '../../src/application/source-backed-gate-facts.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'
import { createActionSnapshot, hashAction } from '../../src/domain/protocol.js'

const agent = { id: 'session-1', session: { id: 'session-1' } } as unknown as Agent
const authority = { sessionId: 'session-1' } as unknown as ParentAuthority<Agent, string>
const reviewerConfigurationFingerprint = `sha256:${'9'.repeat(64)}`
const request = {
  requestId: 'ask-1', parentSessionId: 'session-1', callId: 'call-1',
  toolName: 'bash', actionHash: 'hash-1', deadlineAt: Number.MAX_SAFE_INTEGER, mode: 'auto' as const,
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

describe('source event work budget', () => {
  it('fails a dense history before dossier projection with a retryable capability gap', () => {
    expect(() => assertApprovalSourceEventBudget(20_000, 20_000)).not.toThrow()
    expect(() => assertApprovalSourceEventBudget(20_001, 20_000))
      .toThrow(expect.objectContaining({ code: 'retryable-capability' }))
  })
})

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
    const projectorId = 'dsh-approve-for-me/shell-process-v1'
    const sameSemantics = { family: 'shell-process-v1', value: { operation: 'bash', command: 'pwd', cwd: '/workspace', runInBackground: false } }
    const deniedAction = createActionSnapshot({
      toolName: 'bash', arguments: { command: 'pwd' }, projectorId, semantics: sameSemantics,
    })
    const retryAction = createActionSnapshot({
      toolName: 'bash',
      arguments: { command: 'pwd', sandbox_permissions: 'workspace-write', justification: retryJustification },
      projectorId,
      semantics: sameSemantics,
      requestedPermissions: [{ kind: 'sandbox', scope: 'workspace-write', details: { justification: retryJustification } }],
    })
    const retryActionHash = hashAction(retryAction)
    const directive = `/approve-for-me ${JSON.stringify({
      version: 1,
      scope: 'next-action',
      allow: { toolName: 'bash', arguments: retryAction.arguments, requestedPermissions: retryAction.requestedPermissions },
    })}`
    const deniedExecution = {
      ...projectInput.facts.executionFacts[0]!,
      request: { ...projectInput.facts.executionFacts[0]!.request, eventSeq: 8, callId: 'denied-1' },
      projection: {
        ...projectInput.facts.executionFacts[0]!.projection,
        projectorId, action: deniedAction, actionHash: hashAction(deniedAction), observedAt: 8,
      },
      result: { eventSeq: 9, eventType: 'tool/result', outcome: { kind: 'sandbox-denied', mode: 'read-only' } },
    }
    const retryExecution = {
      ...projectInput.facts.executionFacts[0]!,
      request: { ...projectInput.facts.executionFacts[0]!.request, eventSeq: 10 },
      projection: { ...projectInput.facts.executionFacts[0]!.projection, projectorId, action: retryAction, actionHash: retryActionHash },
    }
    const sandboxRetryInput = {
      request: { ...request, actionHash: retryActionHash },
      pending: { ...request, actionHash: retryActionHash, agent, authority },
      facts: {
        ...projectInput.facts,
        approvalBinding: { event: { seq: 11, type: 'approval/asked' }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' },
        approvalSnapshots: [{
          ...projectInput.facts.approvalSnapshots[0],
          approvalAskedSeq: 11,
          execution: { ...projectInput.facts.approvalSnapshots[0]!.execution, requestEventSeq: 10, actionHash: retryActionHash, projectorId },
        }],
        executionFacts: [deniedExecution, retryExecution],
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
            callId: 'call-1', toolName: 'bash', action: retryAction, actionHash: retryActionHash, projectorId,
            confinement: { kind: 'unconfined-composition' },
            earlierSandboxDenials: [{ source: { event: { seq: 9, type: 'tool/result' }, requestEventSeq: 8, callId: 'denied-1' } }],
          },
        },
      },
    }
    const sandboxRetry = projector.project(sandboxRetryInput as never)
    expect(sandboxRetry).toMatchObject({
      assessment: {
        authorization: {
          level: 'explicit', targetCovered: true, sideEffectsCovered: false,
          sourceRefs: ['event:7'], sandboxDenialCandidateRefs: ['event:9'],
        },
      },
    })

    const unrelatedDeniedAction = createActionSnapshot({
      toolName: 'bash',
      arguments: { command: 'whoami' },
      projectorId,
      semantics: { family: 'shell-process-v1', value: { operation: 'bash', command: 'whoami', cwd: '/workspace', runInBackground: false } },
    })
    const unrelatedRetry = projector.project({
      ...sandboxRetryInput,
      facts: {
        ...sandboxRetryInput.facts,
        executionFacts: [{
          ...deniedExecution,
          projection: {
            ...deniedExecution.projection,
            action: unrelatedDeniedAction,
            actionHash: hashAction(unrelatedDeniedAction),
          },
        }, retryExecution],
      },
      verifiedDossier: {
        dossier: {
          ...sandboxRetryInput.verifiedDossier.dossier,
          currentTurnTools: { attempts: [{
            ...sandboxRetryInput.verifiedDossier.dossier.currentTurnTools.attempts[0]!,
            request: {
              ...sandboxRetryInput.verifiedDossier.dossier.currentTurnTools.attempts[0]!.request,
              rawArguments: '{"command":"whoami"}',
            },
          }] },
        },
      },
    } as never)
    expect(unrelatedRetry).toMatchObject({
      assessment: {
        authorization: {
          level: 'unknown', targetCovered: false, sideEffectsCovered: false,
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

  it('the policy-v3 rubric reports a danger escalation as high, never as a fast-path candidate', () => {
    const dangerJustification = 'Escalate once to modify the DSH profile outside the workspace.'
    const projectorId = 'dsh-approve-for-me/shell-process-v1'
    const dangerSemantics = { family: 'shell-process-v1', value: { operation: 'bash', command: 'pwd', cwd: '/workspace', runInBackground: false } }
    const dangerAction = createActionSnapshot({
      toolName: 'bash',
      arguments: { command: 'pwd', sandbox_permissions: 'danger-full-access', justification: dangerJustification },
      projectorId,
      semantics: dangerSemantics,
      requestedPermissions: [{ kind: 'sandbox', scope: 'danger-full-access', details: { justification: dangerJustification } }],
    })
    const dangerActionHash = hashAction(dangerAction)
    const directive = `/approve-for-me ${JSON.stringify({
      version: 1,
      scope: 'next-action',
      allow: { toolName: 'bash', arguments: dangerAction.arguments, requestedPermissions: dangerAction.requestedPermissions },
    })}`
    const schemas = [{ name: 'bash', description: 'bash schema', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
    const effective = createDshAlpha2EffectiveCatalog(schemas)
    const commitment = createDshAlpha2CatalogCommitment(effective, 'native', 0, schemas)
    const projector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v3', 'high')
    const facts = projector.project({
      request: { ...request, actionHash: dangerActionHash },
      pending: { ...request, actionHash: dangerActionHash, agent, authority },
      facts: {
        session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1, effectiveDelegationDepth: 0 },
        approvalBinding: { event: { seq: 2, type: 'approval/asked' }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' },
        approvalSnapshots: [{
          version: 1,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          approvalRequestId: 'ask-1', approvalAskedSeq: 2,
          execution: { requestEventSeq: 1, callId: 'call-1', toolName: 'bash', actionHash: dangerActionHash, classificationCatalogFingerprint: effective.dossier.fingerprint, projectorId },
          environment: { version: 1, kind: 'native-header-only' },
        }],
        executionFacts: [{
          version: 1, catalogCommitment: commitment,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          request: { kind: 'model-tool-call', eventSeq: 1, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
          toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0] },
          projection: { projectorId, action: dangerAction, actionHash: dangerActionHash, observedAt: 1 },
        }],
        eventProjection: { classificationCatalog: effective.dossier },
      },
      verifiedDossier: {
        dossier: {
          freeze: { currentTurn: 3 },
          environment: { requestHeader: { tools: schemas } },
          interaction: { delegations: { entries: [] }, turns: [{ turn: 3, directUserMessages: [{ event: { seq: 7 }, content: [{ type: 'text', text: directive }], surfaceState: 'visible' }] }] },
          currentTurnTools: { attempts: [{
            request: { kind: 'model-tool-call', issuedIn: { seq: 0 }, blockIndex: 0, callId: 'call-1', toolName: 'bash', rawArguments: JSON.stringify(dangerAction.arguments), callEvent: { seq: 1 } },
            outcome: { kind: 'pending' },
          }] },
          pendingApproval: { callId: 'call-1', toolName: 'bash', action: dangerAction, actionHash: dangerActionHash, projectorId, confinement: { kind: 'unconfined-composition' }, earlierSandboxDenials: [] },
        },
      },
    } as never)
    // The v3 rubric labels the escalation high with explicit authorization
    // evidence intact; permission-expansion still forces sideEffectsCovered
    // false, so cache/replay fast paths stay closed and a fresh Guardian
    // review decides on the dossier.
    expect(facts).toMatchObject({
      policyVersion: 'policy-v3',
      assessment: {
        risk: 'high',
        categories: ['permission-expansion'],
        authorization: {
          level: 'explicit', targetCovered: true, sideEffectsCovered: false,
          sourceRefs: ['event:7'], sandboxDenialCandidateRefs: [],
        },
      },
    })
    const defaultProjector = new DossierGateFactProjector('generation-1', reviewerConfigurationFingerprint, 'policy-v2')
    expect(defaultProjector.project({
      request: { ...request, actionHash: dangerActionHash },
      pending: { ...request, actionHash: dangerActionHash, agent, authority },
      facts: {
        session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1, effectiveDelegationDepth: 0 },
        approvalBinding: { event: { seq: 2, type: 'approval/asked' }, approvalRequestId: 'ask-1', callId: 'call-1', toolName: 'bash' },
        approvalSnapshots: [{
          version: 1,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          approvalRequestId: 'ask-1', approvalAskedSeq: 2,
          execution: { requestEventSeq: 1, callId: 'call-1', toolName: 'bash', actionHash: dangerActionHash, classificationCatalogFingerprint: effective.dossier.fingerprint, projectorId },
          environment: { version: 1, kind: 'native-header-only' },
        }],
        executionFacts: [{
          version: 1, catalogCommitment: commitment,
          session: { sessionId: 'session-1', sessionFormatVersion: 1, createdAt: 1 },
          request: { kind: 'model-tool-call', eventSeq: 1, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
          toolClassification: { classificationCatalogFingerprint: effective.dossier.fingerprint, descriptor: effective.dossier.descriptors[0] },
          projection: { projectorId, action: dangerAction, actionHash: dangerActionHash, observedAt: 1 },
        }],
        eventProjection: { classificationCatalog: effective.dossier },
      },
      verifiedDossier: {
        dossier: {
          freeze: { currentTurn: 3 },
          environment: { requestHeader: { tools: schemas } },
          interaction: { delegations: { entries: [] }, turns: [{ turn: 3, directUserMessages: [{ event: { seq: 7 }, content: [{ type: 'text', text: directive }], surfaceState: 'visible' }] }] },
          currentTurnTools: { attempts: [{
            request: { kind: 'model-tool-call', issuedIn: { seq: 0 }, blockIndex: 0, callId: 'call-1', toolName: 'bash', rawArguments: JSON.stringify(dangerAction.arguments), callEvent: { seq: 1 } },
            outcome: { kind: 'pending' },
          }] },
          pendingApproval: { callId: 'call-1', toolName: 'bash', action: dangerAction, actionHash: dangerActionHash, projectorId, confinement: { kind: 'unconfined-composition' }, earlierSandboxDenials: [] },
        },
      },
    } as never)).toMatchObject({ assessment: { risk: 'critical' } })
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
