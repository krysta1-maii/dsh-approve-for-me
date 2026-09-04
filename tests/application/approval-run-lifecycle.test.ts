import { describe, expect, it, vi } from 'vitest'
import { ApprovalRunLifecycle, GateFailure } from '../../src/index.js'

describe('ApprovalRunLifecycle', () => {
  it('stops the caller immediately but still drains underlying work on dispose', async () => {
    const lifecycle = new ApprovalRunLifecycle()
    let release!: () => void
    const entered = vi.fn()
    const work = lifecycle.run(undefined, async signal => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
      expect(signal.aborted).toBe(true)
      return 'done'
    })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    const disposing = lifecycle.dispose()

    await expect(work).rejects.toMatchObject({ code: 'lifecycle' })
    let drained = false
    void disposing.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    release()
    await expect(disposing).resolves.toBeUndefined()
  })

  it('propagates caller abort without waiting for non-cooperative work', async () => {
    const lifecycle = new ApprovalRunLifecycle()
    const caller = new AbortController()
    let release!: () => void
    const work = lifecycle.run(caller.signal, async signal => {
      await new Promise<void>(resolve => { release = resolve })
      expect(signal.aborted).toBe(true)
      return 'late'
    })

    caller.abort({ kind: 'user' })
    await expect(work).rejects.toMatchObject({ code: 'abort' })
    release()
    await lifecycle.dispose()
  })

  it('applies one deadline to the complete machine-policy run', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new ApprovalRunLifecycle(100)
      let release!: () => void
      const work = lifecycle.run(undefined, async signal => {
        await new Promise<void>(resolve => { release = resolve })
        expect(signal.aborted).toBe(true)
        return 'late'
      })

      const deadline = expect(work).rejects.toMatchObject({ code: 'deadline' })
      await vi.advanceTimersByTimeAsync(100)
      await deadline
      release()
      await lifecycle.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('checks wall time even when the deadline timer never gets a turn', async () => {
    let now = 0
    const lifecycle = new ApprovalRunLifecycle(100, () => now)
    const work = lifecycle.run(undefined, async () => {
      now = 100
      return 'late-allow'
    })

    await expect(work).rejects.toMatchObject({ code: 'deadline' })
    await lifecycle.dispose()
  })

  it('rejects new work after disposal', async () => {
    const lifecycle = new ApprovalRunLifecycle()
    await lifecycle.dispose()
    await expect(lifecycle.run(undefined, async () => 'no')).rejects.toBeInstanceOf(GateFailure)
  })
})
