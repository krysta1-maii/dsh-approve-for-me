import type { Agent } from '@deepseek-ai/dsh-agent'
import { canonicalJson, createActionSnapshot, createActivityV1, createSealV1, DSH_ALPHA2_SHELL_FAMILY, DSH_ALPHA2_SHELL_PROJECTOR_ID, DshStorageDomainFactRepositories, DshStorageDomainSealedFacts, genesisSealHash, hashAction } from '../../src/index.js'
import type { ActivityV1, ApprovalSnapshotRecordV1, SealV1, StorageDomainFacility, ToolExecutionFactRecordV1 } from '../../src/index.js'
import { createDshAlpha2CatalogCommitment, createDshAlpha2EffectiveCatalog } from '../../src/dsh/effective-tool-catalog.js'

/*
 * WP4-c item 4/5 storage-domain e2e fixture (helper, WP6-reusable).
 *
 * Builds one self-consistent 'parent session + sealed ledger' scenario for the
 * real plugin harness (installApproveForMe). It satisfies the three consistency
 * layers the predecessor diagnosed:
 *
 *  (1) capture: the synthetic parent session carries a request/header whose
 *      header.tools equals the callable schemas the harness returns from
 *      ctx.tools.schemas(agent), so DshScopedEffectiveCatalogResolver.forExecution
 *      projects a native catalog and resolveActionHash finds a captured hash.
 *
 *  (2) sealed chain: the disk chain (one historical sealed row) and its per-row
 *      live re-bind (eventAt + executionFacts.get) are fully self-consistent, so
 *      readSealedParentSessionFacts returns an ok non-empty packet.
 *
 *  (3) excerpts: user/message events (source.kind 'user') sit inside the bounded
 *      sealed-tail window before the current ask, so the sealed dossier carries
 *      interaction.sealed.excerpts.
 *
 * The current ask's execution fact / approval snapshot are written by the real
 * pipeline (bridge preExecute + awaitApprovalSnapshot) into the same memory
 * storage domain; only the historical sealed row + its execution fact are seeded.
 */

export interface ApprovalE2EFixture {
  schemas: readonly unknown[]
  lifecycle: { sessionId: string; sessionFormatVersion: number; createdAt: number; cwd: string }
  parent: Agent
  events: Array<Record<string, unknown>>
  appendCurrentAsk(): void
  readonly askedSeq: number
  readonly hotSeq: number
  readonly requestEventSeq: number
  storageDomain: StorageDomainFacility
  sealedReader: DshStorageDomainSealedFacts
  readonly maxSealedTailEvents: number
  seedInternal(): Promise<void>
}

interface ApprovalE2EOptions {
  readonly padEvents?: number
  readonly maxSealedTailEvents?: number
}

export const approvalE2ESchemas = { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }

function memoryStorageDomain(): { facility: StorageDomainFacility; tables: Map<string, Map<string, unknown>> } {
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let current = tables.get(name)
    if (current === undefined) {
      current = new Map<string, unknown>()
      tables.set(name, current)
    }
    return {
      get: (key: string) => current!.get(key),
      put: async (key: string, value: unknown) => { current!.set(key, value) },
    }
  }
  return { facility: { open: async () => ({ table, close: async () => {} }) }, tables }
}

function makeAction(command: string) {
  return createActionSnapshot({
    toolName: 'bash',
    arguments: { command },
    projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
    semantics: { family: DSH_ALPHA2_SHELL_FAMILY, value: { operation: 'bash', command, description: 'run ' + command, cwd: '/workspace', runInBackground: false } },
    requestedPermissions: [],
  })
}

export function buildApprovalE2EFixture(options: ApprovalE2EOptions = {}): ApprovalE2EFixture {
  const pad = options.padEvents ?? 0
  const maxSealedTailEvents = options.maxSealedTailEvents ?? 512
  const schemas: readonly unknown[] = [approvalE2ESchemas]
  const effective = createDshAlpha2EffectiveCatalog(schemas)
  const dossier = effective.dossier
  const lifecycle = { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 100, cwd: '/workspace' }
  const lifecycleFingerprint = canonicalJson(lifecycle)
  const headerEventSeq = pad
  const commitment = createDshAlpha2CatalogCommitment(effective, 'native', headerEventSeq, schemas)

  const events: Array<Record<string, unknown>> = []
  let seq = 0
  for (let i = 0; i < pad; i += 1) {
    events.push({ seq, time: 100 + seq, type: 'system/notice', data: { id: 'filler-' + i } })
    seq += 1
  }
  events.push({ seq, time: 100 + seq, type: 'request/header', data: { header: { tools: schemas } } })
  seq += 1
  events.push({ seq, time: 100 + seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'list the workspace' }] } })
  seq += 1
  events.push({ seq, time: 100 + seq, type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-past', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }] } } })
  seq += 1
  const pastCallSeq = seq
  events.push({ seq, time: 100 + seq, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-past', name: 'bash', arguments: { command: 'ls' } } })
  seq += 1
  const pastAskedSeq = seq
  events.push({ seq, time: 100 + seq, type: 'approval/asked', data: { id: 'ask-past', callId: 'call-past', toolName: 'bash', turn: 1, step: 0 } })
  seq += 1
  const pastResultSeq = seq
  events.push({ seq, time: 100 + seq, type: 'tool/result', sourceEventSeqs: [pastCallSeq], data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-past' }, content: [{ type: 'tool-result', toolCallId: 'call-past', isError: false, content: [{ type: 'text', text: 'workspace listing' }] }] } } })
  seq += 1
  events.push({ seq, time: 100 + seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'now print the working directory' }] } })
  seq += 1
  events.push({ seq, time: 100 + seq, type: 'assistant/message', data: { turn: 2, step: 0, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'pwd', description: 'print the working directory' }) }] } } })
  seq += 1
  const requestEventSeq = seq
  events.push({ seq, time: 100 + seq, type: 'tool/call', data: { turn: 2, step: 0, callId: 'call-1', name: 'bash', arguments: { command: 'pwd', description: 'print the working directory' } } })
  seq += 1
  const askedSeq = seq
  const hotSeq = askedSeq + 1

  const storage = memoryStorageDomain()

  const pastAction = makeAction('ls')
  const pastExecution: ToolExecutionFactRecordV1 = {
    version: 1,
    catalogCommitment: commitment,
    session: lifecycle,
    request: { kind: 'model-tool-call', eventSeq: pastCallSeq, eventType: 'tool/call', callId: 'call-past', toolName: 'bash' },
    toolClassification: { classificationCatalogFingerprint: dossier.fingerprint, descriptor: dossier.descriptors.find(item => item.toolName === 'bash')! },
    projection: { projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID, action: pastAction, actionHash: hashAction(pastAction), observedAt: 100 + pastCallSeq },
    result: { eventSeq: pastResultSeq, eventType: 'tool/result', outcome: { kind: 'completed' } },
  }

  let seeded: DshStorageDomainSealedFacts | undefined

  const parent = {
    id: 'parent-1',
    options: {},
    session: {
      id: 'parent-1',
      header: { version: 0, id: 'parent-1', createdAt: 100, cwd: '/workspace' },
      snapshotEvents: () => events,
      get seq() { return events.length },
      eventAt: (at: number) => events[at],
    },
  } as unknown as Agent

  return {
    schemas,
    lifecycle,
    parent,
    events,
    appendCurrentAsk() {
      if (events.length !== askedSeq) throw new Error('appendCurrentAsk is out of order')
      events.push({ seq: askedSeq, time: 100 + askedSeq, type: 'approval/asked', data: { id: 'ask-1', callId: 'call-1', toolName: 'bash', turn: 2, step: 0 } })
    },
    get askedSeq() { return askedSeq },
    get hotSeq() { return hotSeq },
    get requestEventSeq() { return requestEventSeq },
    get storageDomain() { return storage.facility },
    get sealedReader() { return seeded as DshStorageDomainSealedFacts },
    maxSealedTailEvents,
    async seedInternal() {
      if (seeded !== undefined) return
      const facts = new DshStorageDomainFactRepositories(storage.facility)
      await facts.create(pastExecution)
      const seal = createSealV1({
        lifecycleFingerprint,
        sourceSeq: pastCallSeq,
        request: { eventSeq: pastCallSeq, eventType: 'tool/call', callId: 'call-past', toolName: 'bash' },
        approvalAsked: { eventSeq: pastAskedSeq, requestId: 'ask-past' },
        actionHash: hashAction(pastAction),
        projectorId: DSH_ALPHA2_SHELL_PROJECTOR_ID,
        catalog: { epoch: 0, headerEventSeq, commitment: commitment.fingerprint },
        wireSchemaFingerprint: dossier.descriptors.find(item => item.toolName === 'bash')!.toolSchemaFingerprint,
        result: { eventSeq: pastResultSeq, status: 'completed' },
        epochBoundary: { previousEpoch: null, changed: false },
        previousSealHash: genesisSealHash(lifecycleFingerprint),
      })
      const activity = createActivityV1({
        lifecycleFingerprint,
        sourceSeq: pastCallSeq,
        occurredAt: 100 + pastResultSeq,
        classification: 'approval-class:body-escalation',
        targetSummary: 'tool:bash',
        resultCategory: 'completed',
        sourceSealHash: seal.sealHash,
      })
      seeded = new DshStorageDomainSealedFacts(storage.facility)
      await seeded.append(seal, activity)
      // The historical row's result is already on disk; no repair needed.
    },
  }
}

export async function seedApprovalE2E(fixture: ApprovalE2EFixture & { seedInternal(): Promise<void> }): Promise<void> {
  await fixture.seedInternal()
}