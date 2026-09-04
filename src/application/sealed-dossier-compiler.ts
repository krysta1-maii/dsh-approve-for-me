import { canonicalJson } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type {
  DossierCompilationResultV1,
  DossierFreezeV1,
  DossierMetricsV1,
  DossierSectionMetricsV1,
  EarlierSandboxDenialV1,
  EventRefV1,
  GuardianDossierV1,
} from '../domain/dossier.js'
import { sealSourceVerifiedDossier } from '../domain/dossier.js'
import type { ActionSnapshot } from '../domain/protocol.js'
import { hashAction } from '../domain/protocol.js'
import type { SealResultStatusV1 } from '../domain/sealed-facts.js'
import type { SealedParentSessionFactsV1 } from '../dsh/parent-session-fact-source.js'

/** The absolute upper bound for a hot packet; it must never exceed the full dossier budget. */
const MAX_HOT_PACKET_BYTES = 256_000

/**
 * Frozen, caller-supplied facts about the action that is currently awaiting
 * approval. They are whatever the live Gate/verified dossier already bound at ask
 * time and are intentionally reduced to the data the Reviewer needs to judge the
 * *current* action: the action snapshot, its derived classification, and the
 * immutable approval binding. The sealed ledger (tail, activities, epochs) travels
 * separately in the packet.
 */
export interface SealedDossierCurrentFactsV1 {
  readonly action: ActionSnapshot
  /** Derived classification string (classificationId, or 'delegation:<operation>'). */
  readonly classification: string
  /** Classification catalog fingerprint that governed the current action. */
  readonly classificationCatalogFingerprint: string
  readonly approvalRequestId: string
  readonly callId: string
  readonly toolName: string
  /** eventSeq of the tool/call (or tool/code-dispatch-start) that issued the ask. */
  readonly requestEventSeq: number
  readonly approvalAsked: EventRefV1
  /** Burnt-in, ask-time freeze of the principal identity and position. */
  readonly freeze: DossierFreezeV1
  readonly requestedSandboxMode?: 'workspace-write' | 'danger-full-access'
  /** Earlier sandbox denials in the open approval turn, bounded by the caller. */
  readonly earlierSandboxDenials?: readonly EarlierSandboxDenialV1[]
}

export interface SealedDossierCompileInputV1 {
  readonly packet: SealedParentSessionFactsV1
  readonly current: SealedDossierCurrentFactsV1
  readonly signal?: AbortSignal
}

export interface SealedDossierCompilerOptions {
  /**
   * Pre-build hot-packet budget, validated once at construction. Must be a
   * positive safe integer no greater than the full-dossier 256000 limit.
   */
  readonly maxHotPacketBytes: number
}

export type CompileSealed = (input: SealedDossierCompileInputV1) => DossierCompilationResultV1

function canonicalSize(value: JsonValue): { readonly bytes: number; readonly characters: number } {
  const json = canonicalJson(value)
  return Object.freeze({ bytes: new TextEncoder().encode(json).byteLength, characters: json.length })
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validFreeze(freeze: DossierFreezeV1): boolean {
  const parent = freeze.parent
  return nonEmptyString(parent.sessionId)
    && nonNegativeSafeInteger(parent.sessionFormatVersion)
    && nonNegativeSafeInteger(parent.createdAt)
    && (parent.cwd === undefined || nonEmptyString(parent.cwd))
    && nonNegativeSafeInteger(freeze.throughSeq)
    && nonNegativeSafeInteger(freeze.currentTurn)
    && nonNegativeSafeInteger(freeze.currentStep)
    && nonNegativeSafeInteger(freeze.frozenAt)
}

function validCurrent(current: SealedDossierCurrentFactsV1): boolean {
  return nonEmptyString(current.classification)
    && nonEmptyString(current.classificationCatalogFingerprint)
    && nonEmptyString(current.approvalRequestId)
    && nonEmptyString(current.callId)
    && nonEmptyString(current.toolName)
    && nonNegativeSafeInteger(current.requestEventSeq)
    && nonNegativeSafeInteger(current.approvalAsked.seq)
    && nonEmptyString(current.approvalAsked.type)
    && validFreeze(current.freeze)
}

/**
 * Incremental byte accounting over the dossier as it is assembled. Every member is
 * charged the moment it is serialized, so the budget overflows at the earliest
 * member that crosses the limit instead of after the full dossier is built. This
 * is the core difference from the complete-footprint compiler, which builds the
 * entire dossier and only then compares its size to the budget.
 */
interface Budget {
  readonly bytes: number
  readonly characters: number
  /** Content sections charged as complete members before any overflow. */
  readonly sections: readonly { readonly name: DossierSectionMetricsV1['name']; readonly bytes: number; readonly characters: number }[]
  /**
   * Charge the canonical representation of a top-level member. Returns false (and
   * does not apply the charge) when adding it would cross the budget, so the
   * overflowing member is neither kept nor reported as a complete section.
   */
  charge(name: 'version-kind' | 'freeze' | 'completeness' | DossierSectionMetricsV1['name'], value: JsonValue): boolean
}

function createBudget(maxBytes: number): Budget {
  let bytes = 0
  let characters = 0
  const sections: { readonly name: DossierSectionMetricsV1['name']; readonly bytes: number; readonly characters: number }[] = []
  return {
    get bytes() { return bytes },
    get characters() { return characters },
    get sections() { return Object.freeze(sections) },
    charge(name, value) {
      const fragment: JsonValue = name === 'version-kind'
        ? Object.freeze({ version: 1, kind: 'guardian-dossier' }) as unknown as JsonValue
        : { [name]: value } as JsonValue
      const fragmentSize = canonicalSize(fragment)
      if (bytes + fragmentSize.bytes > maxBytes) return false
      bytes += fragmentSize.bytes
      characters += fragmentSize.characters
      // The reported section bytes are the section value alone, matching the
      // complete compiler's DossierSectionMetricsV1.
      const valueSize = name === 'version-kind' || name === 'freeze' || name === 'completeness'
        ? undefined
        : canonicalSize(value)
      if (name !== 'version-kind' && name !== 'freeze' && name !== 'completeness') {
        sections.push(Object.freeze({ name, bytes: valueSize!.bytes, characters: valueSize!.characters }))
      }
      return true
    },
  }
}

/**
 * Produce the sealed-input Reader packet with a bounded, branded Guardian dossier.
 *
 * The packet (SealedParentSessionFactsV1) is the WP3 reader's already-validated
 * sealed ledger: every seal and activity row has been re-bound to the live Session
 * at the reader boundary, so this compiler deliberately performs no canonical
 * anchoring of its own (that is the reader's layered responsibility). It consumes
 * only the bounded, ID-free projection of those rows and never copies tool-result
 * content, resolvable identifiers, or LLM rationale into the dossier.
 *
 * The budget is pre-build: members are charged as they are assembled and the first
 * one to cross the limit fails closed with { kind: 'incomplete', reason:
 * 'budget-overflow' } and the same non-sensitive metric shape as the complete
 * compiler. Later members are never assembled, so overflow cannot hide at the tail
 * of the construction sequence.
 *
 * Placement: this is a distinct sealed-input compile path with its own input
 * contract and tests. It lives in its own application module rather than being
 * branched onto DefaultDossierCompiler.compile so the D1 full-history semantic is
 * left untouched and this compiler/input surface stays independently testable.
 */
export function createSealedDossierCompiler(options: SealedDossierCompilerOptions): CompileSealed {
  const budget = options.maxHotPacketBytes
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_HOT_PACKET_BYTES) {
    throw new TypeError(`maxHotPacketBytes must be a positive safe integer no greater than ${MAX_HOT_PACKET_BYTES}`)
  }

  return function compileSealed(input: SealedDossierCompileInputV1): DossierCompilationResultV1 {
    if (input.signal?.aborted) return { kind: 'incomplete', reason: 'aborted' }
    const packet = input.packet
    const current = input.current
    if (packet === null || typeof packet !== 'object' || packet.version !== 1
      || !Array.isArray(packet.seals) || !Array.isArray(packet.activities) || !Array.isArray(packet.catalogEpochs)
      || (packet.current !== undefined && (packet.current === null || typeof packet.current !== 'object'))) {
      return { kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' }
    }
    if (!nonEmptyString(packet.lifecycleFingerprint)) return { kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' }
    if (!validCurrent(current)) return { kind: 'incomplete', reason: 'invalid-current-action-facts' }

    let actionHash: string
    try {
      // hashAction re-parses the snapshot by domain rules and throws on a malformed
      // action, which we keep fail-closed rather than letting it escape.
      actionHash = hashAction(current.action)
    } catch {
      return { kind: 'incomplete', reason: 'invalid-current-action-facts' }
    }

    // Pre-build accounting starts with the fixed top-level frame (version/kind) so a
    // tiny budget still fails closed as budget-overflow rather than branding an
    // under-budget dossier.
    const account = createBudget(budget)
    if (!account.charge('version-kind', undefined as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }
    if (!account.charge('freeze', current.freeze as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    // Assemble and charge the content sections in the fixed canonical order. A
    // section that overflows short-circuits before any later section is built.
    const environment = Object.freeze({
      version: 1,
      kind: 'native-header-only' as const,
    })
    if (!account.charge('environment', environment as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    const instructions = Object.freeze({ messages: Object.freeze([]) })
    if (!account.charge('instructions', instructions as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    const interaction = buildInteraction(packet)
    // A structurally malformed sealed row is a data problem, not a capacity one:
    // it must fail closed as an invalid snapshot rather than masquerade as a
    // budget-overflow (which the gate would route to a delegate fallback).
    if (interaction === undefined) return { kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' }
    if (!account.charge('interaction', interaction as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    const currentTurnTools = Object.freeze({
      turn: current.freeze.currentTurn,
      excludedPendingRequest: Object.freeze({ callId: current.callId, requestEventSeq: current.requestEventSeq }),
      attempts: Object.freeze([]),
    })
    if (!account.charge('currentTurnTools', currentTurnTools as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    const pendingApproval = Object.freeze({
      approvalRequestId: current.approvalRequestId,
      approvalAsked: Object.freeze({
        seq: current.approvalAsked.seq,
        type: current.approvalAsked.type,
        ...(current.approvalAsked.turn === undefined ? {} : { turn: current.approvalAsked.turn }),
        ...(current.approvalAsked.step === undefined ? {} : { step: current.approvalAsked.step }),
      }),
      callId: current.callId,
      toolName: current.toolName,
      action: current.action,
      actionHash,
      projectorId: current.action.projectorId,
      classification: current.classification,
      classificationCatalogFingerprint: current.classificationCatalogFingerprint,
      confinement: Object.freeze({ kind: 'unconfined-composition' as const }),
      ...(current.requestedSandboxMode === undefined ? {} : { requestedSandboxMode: current.requestedSandboxMode }),
      ...(current.earlierSandboxDenials === undefined ? {} : { earlierSandboxDenials: current.earlierSandboxDenials }),
    })
    if (!account.charge('pendingApproval', pendingApproval as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    const completeness = Object.freeze({ complete: true as const, sourceThroughSeq: current.freeze.throughSeq, omissions: Object.freeze([]) as readonly [] })
    if (!account.charge('completeness', completeness as unknown as JsonValue)) {
      return overflowResult(packet, current, account)
    }

    const dossier: GuardianDossierV1 = Object.freeze({
      version: 1,
      kind: 'guardian-dossier',
      freeze: current.freeze,
      environment: environment as unknown as JsonValue,
      instructions: instructions as unknown as JsonValue,
      interaction: interaction as unknown as JsonValue,
      currentTurnTools: currentTurnTools as unknown as JsonValue,
      pendingApproval: pendingApproval as unknown as JsonValue,
      completeness,
    })
    return {
      kind: 'ready',
      verified: sealSourceVerifiedDossier(dossier),
      metrics: readyMetrics(packet, current, account, dossier),
    }
  }
}

/**
 * Build the bounded, ID-free sealed trajectory section. The catalog epochs carried
 * by the packet express the header freeze under sealed-input semantics; the
 * environment section remains the minimal closed-set evidence marker. Each
 * seal/activity row is projected to a content-free summary (sourceSeq, time,
 * classification, target summary, terminal outcome) and copies neither the seal's
 * resolvable identifiers (callId, request fields, canonical JSON) nor any tool
 * result content. Returns undefined when a row is structurally malformed so the
 * caller fails closed.
 */
function buildInteraction(packet: SealedParentSessionFactsV1): JsonValue | undefined {
  const activityBySourceSeq = new Map<number, { readonly occurredAt: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: SealResultStatusV1 }>()
  for (const activity of packet.activities) {
    if (activity === null || typeof activity !== 'object' || !nonNegativeSafeInteger((activity as { readonly sourceSeq?: unknown }).sourceSeq)) return undefined
    const sourceSeq = (activity as { readonly sourceSeq: number }).sourceSeq
    activityBySourceSeq.set(sourceSeq, activity as unknown as { readonly occurredAt: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: SealResultStatusV1 })
  }

  const current = packet.current === undefined
    ? undefined
    : (() => {
        const activity = packet.current.activity as unknown as { readonly sourceSeq: number; readonly occurredAt: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: SealResultStatusV1 }
        return Object.freeze({
          sourceSeq: activity.sourceSeq,
          occurredAt: activity.occurredAt,
          classification: activity.classification,
          targetSummary: activity.targetSummary,
          resultCategory: activity.resultCategory,
        })
      })()

  const tail: { readonly sourceSeq: number; readonly occurredAt: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: SealResultStatusV1 }[] = []
  for (const seal of packet.seals) {
    if (seal === null || typeof seal !== 'object' || !nonNegativeSafeInteger((seal as { readonly sourceSeq?: unknown }).sourceSeq)) return undefined
    const sourceSeq = (seal as { readonly sourceSeq: number }).sourceSeq
    const status = (seal as { readonly result?: { readonly status?: unknown } }).result?.status
    if (status !== 'completed' && status !== 'tool-error' && status !== 'sandbox-denied') return undefined
    const activity = activityBySourceSeq.get(sourceSeq)
    tail.push(activity === undefined
      ? Object.freeze({ sourceSeq, occurredAt: 0, classification: '', targetSummary: '', resultCategory: status })
      : Object.freeze({ sourceSeq, occurredAt: activity.occurredAt, classification: activity.classification, targetSummary: activity.targetSummary, resultCategory: status }))
  }

  const ledger = packet.activities.map(activity => {
    const sourceSeq = (activity as { readonly sourceSeq: number }).sourceSeq
    const occurredAt = (activity as { readonly occurredAt: number }).occurredAt
    const classification = (activity as { readonly classification: string }).classification
    const targetSummary = (activity as { readonly targetSummary: string }).targetSummary
    const resultCategory = (activity as { readonly resultCategory: SealResultStatusV1 }).resultCategory
    return Object.freeze({ sourceSeq, occurredAt, classification, targetSummary, resultCategory })
  })

  return Object.freeze({
    sealed: Object.freeze({
      ...(current === undefined ? {} : { current }),
      tail: Object.freeze(tail),
      ledger: Object.freeze(ledger),
      catalogEpochs: packet.catalogEpochs,
    }),
  }) as unknown as JsonValue
}

function overflowResult(packet: SealedParentSessionFactsV1, current: SealedDossierCurrentFactsV1, account: Budget): DossierCompilationResultV1 {
  return {
    kind: 'incomplete',
    reason: 'budget-overflow',
    metrics: metricsFrom(packet, current, account.bytes, account.characters, account.sections),
  }
}

/** Exact accounting for a branded dossier: the accumulated pre-build bytes are what
 * the budget short-circuit saw, but the reported size mirrors the complete compiler
 * by measuring the real canonical dossier. */
function readyMetrics(packet: SealedParentSessionFactsV1, current: SealedDossierCurrentFactsV1, account: Budget, dossier: GuardianDossierV1): DossierMetricsV1 {
  const size = canonicalSize(dossier as unknown as JsonValue)
  return metricsFrom(packet, current, size.bytes, size.characters, account.sections)
}

function metricsFrom(packet: SealedParentSessionFactsV1, current: SealedDossierCurrentFactsV1, bytes: number, characters: number, sections: readonly { readonly name: DossierSectionMetricsV1['name']; readonly bytes: number; readonly characters: number }[]): DossierMetricsV1 {
  return Object.freeze({
    dossierVersion: 1,
    delegationClassificationCatalogFingerprint: current.classificationCatalogFingerprint,
    bytes,
    characters,
    sections,
    eventCount: packet.seals.length,
    includedEventCount: 0,
    excludedEventCount: 0,
    delegationEntryCount: packet.activities.filter(activity => activity !== null && typeof activity === 'object' && typeof (activity as { readonly classification?: unknown }).classification === 'string' && (activity as { readonly classification: string }).classification.startsWith('delegation:')).length,
    attemptCount: packet.activities.length,
    totalBytes: 0,
  })
}
