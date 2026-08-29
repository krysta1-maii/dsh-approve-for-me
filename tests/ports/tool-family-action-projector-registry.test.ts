import { describe, expect, it } from 'vitest'
import { ToolFamilyActionProjectorRegistry } from '../../src/index.js'

type Execution = { readonly name: string; readonly command: string }

const shell = {
  family: 'shell-process-v1',
  projectorId: 'shell-projector-v1',
  toolNames: ['bash'],
  project(execution: Execution) {
    return {
      toolName: execution.name, arguments: { command: execution.command }, projectorId: 'shell-projector-v1',
      semantics: { family: 'shell-process-v1', value: { command: execution.command } },
    }
  },
}

describe('ToolFamilyActionProjectorRegistry', () => {
  it('resolves exactly one closed-world tool-family projection', () => {
    const registry = new ToolFamilyActionProjectorRegistry<Execution>([shell])
    expect(registry.project({ name: 'bash', command: 'pwd' })).toEqual({
      toolName: 'bash', arguments: { command: 'pwd' }, projectorId: 'shell-projector-v1',
      semantics: { family: 'shell-process-v1', value: { command: 'pwd' } },
    })
  })

  it('fails closed for an unregistered tool', () => {
    const registry = new ToolFamilyActionProjectorRegistry<Execution>([shell])
    expect(() => registry.project({ name: 'network', command: 'curl https://example.test' }))
      .toThrow(/no complete action semantics/)
  })

  it('rejects duplicate or malformed registrations at composition time', () => {
    expect(() => new ToolFamilyActionProjectorRegistry<Execution>([
      shell,
      { ...shell, family: 'other-v1' },
    ])).toThrow(/more than one/)
    expect(() => new ToolFamilyActionProjectorRegistry<Execution>([
      { ...shell, toolNames: [] },
    ])).toThrow(/at least one/)
  })

  it('rejects a projector that does not bind its semantic identity', () => {
    const registry = new ToolFamilyActionProjectorRegistry<Execution>([
      { ...shell, project: execution => ({ toolName: execution.name, arguments: {}, projectorId: 'wrong', semantics: { family: 'other', value: {} } }) },
    ])
    expect(() => registry.project({ name: 'bash', command: 'pwd' })).toThrow(/unbound semantic action/)
  })

  it('rejects a projector that changes the execution tool identity', () => {
    const registry = new ToolFamilyActionProjectorRegistry<Execution>([
      { ...shell, project: () => ({ toolName: 'other', arguments: {} }) },
    ])
    expect(() => registry.project({ name: 'bash', command: 'pwd' })).toThrow(/mismatched tool name/)
  })
})
