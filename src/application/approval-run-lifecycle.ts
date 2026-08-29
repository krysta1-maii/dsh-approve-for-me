/**
 * Owns every in-flight machine-policy run. Disposing the plugin aborts all
 * current work before draining it, because unregistering a host policy only
 * prevents future callbacks and cannot cancel an already executing callback.
 */
export class ApprovalRunLifecycle {
  private accepting = true
  private readonly active = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()

  async run<T>(upstream: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('approval run lifecycle is closed')
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (upstream?.aborted) controller.abort()
    else upstream?.addEventListener('abort', abort, { once: true })
    this.controllers.add(controller)
    let task!: Promise<void>
    const result = Promise.resolve().then(() => work(controller.signal))
    task = result.then(() => undefined, () => undefined)
    this.active.add(task)
    try {
      return await result
    } finally {
      upstream?.removeEventListener('abort', abort)
      this.controllers.delete(controller)
      this.active.delete(task)
    }
  }

  async dispose(): Promise<void> {
    this.accepting = false
    for (const controller of this.controllers) controller.abort()
    await Promise.all([...this.active])
  }
}
