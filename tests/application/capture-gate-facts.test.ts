import { describe, expect, it } from 'vitest'
import { InMemoryGateActionFactStore, createActionSnapshot } from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })

function registration(parentSessionId: string, actionHash = hash('a')) {
  return {
    parentSessionId, actionHash, action, toolSchemaFingerprint: 'bash-fp', classification: { kind: 'classified' as const, classification: 'body-escalation' as const },
    breakerKey: { parentLifecycleFingerprint: parentSessionId, turn: 1, actionHash },
    allowCacheKey: { parentLifecycleFingerprint: parentSessionId, turn: 1, directUserFrontierSeq: 1, actionHash, configurationFingerprint: hash('c'), generation: 'g1' },
    rootRequester: true, directChildOrigin: false, generation: 'g1', configurationFingerprint: hash('c'),
    authority: { live: {}, sessionId: parentSessionId },
  }
}

describe('InMemoryGateActionFactStore', () => {
  it('scopes an action hash to the exact parent session', async () => {
    const store = new InMemoryGateActionFactStore()
    store.register(registration('parent-a'))
    store.register(registration('parent-b'))
    await expect(store.resolve({ parentSessionId: 'parent-a', actionHash: hash('a') })).resolves.toMatchObject({ generation: 'g1' })
    await expect(store.resolve({ parentSessionId: 'parent-c', actionHash: hash('a') })).resolves.toBeUndefined()
  })

  it('rejects authority/session substitution instead of retaining forged facts', () => {
    const store = new InMemoryGateActionFactStore()
    expect(() => store.register({ ...registration('parent-a'), authority: { live: {}, sessionId: 'parent-b' } })).toThrow(/authority session/)
  })
})
