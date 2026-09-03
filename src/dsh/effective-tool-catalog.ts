import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { canonicalJson, freezeJson, parseUniqueJson, snapshotJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import { fingerprintApprovalToolCatalogV1 } from '../approval-gate/catalog.js'
import type { ApprovalToolCatalog } from '../approval-gate/catalog.js'
import {
  effectiveToolBindingsFromRequestHeaderV1,
  fingerprintDurableToolCatalogCommitmentV1,
  validateDurableToolCatalogCommitmentV1,
} from '../domain/dossier.js'
import type {
  DelegationToolClassificationCatalogV1,
  DurableToolCatalogCommitmentV1,
} from '../domain/dossier.js'
import {
  createDshAlpha2DossierCatalog,
  createDshAlpha2StockProjectorRegistry,
  createDshAlpha2StockToolCatalog,
} from './stock-tools.js'
import type { ActionProjector } from '../ports/action-projector.js'

interface EventLike {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

interface SessionLike {
  readonly snapshotEvents?: () => readonly EventLike[]
}

export interface DshExecutionEventBinding {
  readonly requestEventSeq: number
  readonly requestEventType: 'tool/call' | 'tool/code-dispatch-start'
  readonly rootRequestEventSeq: number
  readonly parentRequestEventSeq: number
}

export interface DshAlpha2EffectiveCatalog {
  /** Full exact scoped callable registry, including hidden PTC tools. */
  readonly schemas: readonly JsonValue[]
  readonly approval: ApprovalToolCatalog
  readonly dossier: DelegationToolClassificationCatalogV1
  readonly commitment: DurableToolCatalogCommitmentV1
  readonly execution: DshExecutionEventBinding
}

export interface ScopedToolSchemas {
  schemas(agent: Agent): readonly unknown[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function frozenSchemas(value: unknown): readonly JsonValue[] | undefined {
  if (!Array.isArray(value)) return undefined
  try {
    return Object.freeze(value.map(schema => freezeJson(snapshotJson(schema)) as JsonValue))
  } catch {
    return undefined
  }
}

function sameSchemaSet(left: readonly JsonValue[], right: readonly JsonValue[]): boolean {
  const leftBindings = effectiveToolBindingsFromRequestHeaderV1({ tools: left })
  const rightBindings = effectiveToolBindingsFromRequestHeaderV1({ tools: right })
  if (leftBindings === undefined || rightBindings === undefined || leftBindings.length !== rightBindings.length) return false
  const expected = new Map(leftBindings.map(item => [item.toolName, item.toolSchemaFingerprint]))
  return rightBindings.every(item => expected.get(item.toolName) === item.toolSchemaFingerprint)
}

function sameArguments(left: unknown, right: unknown): boolean {
  try {
    const normalizedLeft = typeof left === 'string' ? parseUniqueJson(left) : snapshotJson(left)
    const normalizedRight = typeof right === 'string' ? parseUniqueJson(right) : snapshotJson(right)
    return canonicalJson(normalizedLeft) === canonicalJson(normalizedRight)
  } catch {
    return false
  }
}

function last<T extends { readonly seq: number }>(values: readonly T[]): T | undefined {
  return [...values].sort((left, right) => left.seq - right.seq).at(-1)
}

export function createDshAlpha2CatalogCommitment(
  effective: Omit<DshAlpha2EffectiveCatalog, 'commitment' | 'execution'>,
  presentation: 'native' | 'ptc',
  requestHeaderEventSeq: number,
  wireSchemas: readonly unknown[],
): DurableToolCatalogCommitmentV1 {
  const wire = frozenSchemas(wireSchemas)
  if (wire === undefined) throw new TypeError('wire schemas must be strict JSON')
  const unsealed = {
    version: 1 as const,
    fingerprint: '',
    presentation,
    requestHeaderEventSeq,
    wireSchemas: wire,
    callableSchemas: effective.schemas,
    approvalCatalog: effective.approval,
    classificationCatalog: effective.dossier,
  }
  const fingerprint = fingerprintDurableToolCatalogCommitmentV1(unsealed)
  if (fingerprint === undefined) throw new TypeError('catalog commitment cannot be fingerprinted')
  const commitment = Object.freeze({ ...unsealed, fingerprint })
  if (validateDurableToolCatalogCommitmentV1(commitment).kind !== 'ok') throw new TypeError('catalog commitment is invalid')
  return commitment
}

/** Build both authorization catalogs from one detached exact callable schema set. */
export function createDshAlpha2EffectiveCatalog(schemas: readonly unknown[]): Omit<DshAlpha2EffectiveCatalog, 'commitment' | 'execution'> {
  const frozen = frozenSchemas(schemas)
  if (frozen === undefined) throw new TypeError('effective tool schemas must be a strict JSON array')
  const approval = createDshAlpha2StockToolCatalog(frozen)
  const dossier = createDshAlpha2DossierCatalog(frozen, approval)
  return Object.freeze({ schemas: frozen, approval, dossier })
}

interface ResolvedExecutionHistory {
  readonly request: EventLike
  readonly root: EventLike
  readonly parent: EventLike
  readonly header: EventLike
  readonly wireSchemas: readonly JsonValue[]
}

function debugCatalog(stage: string, detail?: unknown): undefined {
  if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') console.error('[approve-for-me catalog]', stage, detail === undefined ? '' : JSON.stringify(detail))
  return undefined
}

function resolveExecutionHistory(exec: ToolExecution): ResolvedExecutionHistory | undefined {
  const session = exec.agent?.session as unknown as SessionLike | undefined
  if (typeof session?.snapshotEvents !== 'function') return debugCatalog('history:no-snapshot-events')
  const events = session.snapshotEvents()
  const validSeq = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
  if (!Array.isArray(events) || events.some((event, index) => !validSeq(event.seq) || event.seq !== index)) return debugCatalog('history:invalid-events')
  const callId = String(exec.callId)
  const isNested = exec.parent !== undefined
  const request = last(events.filter(event => {
    const data = record(event.data)
    if (isNested) {
      return event.type === 'tool/code-dispatch-start' && data?.subCallId === callId
        && data.name === exec.name && data.rootCallId === String(exec.rootCallId)
        && sameArguments(data.arguments, exec.arguments)
    }
    return event.type === 'tool/call' && data?.callId === callId && data.name === exec.name
      && sameArguments(data.arguments, exec.arguments)
  }))
  // Alpha.1 appends the canonical source event immediately before pre-execute.
  // Refuse to bind an older matching call when IDs are reused or the hook is late.
  if (request === undefined || request.seq !== events.length - 1) return debugCatalog('history:request-not-latest', { found: request !== undefined, requestSeq: request?.seq, lastSeq: events.length - 1, callId, name: exec.name })

  let root = request
  let parent = request
  if (isNested) {
    const requestData = record(request.data)
    const rootCallId = typeof requestData?.rootCallId === 'string' ? requestData.rootCallId : undefined
    const parentCallId = typeof requestData?.parentCallId === 'string' ? requestData.parentCallId : undefined
    if (rootCallId === undefined || parentCallId === undefined || rootCallId !== String(exec.rootCallId)) return undefined
    root = last(events.filter(event => event.seq < request.seq && event.type === 'tool/call'
      && record(event.data)?.callId === rootCallId)) as EventLike
    parent = last(events.filter(event => {
      if (event.seq >= request.seq) return false
      const data = record(event.data)
      return (event.type === 'tool/call' && data?.callId === parentCallId)
        || (event.type === 'tool/code-dispatch-start' && data?.subCallId === parentCallId && data.rootCallId === rootCallId)
    })) as EventLike
    if (root === undefined || parent === undefined) return undefined
  }

  const rootData = record(root.data)
  const rootCallId = typeof rootData?.callId === 'string' ? rootData.callId : undefined
  const rootName = typeof rootData?.name === 'string' ? rootData.name : undefined
  if (rootCallId === undefined || rootName === undefined) return debugCatalog('history:root-shape')
  const assistant = last(events.filter(event => {
    if (event.type !== 'assistant/message' || event.seq >= root.seq) return false
    const message = record(record(event.data)?.message)
    if (!Array.isArray(message?.content)) return false
    return message.content.some(block => {
      const item = record(block)
      return item?.type === 'tool-call' && item.id === rootCallId && item.name === rootName
    })
  }))
  if (assistant === undefined || events.some(event => event.type === 'request/header'
    && event.seq > assistant.seq && event.seq < root.seq)) return debugCatalog('history:assistant-binding', { found: assistant !== undefined })
  const header = last(events.filter(event => event.type === 'request/header' && event.seq < assistant.seq))
  const headerValue = record(record(header?.data)?.header)
  const wireSchemas = frozenSchemas(headerValue?.tools ?? [])
  if (header === undefined || wireSchemas === undefined) return debugCatalog('history:header', { found: header !== undefined })
  return Object.freeze({ request, root, parent, header, wireSchemas })
}

/** Return the latest exact call's canonical request/header presentation. */
/**
 * Per-execution resolver. Native calls require exact wire/callable schema-set
 * equality. PTC calls require an exact run_code wire presentation and bind all
 * nested executions to the frozen full callable registry of their root event.
 */
export class DshScopedEffectiveCatalogResolver {
  private readonly byExecution = new WeakMap<ToolExecution, DshAlpha2EffectiveCatalog>()
  private readonly byToken = new Map<ToolExecution['token'], DshAlpha2EffectiveCatalog>()

  constructor(
    private readonly tools: ScopedToolSchemas,
    private readonly configuredTemplate?: ApprovalToolCatalog,
  ) {}

  private applyConfiguredTemplate(base: Omit<DshAlpha2EffectiveCatalog, 'commitment' | 'execution'>): Omit<DshAlpha2EffectiveCatalog, 'commitment' | 'execution'> | undefined {
    const template = this.configuredTemplate
    if (template === undefined || template.descriptors.length === 0) return base
    const descriptors = base.approval.descriptors.map(visible => {
      const matches = template.descriptors.filter(candidate => candidate.toolName === visible.toolName
        && candidate.toolSchemaFingerprint === visible.toolSchemaFingerprint)
      return matches.length === 1 ? matches[0] : undefined
    })
    if (descriptors.some(descriptor => descriptor === undefined)) return undefined
    const unsealed = {
      version: 1 as const,
      argumentSemanticsId: template.argumentSemanticsId,
      fingerprint: '',
      descriptors: Object.freeze(descriptors as ApprovalToolCatalog['descriptors']),
    }
    const fingerprint = fingerprintApprovalToolCatalogV1(unsealed)
    if (fingerprint === undefined) return undefined
    const approval = Object.freeze({ ...unsealed, fingerprint })
    try {
      return Object.freeze({ schemas: base.schemas, approval, dossier: createDshAlpha2DossierCatalog(base.schemas, approval) })
    } catch {
      return undefined
    }
  }

  forExecution(exec: ToolExecution): DshAlpha2EffectiveCatalog | undefined {
    const cached = this.byExecution.get(exec)
    if (cached !== undefined) return cached
    if (exec.agent === undefined) return debugCatalog('for-exec:no-agent')
    const history = resolveExecutionHistory(exec)
    if (history === undefined) return debugCatalog('for-exec:no-history', { name: exec.name, callId: String(exec.callId) })
    if (exec.parent !== undefined) {
      const parentCatalog = this.byToken.get(exec.parent)
      if (parentCatalog === undefined || parentCatalog.commitment.presentation !== 'ptc'
        || history.root.seq !== parentCatalog.execution.rootRequestEventSeq
        || history.parent.seq !== parentCatalog.execution.requestEventSeq) return undefined
      const execution = Object.freeze({
        requestEventSeq: history.request.seq,
        requestEventType: history.request.type as 'tool/code-dispatch-start',
        rootRequestEventSeq: history.root.seq,
        parentRequestEventSeq: history.parent.seq,
      })
      const catalog = Object.freeze({
        schemas: parentCatalog.schemas,
        approval: parentCatalog.approval,
        dossier: parentCatalog.dossier,
        commitment: parentCatalog.commitment,
        execution,
      })
      this.byExecution.set(exec, catalog)
      this.byToken.set(exec.token, catalog)
      return catalog
    }
    let callableSchemas: readonly JsonValue[]
    try {
      const snapshot = frozenSchemas(this.tools.schemas(exec.agent))
      if (snapshot === undefined) return undefined
      callableSchemas = snapshot
    } catch {
      return undefined
    }
    const same = sameSchemaSet(callableSchemas, history.wireSchemas)
    const runCodeWire = history.wireSchemas.length === 1
      && record(history.wireSchemas[0])?.name === 'run_code'
      && callableSchemas.some(schema => canonicalJson(schema) === canonicalJson(history.wireSchemas[0]!))
    const presentation = same ? 'native' as const : runCodeWire ? 'ptc' as const : undefined
    if (presentation === undefined) return debugCatalog('for-exec:schema-mismatch', {
      callable: callableSchemas.map(item => record(item)?.name),
      wire: history.wireSchemas.map(item => record(item)?.name),
    })
    let base: Omit<DshAlpha2EffectiveCatalog, 'commitment' | 'execution'>
    try {
      const discovered = createDshAlpha2EffectiveCatalog(callableSchemas)
      const configured = this.applyConfiguredTemplate(discovered)
      if (configured === undefined) return debugCatalog('for-exec:template-mismatch')
      base = configured
    } catch {
      return undefined
    }
    const unsealedCommitment = {
      version: 1 as const,
      fingerprint: '',
      presentation,
      requestHeaderEventSeq: history.header.seq,
      wireSchemas: history.wireSchemas,
      callableSchemas: base.schemas,
      approvalCatalog: base.approval,
      classificationCatalog: base.dossier,
    }
    const commitmentFingerprint = fingerprintDurableToolCatalogCommitmentV1(unsealedCommitment)
    if (commitmentFingerprint === undefined) return undefined
    const commitment = Object.freeze({ ...unsealedCommitment, fingerprint: commitmentFingerprint })
    if (validateDurableToolCatalogCommitmentV1(commitment).kind !== 'ok') return undefined
    const execution = Object.freeze({
      requestEventSeq: history.request.seq,
      requestEventType: history.request.type as 'tool/call' | 'tool/code-dispatch-start',
      rootRequestEventSeq: history.root.seq,
      parentRequestEventSeq: history.parent.seq,
    })
    const catalog = Object.freeze({ ...base, commitment, execution })
    this.byExecution.set(exec, catalog)
    this.byToken.set(exec.token, catalog)
    return catalog
  }

  release(exec: ToolExecution): void {
    this.byToken.delete(exec.token)
  }

  readonly actionProjector: ActionProjector<ToolExecution> = Object.freeze({
    project: (exec: ToolExecution) => {
      const catalog = this.forExecution(exec)
      if (catalog === undefined) throw new TypeError(`no corroborated scoped effective catalog for ${exec.name}`)
      return createDshAlpha2StockProjectorRegistry(catalog.approval).project(exec)
    },
  })
}
