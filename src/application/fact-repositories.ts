import { canonicalJson } from '../domain/json.js'
import type {
  ApprovalSnapshotRecordV1,
  ToolExecutionFactRecordV2,
} from '../domain/dossier.js'
import type { SessionLifecycleIdentityV1 } from '../domain/records.js'

/**
 * WP9-b lifecycle-retention prune verdict. Every non-'pruned' verdict is a
 * skip: the lifecycle's rows stay untouched. 'unavailable' additionally stops
 * a whole sweep (failure即止), because it signals storage/clock/config doubt
 * rather than a property of this one lifecycle.
 */
export type PruneLifecycleResult =
  | 'pruned'
  | 'skipped-live'
  | 'skipped-recent'
  | 'skipped-uncommitted'
  | 'unavailable'

/**
 * WP9-b fail-closed prune evidence. The repository re-validates everything it
 * is told: any value that is not an explicit, well-formed "safe to prune"
 * signal reads as its conservative skip. 'endedAt' must be a caller-observed
 * lifecycle end (e.g. a turn/end event time with no later activity); when it
 * cannot be produced the lifecycle is reported as live. 'live' must be true
 * whenever the caller cannot prove the absence of a live agent/session for
 * the lifecycle, and 'hasPendingApprovals' must be true whenever an
 * in-flight approval run or pending ask cannot be ruled out.
 */
export interface PruneLifecycleOptions {
  /** Retention grace measured from endedAt; a non-negative safe integer. */
  readonly graceMs: number
  /** Sweep clock reading; a safe integer that must not precede endedAt. */
  readonly now: number
  /** Caller-observed lifecycle end; anything else reads as still live. */
  readonly endedAt: number | undefined
  /** Caller-evidenced liveness; anything but an explicit false skips as live. */
  readonly live: boolean
  /** Caller-evidenced pending approvals; anything but an explicit false skips. */
  readonly hasPendingApprovals: boolean
}

/**
 * Shared skip-condition evaluation for prune implementations (fail closed).
 * Returns undefined only when the evidence explicitly allows the mechanical
 * prune to proceed; clock/config doubt maps to 'unavailable' (stop the
 * sweep), lifecycle-property doubt maps to its specific skip verdict.
 */
export function pruneSkipReason(options: PruneLifecycleOptions): PruneLifecycleResult | undefined {
  if (options.live !== false) return 'skipped-live'
  const endedAt = options.endedAt
  if (typeof endedAt !== 'number' || !Number.isSafeInteger(endedAt) || endedAt < 0 || Object.is(endedAt, -0)) {
    return 'skipped-live'
  }
  if (typeof options.graceMs !== 'number' || !Number.isSafeInteger(options.graceMs) || options.graceMs < 0) return 'unavailable'
  if (typeof options.now !== 'number' || !Number.isSafeInteger(options.now) || options.now < endedAt) return 'unavailable'
  if (options.now - endedAt < options.graceMs) return 'skipped-recent'
  if (options.hasPendingApprovals !== false) return 'skipped-uncommitted'
  return undefined
}

export interface ExecutionFactRepository {
  /** List an exact immutable session lifecycle; never merge reused session IDs. */
  list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ToolExecutionFactRecordV2[]>
  /** Create once; a repeat must be byte-identical or report a conflict. */
  create(record: ToolExecutionFactRecordV2): Promise<'created' | 'identical' | 'conflict'>
  /**
   * Persist content-free terminal evidence before the Host can append its
   * canonical result event. This is not settlement and is never consumed
   * without independent Session-event corroboration.
   */
  stageTerminal(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly terminalEvidence: NonNullable<ToolExecutionFactRecordV2['terminalEvidence']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'>
  /** Attach the durable matching result event without replacing request facts. */
  attachResult(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly result: NonNullable<ToolExecutionFactRecordV2['result']>
    readonly delegationReceipt?: NonNullable<ToolExecutionFactRecordV2['delegationReceipt']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'>
  get(input: {
    session: SessionLifecycleIdentityV1
    callId: string
    requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV2 | undefined>
  /**
   * WP9-b: prune one entire lifecycle's durable facts after its retention
   * window closes. The storage-backed realization covers the shared fact
   * domain (execution rows, approval snapshot rows, and both per-lifecycle
   * index rows); in-memory realizations prune their own store. Fail closed:
   * any evidence, read, or write doubt skips (never partially authorizes a
   * state the caller cannot trust), and the method never throws.
   */
  pruneLifecycle(session: SessionLifecycleIdentityV1, options: PruneLifecycleOptions): Promise<PruneLifecycleResult>
}

export interface ApprovalSnapshotRepository {
  /** List an exact immutable session lifecycle; never merge reused session IDs. */
  list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ApprovalSnapshotRecordV1[]>
  create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'>
  get(input: {
    session: SessionLifecycleIdentityV1
    approvalRequestId: string
    approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined>
  /**
   * WP9-b: same lifecycle-wide retention prune as
   * ExecutionFactRepository.pruneLifecycle; on the shared storage domain both
   * ports realize one operation (the executions facade entry point is what
   * the retention sweep calls).
   */
  pruneLifecycle(session: SessionLifecycleIdentityV1, options: PruneLifecycleOptions): Promise<PruneLifecycleResult>
}

export class InMemoryExecutionFactRepository implements ExecutionFactRepository {
  private readonly rows = new Map<string, ToolExecutionFactRecordV2>()

  async list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ToolExecutionFactRecordV2[]> {
    signal?.throwIfAborted()
    const prefix = `${this.lifecycleKey(session)}\0`
    return Object.freeze([...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record))
  }

  async create(record: ToolExecutionFactRecordV2): Promise<'created' | 'identical' | 'conflict'> {
    const key = this.key(record.session, record.request.callId, record.request.eventSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      this.rows.set(key, record)
      return 'created'
    }
    return canonicalJson(existing) === canonicalJson(record) ? 'identical' : 'conflict'
  }

  async stageTerminal(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly terminalEvidence: NonNullable<ToolExecutionFactRecordV2['terminalEvidence']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.key(input.session, input.callId, input.requestEventSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) return 'missing'
    const next: ToolExecutionFactRecordV2 = Object.freeze({
      ...existing,
      terminalEvidence: Object.freeze({
        isError: input.terminalEvidence.isError,
        outcome: Object.freeze({ ...input.terminalEvidence.outcome }),
        ...input.terminalEvidence.receipt === undefined
          ? {}
          : { receipt: Object.freeze({ ...input.terminalEvidence.receipt }) },
      }),
    })
    if (existing.terminalEvidence !== undefined) {
      return canonicalJson(existing) === canonicalJson(next) ? 'identical' : 'conflict'
    }
    this.rows.set(key, next)
    return 'updated'
  }

  async attachResult(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
    readonly result: NonNullable<ToolExecutionFactRecordV2['result']>
    readonly delegationReceipt?: NonNullable<ToolExecutionFactRecordV2['delegationReceipt']>
  }): Promise<'updated' | 'identical' | 'missing' | 'conflict'> {
    const key = this.key(input.session, input.callId, input.requestEventSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) return 'missing'
    const next = Object.freeze({
      ...existing,
      result: Object.freeze({ ...input.result }),
      ...input.delegationReceipt === undefined ? {} : { delegationReceipt: Object.freeze({ ...input.delegationReceipt }) },
    })
    if (existing.result !== undefined || existing.delegationReceipt !== undefined) {
      return canonicalJson(existing) === canonicalJson(next) ? 'identical' : 'conflict'
    }
    this.rows.set(key, next)
    return 'updated'
  }

  async get(input: {
    session: SessionLifecycleIdentityV1
    callId: string
    requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV2 | undefined> {
    return this.rows.get(this.key(input.session, input.callId, input.requestEventSeq))
  }

  async pruneLifecycle(session: SessionLifecycleIdentityV1, options: PruneLifecycleOptions): Promise<PruneLifecycleResult> {
    try {
      const skip = pruneSkipReason(options)
      if (skip !== undefined) return skip
      const prefix = `${this.lifecycleKey(session)}\0`
      // A stored execution without durable terminal evidence or its result
      // event is still in flight; the whole lifecycle stays (fail closed).
      for (const [key, record] of this.rows.entries()) {
        if (key.startsWith(prefix)
          && (record.terminalEvidence === undefined || record.result === undefined)) {
          return 'skipped-uncommitted'
        }
      }
      for (const key of [...this.rows.keys()]) {
        if (key.startsWith(prefix)) this.rows.delete(key)
      }
      return 'pruned'
    } catch {
      return 'unavailable'
    }
  }

  private lifecycleKey(session: SessionLifecycleIdentityV1): string {
    return canonicalJson(session)
  }

  private key(session: SessionLifecycleIdentityV1, callId: string, requestEventSeq: number): string {
    return `${this.lifecycleKey(session)}\0${callId}\0${requestEventSeq}`
  }
}

export class InMemoryApprovalSnapshotRepository implements ApprovalSnapshotRepository {
  private readonly rows = new Map<string, ApprovalSnapshotRecordV1>()

  async list(session: SessionLifecycleIdentityV1, signal?: AbortSignal): Promise<readonly ApprovalSnapshotRecordV1[]> {
    signal?.throwIfAborted()
    const prefix = `${this.lifecycleKey(session)}\0`
    return Object.freeze([...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record))
  }

  async create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical' | 'conflict'> {
    const key = this.key(record.session, record.approvalRequestId, record.approvalAskedSeq)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      this.rows.set(key, record)
      return 'created'
    }
    return canonicalJson(existing) === canonicalJson(record) ? 'identical' : 'conflict'
  }

  async get(input: {
    session: SessionLifecycleIdentityV1
    approvalRequestId: string
    approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined> {
    return this.rows.get(this.key(input.session, input.approvalRequestId, input.approvalAskedSeq))
  }

  async pruneLifecycle(session: SessionLifecycleIdentityV1, options: PruneLifecycleOptions): Promise<PruneLifecycleResult> {
    try {
      const skip = pruneSkipReason(options)
      if (skip !== undefined) return skip
      const prefix = `${this.lifecycleKey(session)}\0`
      for (const key of [...this.rows.keys()]) {
        if (key.startsWith(prefix)) this.rows.delete(key)
      }
      return 'pruned'
    } catch {
      return 'unavailable'
    }
  }

  private lifecycleKey(session: SessionLifecycleIdentityV1): string {
    return canonicalJson(session)
  }

  private key(session: SessionLifecycleIdentityV1, approvalRequestId: string, approvalAskedSeq: number): string {
    return `${this.lifecycleKey(session)}\0${approvalRequestId}\0${approvalAskedSeq}`
  }
}