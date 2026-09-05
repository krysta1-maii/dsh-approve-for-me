import { parseAuthorizationExtractionSubmissionV1 } from '../domain/extraction-protocol.js'
import type { AuthorizationExtractionSubmissionV1 } from '../domain/extraction-protocol.js'
import { ReviewProtocolError } from './decision-channel.js'
import type { ReviewClock } from './decision-channel.js'

/**
 * One-shot extraction result channel (WP7-b), mirroring DecisionChannel
 * discipline: the scoped extraction tool stages a candidate and the
 * child-scoped tools/result observer submits it with the ACTUAL extractor
 * Session id, so identity never comes from model payload alone. Arming throws
 * synchronously when the extraction can never be pending; an extraction that
 * never entered the channel is never delivered.
 */
export interface AuthorizationExtractionRequest {
  readonly extractionId: string
  readonly parentSessionId: string
  readonly extractorSessionId: string
  readonly generation: string
  readonly extractorVersion: string
  readonly throughSeq: number
  readonly deadlineAt: number
}

export interface ExtractionSubmissionContext {
  readonly actualExtractorSessionId: string
  readonly receivedAt?: number
}

export type SubmitExtractionResult =
  | { readonly status: 'accepted'; readonly submission: AuthorizationExtractionSubmissionV1 }
  | { readonly status: 'duplicate'; readonly extractionId: string }
  | { readonly status: 'identity-mismatch'; readonly extractionId: string }
  | { readonly status: 'invalid'; readonly extractionId?: string; readonly error: TypeError }
  | { readonly status: 'late'; readonly extractionId: string }
  | { readonly status: 'unknown'; readonly extractionId: string }

export interface ExtractionChannel {
  arm(request: AuthorizationExtractionRequest, signal?: AbortSignal): Promise<AuthorizationExtractionSubmissionV1>
  submit(payload: unknown, context: ExtractionSubmissionContext): SubmitExtractionResult
  cancel(extractionId: string, code?: 'aborted' | 'cancelled' | 'delivery-failed', message?: string): boolean
  dispose(): void
}

interface PendingExtraction {
  readonly request: AuthorizationExtractionRequest
  readonly resolve: (submission: AuthorizationExtractionSubmissionV1) => void
  readonly reject: (error: ReviewProtocolError) => void
  readonly timer: unknown
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

type TerminalStatus = 'accepted' | 'aborted' | 'cancelled' | 'delivery-failed' | 'disposed' | 'identity-mismatch' | 'invalid-result' | 'timed-out'

const systemClock: ReviewClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function routingExtractionId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>).extractionId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class DefaultExtractionChannel implements ExtractionChannel {
  private readonly pending = new Map<string, PendingExtraction>()
  private readonly terminal = new Map<string, TerminalStatus>()
  private disposed = false

  constructor(
    private readonly clock: ReviewClock = systemClock,
    private readonly terminalHistoryLimit = 1024,
  ) {
    if (!Number.isSafeInteger(terminalHistoryLimit) || terminalHistoryLimit < 1) {
      throw new TypeError('terminalHistoryLimit must be a positive safe integer')
    }
  }

  arm(request: AuthorizationExtractionRequest, signal?: AbortSignal): Promise<AuthorizationExtractionSubmissionV1> {
    if (this.disposed) throw new ReviewProtocolError('disposed', 'extraction channel is disposed')
    if (this.pending.has(request.extractionId) || this.terminal.has(request.extractionId)) {
      throw new TypeError('extraction ' + request.extractionId + ' has already been armed')
    }
    if (signal?.aborted) {
      this.remember(request.extractionId, 'aborted')
      throw new ReviewProtocolError('aborted', 'extraction ' + request.extractionId + ' was aborted before delivery')
    }
    const delay = request.deadlineAt - this.clock.now()
    if (delay <= 0) {
      this.remember(request.extractionId, 'timed-out')
      throw new ReviewProtocolError('timed-out', 'extraction ' + request.extractionId + ' reached its deadline')
    }
    return new Promise<AuthorizationExtractionSubmissionV1>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.rejectPending(request.extractionId, 'timed-out', 'extraction ' + request.extractionId + ' reached its deadline')
      }, delay)
      const onAbort = signal === undefined
        ? undefined
        : () => { this.rejectPending(request.extractionId, 'aborted', 'extraction ' + request.extractionId + ' was aborted') }
      if (onAbort !== undefined) signal!.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.extractionId, {
        request,
        resolve,
        reject,
        timer,
        ...signal === undefined ? {} : { signal },
        ...onAbort === undefined ? {} : { onAbort },
      })
    })
  }

  submit(payload: unknown, context: ExtractionSubmissionContext): SubmitExtractionResult {
    const routedExtractionId = routingExtractionId(payload)
    let submission: AuthorizationExtractionSubmissionV1
    try {
      submission = parseAuthorizationExtractionSubmissionV1(payload)
    } catch (error: unknown) {
      const typed = error instanceof TypeError ? error : new TypeError(String(error))
      // An invalid payload must not terminate another child's pending
      // extraction: only the exact pending entry whose owning extractor matches
      // the actual caller may be closed on an invalid result.
      const pending = routedExtractionId === undefined ? undefined : this.pending.get(routedExtractionId)
      if (pending !== undefined && pending.request.extractorSessionId === context.actualExtractorSessionId) {
        this.rejectPending(routedExtractionId!, 'invalid-result', 'extraction ' + routedExtractionId + ' returned an invalid result')
      }
      return { status: 'invalid', ...routedExtractionId === undefined ? {} : { extractionId: routedExtractionId }, error: typed }
    }
    const entry = this.pending.get(submission.extractionId)
    if (entry === undefined) {
      const terminal = this.terminal.get(submission.extractionId)
      if (terminal === 'accepted') return { status: 'duplicate', extractionId: submission.extractionId }
      if (terminal !== undefined) return { status: 'late', extractionId: submission.extractionId }
      return { status: 'unknown', extractionId: submission.extractionId }
    }
    const now = context.receivedAt ?? this.clock.now()
    if (now > entry.request.deadlineAt) {
      this.rejectPending(submission.extractionId, 'timed-out', 'extraction ' + submission.extractionId + ' returned after its deadline')
      return { status: 'late', extractionId: submission.extractionId }
    }
    const matches = submission.parentSessionId === entry.request.parentSessionId
      && submission.extractorSessionId === entry.request.extractorSessionId
      && context.actualExtractorSessionId === entry.request.extractorSessionId
      && submission.generation === entry.request.generation
      && submission.extractorVersion === entry.request.extractorVersion
      && submission.throughSeq === entry.request.throughSeq
    if (!matches) {
      this.rejectPending(submission.extractionId, 'identity-mismatch', 'extraction ' + submission.extractionId + ' returned mismatched identity')
      return { status: 'identity-mismatch', extractionId: submission.extractionId }
    }
    this.pending.delete(submission.extractionId)
    this.cleanup(entry)
    this.remember(submission.extractionId, 'accepted')
    entry.resolve(submission)
    return { status: 'accepted', submission }
  }

  cancel(extractionId: string, code: 'aborted' | 'cancelled' | 'delivery-failed' = 'cancelled', message?: string): boolean {
    return this.rejectPending(extractionId, code, message ?? 'extraction ' + extractionId + ' was ' + code)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const extractionId of [...this.pending.keys()]) {
      this.rejectPending(extractionId, 'disposed', 'extraction ' + extractionId + ' was closed with the channel')
    }
  }

  private rejectPending(extractionId: string, code: Exclude<TerminalStatus, 'accepted'>, message: string): boolean {
    const entry = this.pending.get(extractionId)
    if (entry === undefined) return false
    this.pending.delete(extractionId)
    this.cleanup(entry)
    this.remember(extractionId, code)
    entry.reject(new ReviewProtocolError(code, message))
    return true
  }

  private cleanup(entry: PendingExtraction): void {
    this.clock.clearTimeout(entry.timer)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
  }

  private remember(extractionId: string, status: TerminalStatus): void {
    this.terminal.set(extractionId, status)
    while (this.terminal.size > this.terminalHistoryLimit) {
      const oldest = this.terminal.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.terminal.delete(oldest)
    }
  }
}
