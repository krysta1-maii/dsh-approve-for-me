import { describe, expect, it } from 'vitest'
import {
  DefaultDossierCompiler,
  createActionSnapshot,
} from '../../src/index.js'
import type {
  GuardianDossierCompilerDependencies,
  ParentSessionFactSnapshotV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`

const session = {
  sessionId: 'parent-1',
  sessionFormatVersion: 0,
  createdAt: 1_000,
  effectiveDelegationDepth: 0,
}

function catalog() {
  return {
    version: 1 as const,
    eventProjectionPolicyId: 'dsh-session-facts-v1' as const,
    argumentSemanticsId: 'default-v1',
    fingerprint: hash('c'),
    descriptors: [
      { classification: 'ordinary' as const, toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' },
    ],
  }
}

function facts(overrides: Partial<ParentSessionFactSnapshotV1> = {}): ParentSessionFactSnapshotV1 {
  const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
  return {
    version: 1,
    session,
    eventProjection: { policyId: 'dsh-session-facts-v1', classificationCatalog: catalog() },
    approvalBinding: {
      event: { seq: 5, type: 'approval/asked', turn: 1, step: 0 },
      approvalRequestId: 'ask-1',
      callId: 'call-1',
      toolName: 'bash',
    },
    throughSeq: 5,
    events: [],
    delegationReceipts: [],
    executionFacts: [{
      version: 1,
      session,
      request: { kind: 'model-tool-call', eventSeq: 5, eventType: 'tool/call', callId: 'call-1', toolName: 'bash' },
      toolClassification: {
        classificationCatalogFingerprint: hash('c'),
        descriptor: { classification: 'ordinary', toolName: 'bash', toolSchemaFingerprint: 'bash-fp', classificationId: 'class-1' },
      },
      projection: { projectorId: 'default-v1', action, actionHash: hash('a'), observedAt: 1 },
    }],
    approvalSnapshots: [{
      version: 1,
      session,
      approvalRequestId: 'ask-1',
      approvalAskedSeq: 5,
      environment: { version: 1, sessionId: 'parent-1' },
    }],
    ...overrides,
  }
}

const deps: GuardianDossierCompilerDependencies = {
  maxDossierBytes: 256_000,
  delegationProjector: {
    catalog: catalog(),
    project() {
      return { kind: 'invalid', reason: 'not-used' }
    },
  },
}

describe('DefaultDossierCompiler', () => {
  it('never brands a non-contiguous evidence prefix as ready', () => {
    const compiler = new DefaultDossierCompiler(deps)
    const result = compiler.compile({ facts: facts() })
    expect(result).toEqual({ kind: 'incomplete', reason: 'non-contiguous-event-prefix' })
  })

  it('brands a complete bounded direct-user prefix', () => {
    const base = facts()
    const complete = {
      ...base,
      approvalBinding: { ...base.approvalBinding, event: { seq: 7, type: 'approval/asked', turn: 1, step: 0 } },
      throughSeq: 7,
      events: [
        { seq: 0, time: 1, type: 'turn/start', retention: 'included' as const, data: { turn: 1 } },
        { seq: 1, time: 2, type: 'request/header', retention: 'included' as const, data: { header: { config: { model: 'model-1' }, tools: [] }, reason: 'initial' } },
        { seq: 2, time: 3, type: 'request/context', retention: 'included' as const, data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64_000 } },
        { seq: 3, time: 4, type: 'user/message', retention: 'included' as const, surfaceState: 'visible' as const, data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'show cwd' }] } },
        { seq: 4, time: 5, type: 'assistant/chunk', retention: 'included' as const, data: { turn: 1, step: 0, chunk: { type: 'tool-call-delta' } } },
        { seq: 5, time: 6, type: 'assistant/message', retention: 'included' as const, data: { turn: 1, step: 0, message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }] } } },
        { seq: 6, time: 7, type: 'tool/call', retention: 'included' as const, data: { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' } },
        { seq: 7, time: 8, type: 'approval/asked', retention: 'included' as const, data: { id: 'ask-1', callId: 'call-1', toolName: 'bash' } },
      ],
      executionFacts: [{ ...base.executionFacts[0]!, request: { ...base.executionFacts[0]!.request, eventSeq: 6 } }],
      approvalSnapshots: [{ ...base.approvalSnapshots[0]!, approvalAskedSeq: 7 }],
    }
    const result = new DefaultDossierCompiler(deps).compile({ facts: complete })
    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.verified.dossier.completeness).toMatchObject({ complete: true, sourceThroughSeq: 7 })
      expect(result.verified.dossier.freeze).toMatchObject({ throughSeq: 7, frozenAt: 8 })
      expect(result.verified.dossier.environment).toMatchObject({
        requestHeader: { config: { model: 'model-1' } },
        requestContext: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64_000 },
      })
      expect(result.verified.dossier.currentTurnTools).toMatchObject({
        excludedPendingRequest: { callId: 'call-1', requestEventSeq: 6 },
      })
      expect(result.metrics).toMatchObject({
        dossierVersion: 1,
        delegationClassificationCatalogFingerprint: hash('c'),
      })
      expect(result.metrics.bytes).toBeGreaterThan(0)
      expect(result.metrics.sections.map(section => section.name)).toEqual([
        'environment', 'instructions', 'interaction', 'currentTurnTools', 'pendingApproval',
      ])
    }
    expect(new DefaultDossierCompiler({ ...deps, maxDossierBytes: 1 }).compile({ facts: complete }))
      .toEqual({ kind: 'incomplete', reason: 'budget-overflow' })
    const malformedHeader = {
      ...complete,
      events: complete.events.map(event => event.seq === 1 ? { ...event, data: { header: { tools: [] }, reason: 'initial' } } : event),
    }
    expect(new DefaultDossierCompiler(deps).compile({ facts: malformedHeader }))
      .toEqual({ kind: 'incomplete', reason: 'invalid-request-header' })
    const malformedContext = {
      ...complete,
      events: complete.events.map(event => event.seq === 2 ? { ...event, data: { provider: 'deepseek' } } : event),
    }
    expect(new DefaultDossierCompiler(deps).compile({ facts: malformedContext }))
      .toEqual({ kind: 'incomplete', reason: 'invalid-request-context' })
    const mismatchedAssistant = {
      ...complete,
      events: complete.events.map(event => event.seq === 5
        ? { ...event, data: { turn: 1, step: 0, message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call-other', name: 'bash', arguments: '{"command":"pwd"}' }] } } }
        : event),
    }
    expect(new DefaultDossierCompiler(deps).compile({ facts: mismatchedAssistant }))
      .toEqual({ kind: 'incomplete', reason: 'invalid-current-assistant-message' })
  })

  it('fails closed rather than omit unsupported historical events', () => {
    const base = facts()
    const incomplete = {
      ...base, throughSeq: 3, approvalBinding: { ...base.approvalBinding, event: { seq: 3, type: 'approval/asked' } },
      events: [
        { seq: 0, time: 1, type: 'runtime/unknown', retention: 'included' as const, data: {} },
        { seq: 1, time: 2, type: 'user/message', retention: 'included' as const, data: { id: 'user-1', turn: 1, source: { kind: 'user' }, content: [] } },
        { seq: 2, time: 3, type: 'tool/call', retention: 'included' as const, data: { callId: 'call-1', name: 'bash' } },
        { seq: 3, time: 4, type: 'approval/asked', retention: 'included' as const, data: { id: 'ask-1', callId: 'call-1', toolName: 'bash' } },
      ],
      executionFacts: [{ ...base.executionFacts[0]!, request: { ...base.executionFacts[0]!.request, eventSeq: 2 } }],
      approvalSnapshots: [{ ...base.approvalSnapshots[0]!, approvalAskedSeq: 3 }],
    }
    expect(new DefaultDossierCompiler(deps).compile({ facts: incomplete })).toEqual({ kind: 'incomplete', reason: 'unsupported-history-for-complete-v1' })
  })

  it('is deterministically incomplete for the same frozen facts', () => {
    const compiler = new DefaultDossierCompiler(deps)
    expect(compiler.compile({ facts: facts() })).toEqual(compiler.compile({ facts: facts() }))
  })

  it('returns incomplete for delegated requester, missing call id, and missing execution fact', () => {
    const compiler = new DefaultDossierCompiler(deps)
    expect(compiler.compile({
      facts: facts({ session: { ...session, effectiveDelegationDepth: 1 } }),
    }).kind).toBe('incomplete')
    expect(compiler.compile({
      facts: facts({ approvalBinding: { ...facts().approvalBinding, callId: '' } }),
    }).kind).toBe('incomplete')
    expect(compiler.compile({
      facts: facts({ executionFacts: [] }),
    }).kind).toBe('incomplete')
  })

})
