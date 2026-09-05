import { SerialLanes } from './serial-lanes.js'
import { projectSealForResultV1, matchApprovalSnapshotsForExecutionV1 } from './seal-projection.js'
import { isApprovalSnapshotRecordV1, isToolExecutionFactRecordV2 } from '../dsh/storage-domain-fact-repositories.js'
import type { ApprovalSnapshotRecordV1, ToolExecutionFactRecordV2 } from '../domain/dossier.js'
import type { SessionLifecycleIdentityV1 } from '../domain/records.js'
import type { ActivityV1, SealV1 } from '../domain/sealed-facts.js'

/**
 * WP8-c: phase-three background-once seal backfill (plan §5 三期 + §2 L21).
 *
 * Old sessions carry approval-bound execution facts that predate the sealed
 * ledger (or were captured while the ledger was unavailable) and are therefore
 * permanently unsealed — unsealed history can never be automatically
 * authorized. This runner re-runs, per lifecycle, the FULL live verification
 * pipeline (strict shape parse → unique approval-snapshot binding → live
 * Session re-bind of request and result events → projector resolvability →
 * the shared seal construction formula → create-once append) and seals only
 * what passes every check.
 *
 * Fail-closed discipline: ANY failure — missing/ambiguous approval snapshot,
 * live re-bind mismatch, unresolvable projector, append conflict, unavailable
 * storage — stops the whole lifecycle run. A partially backfilled lifecycle
 * stays exactly as authorized as it was: seals are an integrity index, never
 * an authorization, and a stopped lifecycle simply remains unsealed. A record
 * without a durable result also stops the run: sealing later rows first would
 * move the chain tip past it and permanently block its live capture.
 *
 * Concurrency discipline: one SerialLanes writer per lifecycle (key prefix
 * `seal-backfill:`), at most one attempt per lifecycle per process (in-memory
 * set, placed before the run starts), abort as soon as the session shows new
 * activity (a user/message or a new approval run). Mid-run abort is safe
 * because the ledger is append-only/create-once and every read re-validates
 * the full chain.
 */

export interface SealBackfillLiveEventView {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}

export type SealBackfillEventAt = (seq: number) => SealBackfillLiveEventView | undefined

export interface SealBackfillSealedRow {
  readonly seal: SealV1
  readonly activity: ActivityV1
}

/** Narrow injected ports; every storage-facing read distinguishes "unavailable" (undefined) from "empty". */
export interface SealBackfillDependencies {
  /** Undefined means the fact sidecar is unavailable (fail closed, count as attempted). */
  listExecutions(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly unknown[] | undefined>
  /** Undefined means the approval sidecar is unavailable. */
  listApprovals(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly unknown[] | undefined>
  /** Undefined means the sealed ledger is unavailable or polluted. */
  readSealed(lifecycleFingerprint: string): Promise<readonly SealBackfillSealedRow[] | undefined>
  appendSealed(seal: SealV1, activity: ActivityV1): Promise<'created' | 'identical' | 'conflict' | 'unavailable'>
  /** True only when the projector registry still resolves this exact tool/projectorId binding. */
  projectorResolvable(toolName: string, projectorId: string): boolean
  now(): number
  /** Bounded scalar-only log sink; never ids, hashes, or content. */
  log(line: string): void
}

export type SealBackfillStopReason =
  | 'executions-unavailable'
  | 'sealed-unavailable'
  | 'approvals-unavailable'
  | 'record-invalid'
  | 'record-not-resulted'
  | 'approval-ambiguous'
  | 'live-rebind-failed'
  | 'projector-unresolvable'
  | 'projection-failed'
  | 'append-conflict'
  | 'append-unavailable'
  | 'dependency-failed'

export type SealBackfillOutcome =
  | { readonly kind: 'settled'; readonly sealed: number; readonly skippedAlreadySealed: number; readonly durationMs: number }
  | { readonly kind: 'stopped'; readonly reason: SealBackfillStopReason; readonly sealed: number }
  | { readonly kind: 'aborted'; readonly sealed: number }

export type SealBackfillAttempt = Promise<SealBackfillOutcome> | 'already-attempted'

const LANE_PREFIX = 'seal-backfill:'

export class SealBackfillRunner {
  private readonly lanes = new SerialLanes()
  /** Lifecycle fingerprints already attempted in this process (placed before start). */
  private readonly attempted = new Set<string>()
  private readonly running = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private disposed = false

  constructor(private readonly deps: SealBackfillDependencies) {
    if (deps === null || typeof deps !== 'object'
      || typeof deps.listExecutions !== 'function'
      || typeof deps.listApprovals !== 'function'
      || typeof deps.readSealed !== 'function'
      || typeof deps.appendSealed !== 'function'
      || typeof deps.projectorResolvable !== 'function'
      || typeof deps.now !== 'function'
      || typeof deps.log !== 'function') {
      throw new TypeError('seal backfill dependencies must provide all narrow ports')
    }
  }

  /** True while a lane task for this lifecycle is in flight. */
  isRunning(lifecycleFingerprint: string): boolean {
    return this.running.has(lifecycleFingerprint)
  }

  hasAttempted(lifecycleFingerprint: string): boolean {
    return this.attempted.has(lifecycleFingerprint)
  }

  /**
   * Queue one backfill attempt. The once mark is placed synchronously before
   * the task starts, so a second trigger can never queue a second writer even
   * if it races the lane. 'already-attempted' covers both the once mark and a
   * still-running first attempt.
   */
  attempt(input: {
    readonly lifecycle: SessionLifecycleIdentityV1
    readonly lifecycleFingerprint: string
    readonly eventAt: SealBackfillEventAt
  }): SealBackfillAttempt {
    const fp = input.lifecycleFingerprint
    if (typeof fp !== 'string' || fp.length === 0 || this.attempted.has(fp) || this.disposed) {
      return 'already-attempted'
    }
    this.attempted.add(fp)
    const controller = this.controllers.get(fp) ?? new AbortController()
    this.controllers.set(fp, controller)
    this.running.add(fp)
    const startedAt = this.deps.now()
    const settled: Promise<SealBackfillOutcome> = this.lanes.run(LANE_PREFIX + fp, () => this.runOnce(input, controller.signal))
      .then((outcome): SealBackfillOutcome => {
        this.deps.log(backfillLogLine(outcome, this.deps.now() - startedAt))
        return outcome
      })
      .catch((): SealBackfillOutcome => {
        // The runner never rejects: a dependency that throws degrades to a
        // bounded stopped outcome so the fire-and-forget caller cannot leak
        // an unhandled rejection.
        this.deps.log('[approve-for-me seal-backfill] stopped reason=dependency-failed')
        return { kind: 'stopped', reason: 'dependency-failed', sealed: 0 }
      })
      .finally(() => {
        this.running.delete(fp)
        if (this.controllers.get(fp) === controller) this.controllers.delete(fp)
      })
    return settled
  }

  /** Abort the in-flight (or next queued) attempt for one lifecycle. */
  abort(lifecycleFingerprint: string): void {
    const controller = this.controllers.get(lifecycleFingerprint)
    if (controller === undefined) return
    this.controllers.delete(lifecycleFingerprint)
    controller.abort()
  }

  /** Abort every in-flight attempt and drain the writer lanes (dispose chain). */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const [fp, controller] of this.controllers) {
      this.controllers.delete(fp)
      controller.abort()
    }
    await this.lanes.drain()
  }

  private async runOnce(
    input: {
      readonly lifecycle: SessionLifecycleIdentityV1
      readonly lifecycleFingerprint: string
      readonly eventAt: SealBackfillEventAt
    },
    signal: AbortSignal,
  ): Promise<SealBackfillOutcome> {
    const { deps } = this
    let sealed = 0
    let skipped = 0
    const stopped = (reason: SealBackfillStopReason): SealBackfillOutcome => Object.freeze({ kind: 'stopped', reason, sealed })
    try {
      signal.throwIfAborted()
      const rawExecutions = await deps.listExecutions(input.lifecycle, signal)
      if (rawExecutions === undefined) return stopped('executions-unavailable')
      const chain = await deps.readSealed(input.lifecycleFingerprint)
      if (chain === undefined) return stopped('sealed-unavailable')
      const rawApprovals = await deps.listApprovals(input.lifecycle, signal)
      if (rawApprovals === undefined) return stopped('approvals-unavailable')
      const approvals: ApprovalSnapshotRecordV1[] = []
      for (const raw of rawApprovals) {
        signal.throwIfAborted()
        if (!isApprovalSnapshotRecordV1(raw)) return stopped('approvals-unavailable')
        approvals.push(raw)
      }
      // Strict parse first, then strict ascending request-eventSeq order; the
      // ledger append requires chain-internal monotonic sourceSeq.
      const records: ToolExecutionFactRecordV2[] = []
      for (const raw of rawExecutions) {
        signal.throwIfAborted()
        if (!isToolExecutionFactRecordV2(raw)) return stopped('record-invalid')
        records.push(raw)
      }
      records.sort((left, right) => left.request.eventSeq - right.request.eventSeq)
      const sealedSourceSeqs = new Set(chain.map(row => row.seal.sourceSeq))
      let prior = chain.at(-1)?.seal
      for (const record of records) {
        signal.throwIfAborted()
        if (sealedSourceSeqs.has(record.request.eventSeq)) {
          skipped += 1
          continue
        }
        // A record without a durable result cannot be sealed; sealing later
        // rows first would move the chain tip past it and block its live
        // capture forever, so the run stops and leaves it to live repair.
        if (record.result === undefined) return stopped('record-not-resulted')
        if (matchApprovalSnapshotsForExecutionV1(record, approvals).length !== 1) {
          return stopped('approval-ambiguous')
        }
        const requestEvent = input.eventAt(record.request.eventSeq)
        if (requestEvent === undefined
          || requestEvent.seq !== record.request.eventSeq
          || requestEvent.type !== record.request.eventType) {
          return stopped('live-rebind-failed')
        }
        const resultEvent = input.eventAt(record.result.eventSeq)
        if (resultEvent === undefined
          || resultEvent.seq !== record.result.eventSeq
          || resultEvent.type !== record.result.eventType
          || !Number.isSafeInteger(resultEvent.time)
          || resultEvent.time < 0) {
          return stopped('live-rebind-failed')
        }
        if (!deps.projectorResolvable(record.request.toolName, record.projection.projectorId)) {
          return stopped('projector-unresolvable')
        }
        const projection = projectSealForResultV1({
          lifecycleFingerprint: input.lifecycleFingerprint,
          record,
          approvals,
          prior,
          occurredAt: resultEvent.time,
        })
        if (projection === undefined) return stopped('projection-failed')
        const appended = await deps.appendSealed(projection.seal, projection.activity)
        if (appended === 'conflict') return stopped('append-conflict')
        if (appended === 'unavailable') return stopped('append-unavailable')
        prior = projection.seal
        if (appended === 'created') sealed += 1
      }
      return Object.freeze({ kind: 'settled', sealed, skippedAlreadySealed: skipped, durationMs: 0 })
    } catch (cause: unknown) {
      if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
        return Object.freeze({ kind: 'aborted', sealed })
      }
      return stopped('dependency-failed')
    }
  }
}

function backfillLogLine(outcome: SealBackfillOutcome, durationMs: number): string {
  const bounded = Number.isSafeInteger(durationMs) && durationMs >= 0 ? Math.min(durationMs, 0x7fffffff) : -1
  if (outcome.kind === 'settled') {
    return `[approve-for-me seal-backfill] settled sealed=${outcome.sealed} skipped=${outcome.skippedAlreadySealed} durationMs=${bounded}`
  }
  if (outcome.kind === 'aborted') {
    return `[approve-for-me seal-backfill] aborted sealed=${outcome.sealed} durationMs=${bounded}`
  }
  return `[approve-for-me seal-backfill] stopped reason=${outcome.reason} sealed=${outcome.sealed} durationMs=${bounded}`
}