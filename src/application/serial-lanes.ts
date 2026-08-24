/**
 * Per-parent serial execution. Reviews for one parent Session run strictly in
 * FIFO order; different parents proceed in parallel.
 */
export class SerialLanes {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    return run.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
  }
}
