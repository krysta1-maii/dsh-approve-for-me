import { canonicalJson } from '../domain/json.js'
import type {
  DossierCompilationResultV1,
  GuardianDossierCompiler,
  GuardianDossierCompilerDependencies,
  ParentSessionFactSnapshotV1,
} from '../domain/dossier.js'
import { sealSourceVerifiedDossier } from '../domain/dossier.js'

/**
 * Deterministic D1 compiler (current pure subset). It validates the frozen
 * source snapshot's principal/authority/execution-fact requirements and builds
 * a minimal `GuardianDossierV1`. Sections are currently filled conservatively;
 * the full instruction/tool trajectory/delegation projections remain future D1
 * work, but every prepared dossier passes `assertDossierShape()`.
 */
export class DefaultDossierCompiler implements GuardianDossierCompiler {
  constructor(private readonly deps: GuardianDossierCompilerDependencies) {}

  compile(input: {
    readonly facts: ParentSessionFactSnapshotV1
    readonly signal?: AbortSignal
  }): DossierCompilationResultV1 {
    const { facts } = input
    if (input.signal?.aborted) return { kind: 'incomplete', reason: 'aborted' }
    if (facts.version !== 1) return { kind: 'incomplete', reason: 'event-projection-policy-mismatch' }
    if (facts.session.effectiveDelegationDepth !== 0 || facts.session.parentSessionId !== undefined) {
      return { kind: 'incomplete', reason: 'unsupported-delegated-requester' }
    }
    if (facts.approvalBinding.callId.length === 0) return { kind: 'incomplete', reason: 'missing-call-id' }
    if (facts.throughSeq !== facts.approvalBinding.event.seq) {
      return { kind: 'incomplete', reason: 'missing-current-request-event' }
    }
    const execution = facts.executionFacts.find(item =>
      item.request.callId === facts.approvalBinding.callId
      && item.request.toolName === facts.approvalBinding.toolName)
    if (execution === undefined) return { kind: 'incomplete', reason: 'missing-required-execution-fact' }
    const snapshot = facts.approvalSnapshots.find(item =>
      item.approvalRequestId === facts.approvalBinding.approvalRequestId)
    if (snapshot === undefined) return { kind: 'incomplete', reason: 'missing-required-projection' }

    const turn = facts.approvalBinding.event.turn ?? 0
    const step = facts.approvalBinding.event.step ?? 0
    const dossier = Object.freeze({
      version: 1 as const,
      kind: 'guardian-dossier' as const,
      freeze: {
        parent: {
          sessionId: facts.session.sessionId,
          sessionFormatVersion: facts.session.sessionFormatVersion,
          createdAt: facts.session.createdAt,
        },
        throughSeq: facts.throughSeq,
        currentTurn: turn,
        currentStep: step,
        // Deterministic placeholder until the source-backed compiler accepts an
        // explicit capture timestamp; using Date.now() here would make the same
        // facts produce different dossier hashes on every compile.
        frozenAt: 0,
      },
      environment: snapshot.environment,
      instructions: Object.freeze({ messages: [] }),
      interaction: Object.freeze({ turns: [], delegations: [] }),
      currentTurnTools: Object.freeze({
        turn,
        excludedPendingRequest: {
          callId: facts.approvalBinding.callId,
          requestEventSeq: facts.approvalBinding.event.seq,
        },
        attempts: [],
      }),
      pendingApproval: Object.freeze({
        request: {
          kind: execution.request.kind === 'model-tool-call' ? 'model-tool-call' : 'code-dispatch',
          callId: execution.request.callId,
          toolName: execution.request.toolName,
          rawArguments: canonicalJson(execution.projection.action.arguments),
          eventSeq: execution.request.eventSeq,
        },
        approvalAsked: facts.approvalBinding.event,
        approvalRequestId: facts.approvalBinding.approvalRequestId,
        callId: execution.request.callId,
        toolName: execution.request.toolName,
        action: execution.projection.action,
        actionHash: execution.projection.actionHash,
        projectorId: execution.projection.projectorId,
        confinement: { kind: 'unconfined-composition' },
        earlierSandboxDenials: [],
      }),
      completeness: Object.freeze({
        ready: false,
        missing: ['instructions', 'interaction', 'delegations'],
      }),
    })
    return {
      kind: 'ready',
      verified: sealSourceVerifiedDossier(dossier as never),
      metrics: {
        eventCount: facts.events.length,
        includedEventCount: facts.events.filter(event => event.retention === 'included').length,
        excludedEventCount: facts.events.filter(event => event.retention === 'excluded-content').length,
        delegationEntryCount: 0,
        attemptCount: facts.executionFacts.length,
        totalBytes: facts.events.reduce((sum, event) => sum + ('originalBytes' in event ? event.originalBytes ?? 0 : 0), 0),
      },
    }
  }
}
