import { randomUUID } from 'node:crypto'
import { ReviewProtocolError } from './decision-channel.js'
import { EXTRACTION_PROVIDER, parseExtractorProviderData } from '../domain/extraction-protocol.js'
import type {
  AuthorizationExtractionSubmissionV1,
  ExtractorProviderDataV1,
} from '../domain/extraction-protocol.js'
import {
  createAuthorizationEntryV1,
  createExtractionCheckpointV1,
  extractionInputHash,
  genesisAuthorizationHash,
  genesisExtractionCheckpointHash,
} from '../domain/authorization-ledger.js'
import type { AuthorizationEntryV1 } from '../domain/authorization-ledger.js'
import type { ReviewerProviderDataV1, ReviewerTextBlock } from '../domain/protocol.js'
import {
  collectAuthorizationInputWindow,
  DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS,
  verifyAuthorizationEntriesLiveV1,
} from './authorization-verification.js'
import type { AuthorizationEventAt, AuthorizationInputItemV1 } from './authorization-verification.js'
import type { AuthorizationExtractionRequest, ExtractionChannel } from './extraction-channel.js'
import type { DshStorageDomainAuthorizationLedger } from '../dsh/storage-domain-authorization-ledger.js'
import type { ManagedReviewerPort, ParentAuthority } from '../ports/managed-reviewer.js'
import type { SerialLanes } from './serial-lanes.js'

/**
 * WP7-b2 authorization extraction coordinator (plan §5 decision 6). One
 * extract call performs exactly one incremental extraction for one parent
 * lifecycle: read the checkpoint tip, collect the bounded verbatim user
 * window, ensure one extractor child, arm the channel, deliver the request,
 * await the typed submission, Host-verify every candidate verbatim against
 * the live Session, then append the hash-linked batch with its checkpoint.
 *
 * Discipline mirrors the review coordinator: every recovery attempt inside
 * one extract shares ONE absolute deadline that is never extended (a
 * contaminated-child rotation is infrastructure recovery, not a new window);
 * the effective deadline is the earlier of the caller's deadline and this
 * coordinator's own bounded budget, so extraction can never lengthen the
 * authority an outer approval flow granted. The extractor is a parser only:
 * anything that fails Host verification is dropped before any write, storage
 * pollution reads as 'unavailable', and the status surface is closed.
 */

export type AuthorizationExtractionStatus =
  | 'created'
  | 'identical'
  | 'conflict'
  | 'unavailable'
  | 'skipped'
  | 'failed'
  | 'invalid'

/**
 * Approval-time sync-tail budget policy (WP7 smoke fix): the tail extraction
 * runs BEFORE the sealed read and review on the same machine-policy run, so it
 * must never consume the run's whole budget — a scripted/slow/absent model
 * otherwise starves the actual decision until the run deadline (observed in
 * the artifact smoke: extraction stalled the full timeoutMs and the gate fell
 * to 'deadline'/'unavailable' without ever reaching the composed answerer).
 * The tail gets at most a quarter of the remaining run budget (at least 1ms
 * so a nearly-expired run degrades to 'failed' extraction instead of
 * extending the run); the coordinator still applies its own cap on top.
 */
export function boundedSyncTailDeadline(now: number, outerDeadlineAt: number): number | undefined {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(outerDeadlineAt)) return undefined
  const remaining = outerDeadlineAt - now
  if (remaining <= 1) return undefined
  return now + Math.max(1, Math.floor(remaining / 4))
}

export interface AuthorizationExtractionCoordinator<Parent, SessionId extends string = string> {
  extract(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly lifecycleFingerprint: string
    readonly eventAt: AuthorizationEventAt
    /** Newest user/message seq this extraction must cover. */
    readonly throughSeq: number
    /**
     * Absolute outer deadline. Defaults to now() + timeoutMs; the effective
     * value is min(given, now() + timeoutMs) and never extends the caller's
     * window beyond this coordinator's bounded budget.
     */
    readonly deadlineAt?: number
    readonly signal?: AbortSignal
  }): Promise<AuthorizationExtractionStatus>
}

export interface AuthorizationExtractionCoordinatorOptions<Parent, SessionId extends string = string> {
  readonly port: ManagedReviewerPort<Parent, SessionId>
  readonly channel: ExtractionChannel
  readonly ledger: Pick<DshStorageDomainAuthorizationLedger, 'appendBatch' | 'read' | 'readCheckpoint'>
  readonly preset: ExtractorProviderDataV1
  readonly lane: SerialLanes
  readonly timeoutMs: number
  /** Capacity ceiling per extractor child before a clean renew (default 64). */
  readonly maxDeliveryAttemptsPerChild?: number
  /** Per-window user-message budget forwarded to the input collector. */
  readonly maxExtractionEvents?: number
  readonly now?: () => number
  readonly extractionId?: () => string
}

/** True for Guarded Continuable errors that mean the selected child is contaminated. */
function isContaminationError(error: unknown): boolean {
  return error instanceof Error && /contaminated|unauthorized transcript/i.test(error.message)
}

interface Delivery {
  readonly request: AuthorizationExtractionRequest
  readonly content: readonly ReviewerTextBlock[]
}

export class DefaultAuthorizationExtractionCoordinator<Parent, SessionId extends string = string>
  implements AuthorizationExtractionCoordinator<Parent, SessionId> {
  private readonly now: () => number
  private readonly extractionId: () => string
  private readonly maxDeliveryAttemptsPerChild: number
  private readonly maxExtractionEvents: number

  constructor(private readonly options: AuthorizationExtractionCoordinatorOptions<Parent, SessionId>) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }
    this.maxDeliveryAttemptsPerChild = options.maxDeliveryAttemptsPerChild ?? 64
    if (!Number.isSafeInteger(this.maxDeliveryAttemptsPerChild) || this.maxDeliveryAttemptsPerChild < 1) {
      throw new TypeError('maxDeliveryAttemptsPerChild must be a positive safe integer')
    }
    this.maxExtractionEvents = options.maxExtractionEvents ?? DEFAULT_MAX_AUTHORIZATION_EXTRACTION_EVENTS
    if (!Number.isSafeInteger(this.maxExtractionEvents) || this.maxExtractionEvents < 1) {
      throw new TypeError('maxExtractionEvents must be a positive safe integer')
    }
    this.now = options.now ?? (() => Date.now())
    this.extractionId = options.extractionId ?? randomUUID
  }

  extract(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly lifecycleFingerprint: string
    readonly eventAt: AuthorizationEventAt
    readonly throughSeq: number
    readonly deadlineAt?: number
    readonly signal?: AbortSignal
  }): Promise<AuthorizationExtractionStatus> {
    if (input.signal?.aborted) return Promise.resolve('failed')
    const startedAt = this.now()
    const budgetCap = startedAt + this.options.timeoutMs
    const requested = input.deadlineAt ?? budgetCap
    if (!Number.isSafeInteger(requested) || requested <= startedAt) return Promise.resolve('failed')
    // Never extend the outer authority: the extraction window ends at the
    // earlier of the caller's absolute deadline and this coordinator's budget.
    const deadlineAt = Math.min(requested, budgetCap)
    return this.options.lane
      .run('authorization-extraction:' + input.lifecycleFingerprint, () => this.extractInLane(input, deadlineAt))
  }

  /**
   * The hot-path catch-all: extraction must never throw into an approval flow.
   * Arm failures land here too — an extraction that never entered the channel
   * is never delivered and no rotation is attempted for it (review discipline).
   */
  private async extractInLane(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly lifecycleFingerprint: string
      readonly eventAt: AuthorizationEventAt
      readonly throughSeq: number
      readonly signal?: AbortSignal
    },
    deadlineAt: number,
  ): Promise<AuthorizationExtractionStatus> {
    try {
      return await this.extractAttempt(input, deadlineAt)
    } catch {
      return 'failed'
    }
  }

  private async extractAttempt(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly lifecycleFingerprint: string
      readonly eventAt: AuthorizationEventAt
      readonly throughSeq: number
      readonly signal?: AbortSignal
    },
    deadlineAt: number,
  ): Promise<AuthorizationExtractionStatus> {
    const lifecycle = input.lifecycleFingerprint
    const tip = await this.options.ledger.readCheckpoint(lifecycle)
    if (tip === undefined) return 'unavailable'
    const afterSeq = tip === null ? -1 : tip.throughSeq
    const previousCheckpointHash = tip === null
      ? genesisExtractionCheckpointHash(lifecycle)
      : tip.checkpointHash
    // Idempotent incremental boundary: this range is already extracted.
    if (input.throughSeq <= afterSeq) return 'skipped'
    // The collector accepts only non-negative bounds; seq 0 is the runtime
    // genesis event and is never a user/message, so the genesis lower bound
    // -1 clamps to 0 without skipping any extractable input.
    const window = collectAuthorizationInputWindow({
      afterSeq: Math.max(0, afterSeq),
      throughSeq: input.throughSeq,
      eventAt: input.eventAt,
      maxEvents: this.maxExtractionEvents,
    })
    if (window.items.length === 0) {
      // No direct human user language in range: advance the checkpoint
      // deterministically without waking the model. Silence is the fail-safe
      // direction (absence of drawer rows never amplifies permissions).
      const checkpoint = createExtractionCheckpointV1({
        lifecycleFingerprint: lifecycle,
        throughSeq: window.throughSeq,
        extractorVersion: this.options.preset.extractorVersion,
        inputHash: extractionInputHash(window.items),
        producedEntryHashes: [],
        previousCheckpointHash,
      })
      return await this.options.ledger.appendBatch(lifecycle, [], checkpoint)
    }
    // An already-expired lane task must not create a child it will never use.
    if (this.now() >= deadlineAt) return 'failed'
    let childId = await this.ensureExtractorChild(input.authority, input.signal)
    let delivery = this.buildDelivery(input, childId, window.items, window.throughSeq, deadlineAt, this.extractionId())
    if (this.now() >= deadlineAt) return 'failed'
    // Arm throws synchronously when the extraction can never be pending
    // (disposed channel, duplicate id, expired deadline, pre-aborted signal):
    // such an extraction is never delivered.
    const deliverOptions = input.signal === undefined ? undefined : { signal: input.signal }
    let pending = this.options.channel.arm(delivery.request, input.signal)
    void pending.catch(() => undefined)
    try {
      await this.options.port.deliver(input.authority, childId, delivery.content, deliverOptions)
    } catch (error: unknown) {
      if (!isContaminationError(error)) {
        this.options.channel.cancel(delivery.request.extractionId, 'delivery-failed', 'extraction ' + delivery.request.extractionId + ' delivery failed')
        await pending.catch(() => undefined)
        return 'failed'
      }
      // Contamination recovery: drain and reserve a clean replacement, then
      // re-arm with a FRESH extraction id (the old id stays tombstoned in the
      // channel) under the SAME absolute deadline — never a new window.
      childId = await this.options.port.rotate(input.authority, childId, input.signal)
      this.options.channel.cancel(delivery.request.extractionId, 'delivery-failed', 'extraction ' + delivery.request.extractionId + ' abandoned after child contamination')
      await pending.catch(() => undefined)
      if (this.now() >= deadlineAt) return 'failed'
      delivery = this.buildDelivery(input, childId, window.items, window.throughSeq, deadlineAt, this.extractionId())
      pending = this.options.channel.arm(delivery.request, input.signal)
      void pending.catch(() => undefined)
      try {
        await this.options.port.deliver(input.authority, childId, delivery.content, deliverOptions)
      } catch {
        this.options.channel.cancel(delivery.request.extractionId, 'delivery-failed', 'extraction ' + delivery.request.extractionId + ' delivery failed')
        await pending.catch(() => undefined)
        return 'failed'
      }
    }
    let submission: AuthorizationExtractionSubmissionV1
    try {
      submission = await this.awaitSubmission(delivery.request.extractionId, pending, deadlineAt, input.signal)
    } catch {
      return 'failed'
    }
    return await this.verifyAndAppend(input, lifecycle, window.items, window.throughSeq, previousCheckpointHash, submission)
  }

  /**
   * Host verification gate, BEFORE any write: every candidate must cite a seq
   * that was actually shown in the delivered window (a seq outside it is
   * tampering), is ordered by sourceSeq, re-binds occurredAt from the Host-
   * collected window, chains onto the current validated drawer tip, and passes
   * the same verbatim live re-verification used for drawer reads. One failure
   * poisons the whole batch and nothing is written.
   */
  private async verifyAndAppend(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly lifecycleFingerprint: string
      readonly eventAt: AuthorizationEventAt
      readonly throughSeq: number
    },
    lifecycle: string,
    items: readonly AuthorizationInputItemV1[],
    throughSeq: number,
    previousCheckpointHash: string,
    submission: AuthorizationExtractionSubmissionV1,
  ): Promise<AuthorizationExtractionStatus> {
    const shown = new Map<number, number>()
    for (const item of items) shown.set(item.seq, item.occurredAt)
    for (const candidate of submission.entries) {
      if (!shown.has(candidate.sourceSeq)) return 'invalid'
    }
    const ordered = [...submission.entries].sort((left, right) => left.sourceSeq - right.sourceSeq)
    const existing = await this.options.ledger.read(lifecycle)
    if (existing === undefined) return 'unavailable'
    let previousEntryHash = existing.length === 0
      ? genesisAuthorizationHash(lifecycle)
      : existing[existing.length - 1]!.entryHash
    const entries: AuthorizationEntryV1[] = []
    for (const candidate of ordered) {
      const entry = createAuthorizationEntryV1({
        lifecycleFingerprint: lifecycle,
        sourceSeq: candidate.sourceSeq,
        occurredAt: shown.get(candidate.sourceSeq)!,
        quote: candidate.quote,
        effect: candidate.effect,
        coverage: candidate.coverage,
        summary: candidate.summary,
        extractorVersion: this.options.preset.extractorVersion,
        previousEntryHash,
      })
      previousEntryHash = entry.entryHash
      entries.push(entry)
    }
    if (verifyAuthorizationEntriesLiveV1(entries, input.eventAt) === undefined) return 'invalid'
    const checkpoint = createExtractionCheckpointV1({
      lifecycleFingerprint: lifecycle,
      throughSeq,
      extractorVersion: this.options.preset.extractorVersion,
      inputHash: extractionInputHash(items),
      producedEntryHashes: entries.map(entry => entry.entryHash),
      previousCheckpointHash,
    })
    return await this.options.ledger.appendBatch(lifecycle, entries, checkpoint)
  }

  /** Race the armed extraction against the shared absolute deadline and caller abort. */
  private async awaitSubmission(
    extractionId: string,
    pending: Promise<AuthorizationExtractionSubmissionV1>,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<AuthorizationExtractionSubmissionV1> {
    const controller = new AbortController()
    const onCallerAbort = (): void => { controller.abort() }
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    const timer = setTimeout(() => { controller.abort() }, Math.max(0, deadlineAt - this.now()))
    try {
      return await new Promise<AuthorizationExtractionSubmissionV1>((resolve, reject) => {
        const onAbort = (): void => {
          // Best-effort containment: closing the armed extraction also
          // settles pending; a late model result is then judged late by the
          // channel itself.
          this.options.channel.cancel(extractionId, 'aborted', 'extraction ' + extractionId + ' aborted by deadline or caller')
          reject(new ReviewProtocolError(
            this.now() >= deadlineAt ? 'timed-out' : 'aborted',
            'extraction ' + extractionId + ' did not settle before its deadline',
          ))
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) {
          onAbort()
          return
        }
        pending.then(
          submission => {
            controller.signal.removeEventListener('abort', onAbort)
            resolve(submission)
          },
          error => {
            controller.signal.removeEventListener('abort', onAbort)
            reject(error instanceof Error ? error : new Error(String(error)))
          },
        )
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  private buildDelivery(
    input: {
      readonly authority: ParentAuthority<Parent, SessionId>
      readonly lifecycleFingerprint: string
    },
    childId: SessionId,
    items: readonly AuthorizationInputItemV1[],
    throughSeq: number,
    deadlineAt: number,
    extractionId: string,
  ): Delivery {
    const preset = this.options.preset
    const request: AuthorizationExtractionRequest = {
      extractionId,
      parentSessionId: input.authority.sessionId,
      extractorSessionId: childId,
      generation: preset.generation,
      extractorVersion: preset.extractorVersion,
      throughSeq,
      deadlineAt,
    }
    // One text block carrying every identity field the model must echo back
    // in its structured submission; the channel still binds identity to the
    // ACTUAL extractor Session, so payload identity is corroboration only.
    const text = JSON.stringify({
      protocolVersion: 1,
      extractionId,
      parentSessionId: input.authority.sessionId,
      extractorSessionId: childId,
      generation: preset.generation,
      extractorVersion: preset.extractorVersion,
      throughSeq,
      window: items.map(item => ({ seq: item.seq, text: item.text })),
    })
    return { request, content: Object.freeze([{ type: 'text', text }]) }
  }

  /**
   * Directory-ensure replica scoped to the extraction provider: one accurate
   * extractor child per parent Session and configuration generation.
   * Contaminated and retired children are permanently ineligible; a child at
   * its delivery ceiling is cleanly renewed; several matches are an invariant
   * violation. Discovery only — never a run, deadline, or decision here.
   */
  private async ensureExtractorChild(
    authority: ParentAuthority<Parent, SessionId>,
    signal: AbortSignal | undefined,
  ): Promise<SessionId> {
    const desired = parseExtractorProviderData(this.options.preset)
    const children = await this.options.port.list(authority.sessionId, signal)
    const matching = children.filter((child) => {
      if (child.provider !== EXTRACTION_PROVIDER || child.parentSessionId !== authority.sessionId) return false
      if (child.contaminated || child.retired) return false
      if (!Number.isSafeInteger(child.deliveryAttempts) || child.deliveryAttempts < 0) {
        throw new Error('managed Authorization Extractor ' + String(child.id) + ' has an invalid durable delivery-attempt count')
      }
      try {
        const data = parseExtractorProviderData(child.providerData)
        return data.generation === desired.generation
          && data.configurationFingerprint === desired.configurationFingerprint
      } catch {
        return false
      }
    })
    if (matching.length > 1) {
      throw new Error('multiple Authorization Extractors match parent ' + String(authority.sessionId) + ' and generation ' + desired.generation)
    }
    const existing = matching[0]
    if (existing !== undefined) {
      if (existing.deliveryAttempts >= this.maxDeliveryAttemptsPerChild) {
        return this.options.port.renew(authority, existing.id, signal)
      }
      return existing.id
    }
    return this.options.port.create(authority, {
      label: 'Authorization Extractor',
      // The managed port is shared with the Reviewer directory and types
      // providerData as ReviewerProviderDataV1; the extractor descriptor is
      // the sibling ExtractorProviderDataV1 shape, re-validated by the
      // provider materializer via parseExtractorProviderData.
      providerData: desired as unknown as ReviewerProviderDataV1,
      ...signal === undefined ? {} : { signal },
    })
  }
}
