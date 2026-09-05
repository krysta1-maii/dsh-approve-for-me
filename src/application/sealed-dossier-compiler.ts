import { canonicalJson, freezeJson, snapshotJson } from '../domain/json.js'
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
  /**
   * Bounded, seq-ordered recent human user-message excerpts around this ask.
   * They are an intent-understanding aid for the Reviewer, never an
   * authorization fact: a missing or empty set degrades to the packet without
   * an excerpt channel, it never changes the current action's authority.
   */
  readonly excerpts?: readonly { readonly seq: number; readonly text: string }[]
  /** Count of candidate user-message excerpts the assembler dropped for its byte budget. */
  readonly excerptTruncated?: number
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
  /**
   * Per-excerpt-entry UTF-8 byte upper bound, validated against each projected
   * excerpt at compile time. Must be a positive safe integer. Defaults to 24000
   * (the config `maxRecentExcerptBytes` default). An excerpt text at or over
   * this ceiling is a structural input violation and fails closed, never
   * silently truncated.
   */
  readonly maxRecentExcerptBytes?: number
  /**
   * Upper bound on the number of sealed ledger (activity) rows projected into the
   * dossier's interaction.sealed.ledger section. Validated once at construction;
   * must be a positive safe integer. Defaults to 256 (the config
   * maxLedgerEntries default). The ledger row-count gate is checked before any
   * row is projected: a packet whose activity count exceeds this bound fails
   * closed as { kind: 'incomplete', reason: 'ledger-budget-overflow' } without
   * doing the (possibly large) projection work, distinct from the byte-budget
   * overflow that is detected during assembly.
   */
  readonly maxLedgerEntries?: number
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
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

function validExcerpts(excerpts: unknown, excerptTruncated: unknown, maxRecentExcerptBytes: number): boolean {
  if (excerptTruncated !== undefined && !nonNegativeSafeInteger(excerptTruncated)) return false
  if (excerpts === undefined) return true
  if (!Array.isArray(excerpts)) return false
  for (const entry of excerpts) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    const candidate = entry as Record<string, unknown>
    const keys = Object.keys(candidate)
    // Closed set: exactly seq + text. A smuggled field (tool-result body, an
    // event/session ID, LLM text) is a schema violation and must fail closed,
    // never be silently stripped into a branded dossier.
    if (keys.length !== 2 || keys.some(key => key !== 'seq' && key !== 'text')) return false
    if (!nonNegativeSafeInteger(candidate.seq)) return false
    if (typeof candidate.text !== 'string' || candidate.text.length === 0) return false
    if (utf8ByteLength(candidate.text) > maxRecentExcerptBytes) return false
  }
  return true
}

function validCurrent(current: SealedDossierCurrentFactsV1, maxRecentExcerptBytes: number): boolean {
  return nonEmptyString(current.classification)
    && nonEmptyString(current.classificationCatalogFingerprint)
    && nonEmptyString(current.approvalRequestId)
    && nonEmptyString(current.callId)
    && nonEmptyString(current.toolName)
    && nonNegativeSafeInteger(current.requestEventSeq)
    && nonNegativeSafeInteger(current.approvalAsked.seq)
    && nonEmptyString(current.approvalAsked.type)
    && validFreeze(current.freeze)
    && validExcerpts(current.excerpts, current.excerptTruncated, maxRecentExcerptBytes)
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
  const excerptByteBudget = options.maxRecentExcerptBytes ?? 24_000
  if (!Number.isSafeInteger(excerptByteBudget) || excerptByteBudget < 1) {
    throw new TypeError('maxRecentExcerptBytes must be a positive safe integer')
  }
  const ledgerEntryBudget = options.maxLedgerEntries ?? 256
  if (!Number.isSafeInteger(ledgerEntryBudget) || ledgerEntryBudget < 1) {
    throw new TypeError('maxLedgerEntries must be a positive safe integer')
  }

  return function compileSealed(input: SealedDossierCompileInputV1): DossierCompilationResultV1 {
    if (input.signal?.aborted) return { kind: 'incomplete', reason: 'aborted' }
    // Freeze-align with DefaultDossierCompiler.compile: snapshot and deep-freeze the
    // caller's objects so the branded dossier never aliases a mutable external
    // reference. Non-JSON input fails closed rather than escaping.
    let packet: SealedParentSessionFactsV1
    let current: SealedDossierCurrentFactsV1
    try {
      packet = freezeJson(snapshotJson(input.packet)) as unknown as SealedParentSessionFactsV1
      current = freezeJson(snapshotJson(input.current)) as unknown as SealedDossierCurrentFactsV1
    } catch {
      return { kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' }
    }
    if (packet === null || typeof packet !== 'object' || packet.version !== 1
      || !Array.isArray(packet.seals) || !Array.isArray(packet.activities) || !Array.isArray(packet.catalogEpochs)
      || (packet.current !== undefined && (packet.current === null || typeof packet.current !== 'object'))) {
      return { kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' }
    }
    if (!nonEmptyString(packet.lifecycleFingerprint)) return { kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' }
    if (!validCurrent(current, excerptByteBudget)) return { kind: 'incomplete', reason: 'invalid-current-action-facts' }

    let actionHash: string
    try {
      // hashAction re-parses the snapshot by domain rules and throws on a malformed
      // action, which we keep fail-closed rather than letting it escape.
      actionHash = hashAction(current.action)
    } catch {
      return { kind: 'incomplete', reason: 'invalid-current-action-facts' }
    }

    // Ledger row-count gate: a packet carrying more activity rows than
    // maxLedgerEntries is a bounded-scale overflow. It is checked BEFORE any row
    // is projected so the (possibly large) ledger is never traversed, and it
    // produces its own precise reason code, distinct from the byte-budget
    // overflow that is detected during assembly. The metrics stay a minimal
    // non-sensitive candidate accounting (zero bytes, no content sections).
    if (packet.activities.length > ledgerEntryBudget) {
      return { kind: 'incomplete', reason: 'ledger-budget-overflow', metrics: metricsFrom(packet, current, 0, 0, []) }
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

    const interaction = buildInteraction(packet, current)
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

/** The bounded, ID-free projection of one sealed ledger row. */
interface SealedLedgerEntryV1 {
  readonly sourceSeq: number
  readonly occurredAt: number
  readonly classification: string
  readonly targetSummary: string
  readonly resultCategory: SealResultStatusV1
}

/**
 * Project one sealed activity row to a bounded, ID-free summary, or undefined when
 * any of the five projected fields is malformed (non-numeric seq/time, non-string
 * classification/summary, or an out-of-set terminal category). Validating before
 * projection keeps a malformed row from ever reaching the budget's canonicalJson
 * (which would throw and escape compileSealed) and satisfies the closed-set,
 * no-unknown-field contract for the sealed ledger.
 */
function projectActivity(activity: unknown): SealedLedgerEntryV1 | undefined {
  if (activity === null || typeof activity !== 'object') return undefined
  const a = activity as Record<string, unknown>
  if (!nonNegativeSafeInteger(a.sourceSeq) || !nonNegativeSafeInteger(a.occurredAt)
    || typeof a.classification !== 'string' || typeof a.targetSummary !== 'string'
    || (a.resultCategory !== 'completed' && a.resultCategory !== 'tool-error' && a.resultCategory !== 'sandbox-denied')) return undefined
  return Object.freeze({
    sourceSeq: a.sourceSeq,
    occurredAt: a.occurredAt,
    classification: a.classification,
    targetSummary: a.targetSummary,
    resultCategory: a.resultCategory,
  })
}

/** Project one sealed catalog epoch to the closed three-field shape, or undefined
 * when it carries any unknown field or an out-of-set value. Unknown fields are
 * rejected fail-closed rather than silently stripped so a schema violation cannot
 * smuggle content into a branded dossier. */
function projectEpochs(epochs: readonly unknown[]): readonly { readonly epoch: number; readonly headerEventSeq: number; readonly commitment: string }[] | undefined {
  const projected: { readonly epoch: number; readonly headerEventSeq: number; readonly commitment: string }[] = []
  for (const epoch of epochs) {
    if (epoch === null || typeof epoch !== 'object') return undefined
    const e = epoch as Record<string, unknown>
    const keys = Object.keys(e)
    if (keys.length !== 3 || keys.some(key => key !== 'epoch' && key !== 'headerEventSeq' && key !== 'commitment')) return undefined
    if (!nonNegativeSafeInteger(e.epoch) || !nonNegativeSafeInteger(e.headerEventSeq) || !nonEmptyString(e.commitment)) return undefined
    projected.push(Object.freeze({ epoch: e.epoch as number, headerEventSeq: e.headerEventSeq as number, commitment: e.commitment as string }))
  }
  return Object.freeze(projected)
}

/**
 * Build the bounded, ID-free sealed trajectory section. The catalog epochs carried
 * by the packet express the header freeze under sealed-input semantics; the
 * environment section remains the minimal closed-set evidence marker. Each
 * seal/activity row is projected to a content-free summary (sourceSeq, time,
 * classification, target summary, terminal outcome) and copies neither the seal's
 * resolvable identifiers (callId, request fields, canonical JSON) nor any tool
 * result content. Returns undefined when a row or epoch is structurally malformed
 * so the caller fails closed.
 */
function buildInteraction(packet: SealedParentSessionFactsV1, currentFacts: SealedDossierCurrentFactsV1): JsonValue | undefined {
  const activityBySourceSeq = new Map<number, { readonly occurredAt: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: SealResultStatusV1 }>()
  const ledger: SealedLedgerEntryV1[] = []
  for (const activity of packet.activities) {
    const projected = projectActivity(activity)
    if (projected === undefined) return undefined
    ledger.push(projected)
    activityBySourceSeq.set(projected.sourceSeq, projected)
  }

  let currentSeal: SealedLedgerEntryV1 | undefined
  if (packet.current !== undefined) {
    const projected = projectActivity(packet.current.activity)
    if (projected === undefined) return undefined
    currentSeal = projected
  }

  const tail: SealedLedgerEntryV1[] = []
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

  const catalogEpochs = projectEpochs(packet.catalogEpochs)
  if (catalogEpochs === undefined) return undefined

  return Object.freeze({
    sealed: Object.freeze({
      ...(currentSeal === undefined ? {} : { current: currentSeal }),
      tail: Object.freeze(tail),
      ledger: Object.freeze(ledger),
      catalogEpochs,
      ...(currentFacts.excerpts === undefined ? {} : {
        excerpts: currentFacts.excerpts,
        excerptTruncated: currentFacts.excerptTruncated ?? 0,
      }),
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
