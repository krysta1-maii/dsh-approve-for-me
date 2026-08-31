import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  DshScopedEffectiveCatalogResolver,
  createDshAlpha1EffectiveCatalog,
} from '../../src/dsh/effective-tool-catalog.js'
import { fingerprintApprovalToolCatalogV1 } from '../../src/approval-gate/catalog.js'

function schema(name: string): unknown {
  return { name, description: `${name} schema`, parameters: { type: 'object', properties: { command: { type: 'string' } } } }
}

function agent(id: string, schemas: readonly unknown[], options: { lateHeader?: boolean } = {}): Agent {
  const events: unknown[] = [
    { seq: 0, time: 1, type: 'request/header', data: { header: { tools: schemas } } },
    { seq: 1, time: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }] } } },
  ]
  if (options.lateHeader === true) events.push({ seq: 2, time: 3, type: 'request/header', data: { header: { tools: schemas } } })
  events.push({ seq: events.length, time: 4, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: { command: 'pwd' } } })
  return { id, session: { events } } as unknown as Agent
}

function execution(owner: Agent): ToolExecution {
  return {
    agent: owner,
    callId: 'call-1', rootCallId: 'call-1', name: 'bash', arguments: { command: 'pwd' },
    signal: new AbortController().signal, token: Symbol('tool'),
  } as unknown as ToolExecution
}

describe('DshScopedEffectiveCatalogResolver', () => {
  it('queries schemas with the exact Agent and freezes one corroborated per-execution catalog', () => {
    const schemas = [schema('bash')]
    const owner = agent('agent-1', schemas)
    const lookup = vi.fn((seen: Agent) => {
      expect(seen).toBe(owner)
      return schemas
    })
    const resolver = new DshScopedEffectiveCatalogResolver({ schemas: lookup })
    const exec = execution(owner)
    const first = resolver.forExecution(exec)
    schemas.push(schema('write'))
    const second = resolver.forExecution(exec)
    expect(first).toBe(second)
    expect(first?.schemas).toHaveLength(1)
    expect(Object.isFrozen(first?.schemas)).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('accepts native wire/callable order differences but rejects schema drift', () => {
    const bash = schema('bash')
    const write = schema('write')
    const owner = agent('ordered', [bash, write])
    const resolver = new DshScopedEffectiveCatalogResolver({ schemas: () => [write, bash] })
    expect(resolver.forExecution(execution(owner))?.commitment.presentation).toBe('native')

    const changed = agent('changed', [bash])
    expect(new DshScopedEffectiveCatalogResolver({ schemas: () => [bash, write] })
      .forExecution(execution(changed))).toBeUndefined()
  })

  it('binds nested PTC execution to the exact root token and frozen callable catalog', () => {
    const runCode = { name: 'run_code', description: 'dispatch', parameters: { type: 'object', properties: { code: { type: 'string' } } } }
    const bash = schema('bash')
    const events: unknown[] = [
      { seq: 0, time: 1, type: 'request/header', data: { header: { tools: [runCode] } } },
      { seq: 1, time: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'root-1', name: 'run_code', arguments: '{"code":"await tools.bash({ command: \\"pwd\\" })"}' }] } } },
      { seq: 2, time: 3, type: 'tool/call', data: { callId: 'root-1', name: 'run_code', arguments: { code: 'await tools.bash({ command: "pwd" })' } } },
    ]
    const owner = { id: 'ptc', session: { events } } as unknown as Agent
    const root = {
      agent: owner, callId: 'root-1', rootCallId: 'root-1', name: 'run_code', arguments: { code: 'await tools.bash({ command: "pwd" })' },
      signal: new AbortController().signal, token: Symbol('root'),
    } as unknown as ToolExecution
    const lookup = vi.fn(() => [runCode, bash])
    const resolver = new DshScopedEffectiveCatalogResolver({ schemas: lookup })
    const rootCatalog = resolver.forExecution(root)
    expect(rootCatalog?.commitment.presentation).toBe('ptc')
    events.push({ seq: 3, time: 4, type: 'tool/code-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'sub-1', name: 'bash', arguments: { command: 'pwd' } } })
    const nested = {
      agent: owner, callId: 'sub-1', rootCallId: 'root-1', parent: root.token, name: 'bash', arguments: { command: 'pwd' },
      signal: new AbortController().signal, token: Symbol('nested'),
    } as unknown as ToolExecution
    const nestedCatalog = resolver.forExecution(nested)
    expect(nestedCatalog?.commitment).toBe(rootCatalog?.commitment)
    expect(nestedCatalog?.execution).toMatchObject({ requestEventSeq: 3, rootRequestEventSeq: 2, parentRequestEventSeq: 2 })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('isolates restricted agents and rejects scoped/header drift', () => {
    const bash = [schema('bash')]
    const wider = [schema('bash'), schema('write')]
    const restricted = agent('restricted', bash)
    const broad = agent('broad', wider)
    const resolver = new DshScopedEffectiveCatalogResolver({
      schemas: seen => seen === restricted ? bash : wider,
    })
    expect(resolver.forExecution(execution(restricted))?.approval.descriptors.map(item => item.toolName)).toEqual(['bash'])
    expect(resolver.forExecution(execution(broad))?.approval.descriptors.map(item => item.toolName)).toEqual(['bash', 'write'])

    const changed = new DshScopedEffectiveCatalogResolver({ schemas: () => wider })
    expect(changed.forExecution(execution(restricted))).toBeUndefined()
  })

  it('subsets an explicit configured template and preserves it on durable resume', () => {
    const schemas = [schema('bash')]
    const base = createDshAlpha1EffectiveCatalog(schemas)
    const unsealed = {
      version: 1 as const,
      argumentSemanticsId: base.approval.argumentSemanticsId,
      fingerprint: '',
      descriptors: [{ ...base.approval.descriptors[0]!, classification: 'gate-ask' as const }],
    }
    const template = { ...unsealed, fingerprint: fingerprintApprovalToolCatalogV1(unsealed)! }
    const owner = agent('configured', schemas)
    const resolver = new DshScopedEffectiveCatalogResolver({ schemas: () => schemas }, template)
    const effective = resolver.forExecution(execution(owner))
    expect(effective?.approval.descriptors[0]?.classification).toBe('gate-ask')
    expect(effective?.dossier.descriptors[0]).toMatchObject({ classificationId: 'approval-class:gate-ask' })
    expect(effective?.commitment.callableSchemas).toEqual(schemas)
  })

  it('fails closed for late headers, malformed histories, and lookup failures', () => {
    const schemas = [schema('bash')]
    expect(new DshScopedEffectiveCatalogResolver({ schemas: () => schemas })
      .forExecution(execution(agent('late', schemas, { lateHeader: true })))).toBeUndefined()
    expect(new DshScopedEffectiveCatalogResolver({ schemas: () => { throw new Error('disposed scope') } })
      .forExecution(execution(agent('throw', schemas)))).toBeUndefined()
    const missing = { id: 'missing', session: { events: [] } } as unknown as Agent
    expect(new DshScopedEffectiveCatalogResolver({ schemas: () => schemas }).forExecution(execution(missing))).toBeUndefined()
  })

})
