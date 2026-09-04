import { GateFailure } from './gate-failure.js'

/**
 * Owns every in-flight machine-policy run. Callers stop waiting immediately on
 * abort/deadline, while the lifecycle retains and drains the cooperative work
 * so no late authorization task escapes plugin ownership.
 */
export class ApprovalRunLifecycle {
  private accepting = true
  private readonly active = new Set<Promise<void>>()
  private readonly abortActive = new Map<AbortController, () => void>()

  constructor(
    private readonly maxRunMs?: number,
    private readonly now: () => number = Date.now,
  ) {
    if (maxRunMs !== undefined && (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1)) {
      throw new TypeError('approval lifecycle maxRunMs must be a positive safe integer')
    }
  }

  async run<T>(upstream: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new GateFailure('lifecycle', 'approval run lifecycle is closed')
    const startedAt = this.now()
    const deadlineAt = this.maxRunMs === undefined ? undefined : startedAt + this.maxRunMs
    if (!Number.isSafeInteger(startedAt) || startedAt < 0
      || (deadlineAt !== undefined && !Number.isSafeInteger(deadlineAt))) {
      throw new GateFailure('lifecycle', 'approval run clock produced an invalid deadline')
    }
    const controller = new AbortController()
    let failure: GateFailure | undefined
    const abortWith = (next: GateFailure) => {
      if (controller.signal.aborted) return
      failure = next
      controller.abort(next)
    }
    const abortFromUpstream = () => abortWith(new GateFailure('abort', 'approval run was cancelled by its caller'))
    if (upstream?.aborted) abortFromUpstream()
    else upstream?.addEventListener('abort', abortFromUpstream, { once: true })

    const timeout = this.maxRunMs === undefined ? undefined : setTimeout(() => {
      abortWith(new GateFailure('deadline', 'approval run exceeded its complete machine-policy deadline'))
    }, this.maxRunMs)
    timeout?.unref()
    const abortForDispose = () => abortWith(new GateFailure('lifecycle', 'approval run was cancelled by plugin disposal'))
    this.abortActive.set(controller, abortForDispose)

    let rejectOnAbort!: () => void
    const aborted = new Promise<T>((_resolve, reject) => {
      rejectOnAbort = () => reject(failure ?? new GateFailure('lifecycle', 'approval run was cancelled'))
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
      if (controller.signal.aborted) rejectOnAbort()
    })
    const result = Promise.resolve().then(() => work(controller.signal))
    let task!: Promise<void>
    task = result.then(() => undefined, () => undefined).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout)
      upstream?.removeEventListener('abort', abortFromUpstream)
      controller.signal.removeEventListener('abort', rejectOnAbort)
      this.abortActive.delete(controller)
      this.active.delete(task)
    })
    this.active.add(task)
    const value = await Promise.race([result, aborted])
    // A starved timer is not an authorization clock. Re-check wall time at the
    // synchronous return boundary before a result can escape the lifecycle.
    if (deadlineAt !== undefined && this.now() >= deadlineAt) {
      const overdue = new GateFailure('deadline', 'approval run completed after its absolute deadline')
      abortWith(overdue)
      throw overdue
    }
    return value
  }

  async dispose(): Promise<void> {
    this.accepting = false
    for (const abort of this.abortActive.values()) abort()
    await Promise.all([...this.active])
  }
}
