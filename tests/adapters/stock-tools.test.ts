import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DSH_ALPHA2_ARGUMENT_SEMANTICS_ID,
  DSH_ALPHA2_OPAQUE_FAMILY,
  createActionSnapshot,
  createDshAlpha2DossierCatalog,
  createDshAlpha2StockProjectorRegistry,
  createDshAlpha2StockToolCatalog,
} from '../../src/index.js'

function schema(name: string, fields: Record<string, unknown> = {}): unknown {
  return { name, description: `${name} test schema`, parameters: { type: 'object', properties: fields } }
}

function agent(): Agent {
  return { id: SessionId('parent-1'), session: { id: SessionId('parent-1'), header: { cwd: '/workspace' } } } as unknown as Agent
}

function execution(name: string, arguments_: unknown): ToolExecution {
  return {
    callId: 'call-1' as ToolExecution['callId'],
    rootCallId: 'call-1' as ToolExecution['rootCallId'],
    name,
    arguments: arguments_,
    agent: agent(),
    signal: new AbortController().signal,
    token: Symbol('token') as ToolExecution['token'],
  }
}

describe('DSH 0.1.2-alpha.5 stock tool composition', () => {
  it('derives a deterministic exact-schema catalog with fail-closed opaque coverage', () => {
    const catalog = createDshAlpha2StockToolCatalog([
      schema('write', { file_path: { type: 'string' } }),
      schema('bash', { command: { type: 'string' } }),
      schema('todo_write', { todos: { type: 'array' } }),
    ])
    expect(catalog.argumentSemanticsId).toBe(DSH_ALPHA2_ARGUMENT_SEMANTICS_ID)
    expect(catalog.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(catalog.descriptors).toEqual([
      expect.objectContaining({ toolName: 'bash', classification: 'body-escalation', actionSemanticsFamily: 'shell-process-v1' }),
      expect.objectContaining({ toolName: 'todo_write', classification: 'ordinary', actionSemanticsFamily: DSH_ALPHA2_OPAQUE_FAMILY }),
      expect.objectContaining({ toolName: 'write', classification: 'body-escalation', actionSemanticsFamily: 'filesystem-v1' }),
    ])
    expect(createDshAlpha2StockToolCatalog([
      schema('write', { file_path: { type: 'string' } }),
      schema('bash', { command: { type: 'string' } }),
      schema('todo_write', { todos: { type: 'array' } }),
    ]).fingerprint).toBe(catalog.fingerprint)
  })

  it('classifies only exact alpha.1 delegation schemas and requires terminal receipts', () => {
    const subagentSchema = {
      name: 'subagent', description: 'Delegate work.', parameters: {
        type: 'object', additionalProperties: false,
        properties: { description: { type: 'string' }, prompt: { type: 'string' }, run_in_background: { type: 'boolean' } },
        required: ['description', 'prompt'],
      },
    }
    const schemas: readonly unknown[] = [
      subagentSchema,
      {
        name: 'send_message', description: 'Follow up.', parameters: {
          type: 'object', additionalProperties: false,
          properties: { subagent_id: { type: 'string' }, message: { type: 'string' } },
          required: ['subagent_id', 'message'],
        },
      },
      schema('bash', { command: { type: 'string' } }),
    ]
    const approval = createDshAlpha2StockToolCatalog(schemas)
    const dossier = createDshAlpha2DossierCatalog(schemas, approval)
    expect(dossier.descriptors).toEqual([
      expect.objectContaining({ classification: 'ordinary', toolName: 'bash' }),
      expect.objectContaining({ classification: 'delegation', toolName: 'send_message', operation: 'followup', receiptPolicy: { kind: 'required-on-completed', receiptKinds: ['followup-delivered'] } }),
      expect.objectContaining({ classification: 'delegation', toolName: 'subagent', operation: 'start', receiptPolicy: { kind: 'required-on-completed', receiptKinds: expect.arrayContaining(['continuable-child-started']) } }),
    ])

    const masquerading = [{
      ...subagentSchema,
      parameters: {
        ...subagentSchema.parameters,
        properties: { ...subagentSchema.parameters.properties, authority_override: { type: 'boolean' } },
      },
    }]
    const masqueradingApproval = createDshAlpha2StockToolCatalog(masquerading)
    expect(createDshAlpha2DossierCatalog(masquerading, masqueradingApproval).descriptors[0])
      .toMatchObject({ classification: 'ordinary', toolName: 'subagent' })
  })

  it('projects the exact stock bash escalation fields', () => {
    const catalog = createDshAlpha2StockToolCatalog([schema('bash')])
    const registry = createDshAlpha2StockProjectorRegistry(catalog)
    const action = createActionSnapshot(registry.project(execution('bash', {
      command: 'npm test',
      description: 'Run test suite',
      timeoutMs: 30_000,
      workdir: 'packages/app',
      run_in_background: true,
      sandbox_permissions: 'workspace-write',
      justification: 'Tests need a cache write.',
    })))
    expect(action).toMatchObject({
      toolName: 'bash',
      semantics: {
        family: 'shell-process-v1',
        value: {
          operation: 'bash', command: 'npm test', description: 'Run test suite', cwd: '/workspace',
          workdir: 'packages/app', timeoutMs: 30_000, runInBackground: true,
        },
      },
      requestedPermissions: [{ kind: 'sandbox', scope: 'workspace-write', details: { justification: 'Tests need a cache write.' } }],
    })
  })

  it('projects stock file_path/search fields and content commitments', () => {
    const catalog = createDshAlpha2StockToolCatalog([schema('write'), schema('grep')])
    const registry = createDshAlpha2StockProjectorRegistry(catalog)
    const write = createActionSnapshot(registry.project(execution('write', {
      file_path: 'notes/result.txt', content: 'done', sandbox_permissions: 'workspace-write', justification: 'Save requested output.',
    })))
    expect(write).toMatchObject({
      semantics: { family: 'filesystem-v1', value: { operation: 'write', cwd: '/workspace', targets: [{ path: 'notes/result.txt', role: 'target' }], contentBytes: 4, contentHash: expect.stringMatching(/^sha256:/) } },
      requestedPermissions: [{ kind: 'sandbox', scope: 'workspace-write' }],
    })
    const grep = createActionSnapshot(registry.project(execution('grep', { pattern: 'TODO', path: 'src', include: '*.ts' })))
    expect(grep).toMatchObject({ semantics: { family: 'filesystem-v1', value: { operation: 'search', targets: [{ path: 'src', role: 'root' }], pattern: 'TODO', include: '*.ts' } } })
  })

  it('makes unknown profile tools opaque and rejects semantic masquerading', () => {
    const catalog = createDshAlpha2StockToolCatalog([schema('custom_tool')])
    const registry = createDshAlpha2StockProjectorRegistry(catalog)
    const action = createActionSnapshot(registry.project(execution('custom_tool', { value: 1 })))
    expect(action.semantics).toEqual({ family: DSH_ALPHA2_OPAQUE_FAMILY, value: { operation: 'opaque' } })

    const descriptor = catalog.descriptors[0]!
    expect(() => createDshAlpha2StockProjectorRegistry({
      ...catalog,
      descriptors: [{ ...descriptor, actionSemanticsFamily: 'filesystem-v1' }],
    })).toThrow(/not bound/)
  })
})
