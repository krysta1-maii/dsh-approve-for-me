import { describe, expect, it, vi } from 'vitest'
import { ApprovalRunLifecycle } from '../../src/index.js'

describe('ApprovalRunLifecycle', () => {
  it('aborts active work and waits for it on dispose', async () => {
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
    release()
    await expect(Promise.all([work, disposing])).resolves.toEqual(['done', undefined])
  })

  it('rejects new work after disposal', async () => {
    const lifecycle = new ApprovalRunLifecycle()
    await lifecycle.dispose()
    await expect(lifecycle.run(undefined, async () => 'no')).rejects.toThrow(/closed/)
  })
})
