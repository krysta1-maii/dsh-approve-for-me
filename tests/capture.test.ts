import { describe, expect, it } from 'vitest'
import { ActionCaptureStore } from '../src/index.js'

describe('ActionCaptureStore', () => {
  it('correlates by exact owner, call id, and tool name', () => {
    const store = new ActionCaptureStore<object>()
    const owner = {}
    const other = {}
    const captured = store.capture(owner, {
      parentSessionId: 'parent-1',
      callId: 'call-1',
      toolName: 'bash',
      arguments: { command: 'pwd' },
      reason: 'policy asks',
    })
    expect(store.lookup(owner, 'call-1', 'bash')).toBe(captured)
    expect(store.lookup(owner, 'call-1', 'write')).toBeUndefined()
    expect(store.lookup(other, 'call-1', 'bash')).toBeUndefined()
  })

  it('rejects duplicate captures and releases terminal calls', () => {
    const store = new ActionCaptureStore<object>()
    const owner = {}
    const input = { parentSessionId: 'parent-1', callId: 'call-1', toolName: 'bash', arguments: {} }
    store.capture(owner, input)
    expect(() => store.capture(owner, input)).toThrow(/already captured/)
    expect(store.release(owner, 'call-1')).toBe(true)
    expect(store.lookup(owner, 'call-1', 'bash')).toBeUndefined()
    expect(store.release(owner, 'call-1')).toBe(false)
  })
})
