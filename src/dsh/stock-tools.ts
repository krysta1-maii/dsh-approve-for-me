import { createHash } from 'node:crypto'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalToolCatalog, ToolApprovalClass, ToolApprovalDescriptor } from '../approval-gate/catalog.js'
import { fingerprintApprovalToolCatalogV1 } from '../approval-gate/catalog.js'
import { effectiveToolBindingFromSchemaV1, fingerprintDelegationToolCatalogV1 } from '../domain/dossier.js'
import type { DelegationToolClassificationCatalogV1, DelegationToolDescriptorV1 } from '../domain/dossier.js'
import { canonicalJson, snapshotJson } from '../domain/json.js'
import type { ActionSnapshotInput, RequestedPermission } from '../domain/protocol.js'
import type { ToolFamilyActionProjector } from '../ports/tool-family-action-projector.js'
import { ToolFamilyActionProjectorRegistry } from '../ports/tool-family-action-projector.js'

export const DSH_ALPHA1_ARGUMENT_SEMANTICS_ID = 'dsh-0.1.2-alpha.1-stock-v1'
export const DSH_ALPHA1_SHELL_FAMILY = 'shell-process-v1'
export const DSH_ALPHA1_SHELL_PROJECTOR_ID = 'dsh-approve-for-me/shell-process-v1'
export const DSH_ALPHA1_FILESYSTEM_FAMILY = 'filesystem-v1'
export const DSH_ALPHA1_FILESYSTEM_PROJECTOR_ID = 'dsh-approve-for-me/filesystem-v1'
export const DSH_ALPHA1_NETWORK_FAMILY = 'network-v1'
export const DSH_ALPHA1_NETWORK_PROJECTOR_ID = 'dsh-approve-for-me/network-v1'
export const DSH_ALPHA1_OPAQUE_FAMILY = 'opaque-v1'
export const DSH_ALPHA1_OPAQUE_PROJECTOR_ID = 'dsh-approve-for-me/dsh-0.1.2-alpha.1/opaque-v1'

const FILESYSTEM_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep'])
const NETWORK_TOOLS = new Set(['web_search', 'web_fetch'])
const BODY_ESCALATION_TOOLS = new Set(['bash', 'write', 'edit'])
const MAX_ARGUMENT_BYTES = 256_000
const MAX_TEXT = 131_072

interface StockBinding {
  readonly family: string
  readonly projectorId: string
}

function bindingFor(toolName: string): StockBinding {
  if (toolName === 'bash') return { family: DSH_ALPHA1_SHELL_FAMILY, projectorId: DSH_ALPHA1_SHELL_PROJECTOR_ID }
  if (FILESYSTEM_TOOLS.has(toolName)) return { family: DSH_ALPHA1_FILESYSTEM_FAMILY, projectorId: DSH_ALPHA1_FILESYSTEM_PROJECTOR_ID }
  if (NETWORK_TOOLS.has(toolName)) return { family: DSH_ALPHA1_NETWORK_FAMILY, projectorId: DSH_ALPHA1_NETWORK_PROJECTOR_ID }
  return { family: DSH_ALPHA1_OPAQUE_FAMILY, projectorId: DSH_ALPHA1_OPAQUE_PROJECTOR_ID }
}

function classificationFor(toolName: string): ToolApprovalClass {
  return BODY_ESCALATION_TOOLS.has(toolName) ? 'body-escalation' : 'ordinary'
}

/**
 * Freeze the exact model-facing schemas that are registered when the loader
 * mounts. Unknown stock/profile tools remain catalogued, but receive opaque
 * semantics and therefore can never be automatically authorized.
 */
export function createDshAlpha1StockToolCatalog(schemas: readonly unknown[]): ApprovalToolCatalog {
  const descriptors: ToolApprovalDescriptor[] = []
  const names = new Set<string>()
  for (const schema of schemas) {
    const effective = effectiveToolBindingFromSchemaV1(schema)
    if (effective === undefined) throw new TypeError('registered tool has no valid model-facing schema')
    if (names.has(effective.toolName)) throw new TypeError(`registered tool schema ${effective.toolName} is duplicated`)
    names.add(effective.toolName)
    const binding = bindingFor(effective.toolName)
    descriptors.push(Object.freeze({
      toolName: effective.toolName,
      toolSchemaFingerprint: effective.toolSchemaFingerprint,
      classification: classificationFor(effective.toolName),
      actionSemanticsFamily: binding.family,
      actionProjectorId: binding.projectorId,
    }))
  }
  const unsealed: ApprovalToolCatalog = {
    version: 1,
    argumentSemanticsId: DSH_ALPHA1_ARGUMENT_SEMANTICS_ID,
    fingerprint: '',
    descriptors: Object.freeze(descriptors.sort((left, right) => left.toolName.localeCompare(right.toolName))),
  }
  const fingerprint = fingerprintApprovalToolCatalogV1(unsealed)
  if (fingerprint === undefined) throw new TypeError('failed to fingerprint the stock tool catalog')
  return Object.freeze({ ...unsealed, fingerprint })
}

const DELEGATION_BINDINGS = Object.freeze({
  subagent: Object.freeze({
    projectorId: 'dsh-approve-for-me/dsh-0.1.2-alpha.1/subagent-start-v1',
    operation: 'start' as const,
    requiredParameters: Object.freeze(['description', 'prompt']),
    allowedParameters: Object.freeze(['description', 'prompt', 'run_in_background', 'provider', 'model', 'reasoning_effort']),
    receiptKinds: Object.freeze(['continuable-child-started', 'foreground-run-settled', 'background-job-started']),
  }),
  subagent_fork: Object.freeze({
    projectorId: 'dsh-approve-for-me/dsh-0.1.2-alpha.1/subagent-fork-start-v1',
    operation: 'start' as const,
    requiredParameters: Object.freeze(['description', 'prompt']),
    allowedParameters: Object.freeze(['description', 'prompt', 'run_in_background', 'provider', 'model', 'reasoning_effort']),
    receiptKinds: Object.freeze(['continuable-child-started', 'foreground-run-settled', 'background-job-started']),
  }),
  send_message: Object.freeze({
    projectorId: 'dsh-approve-for-me/dsh-0.1.2-alpha.1/subagent-followup-v1',
    operation: 'followup' as const,
    requiredParameters: Object.freeze(['subagent_id', 'message']),
    allowedParameters: Object.freeze(['subagent_id', 'message']),
    receiptKinds: Object.freeze(['followup-delivered']),
  }),
  interrupt_agent: Object.freeze({
    projectorId: 'dsh-approve-for-me/dsh-0.1.2-alpha.1/subagent-interrupt-v1',
    operation: 'interrupt' as const,
    requiredParameters: Object.freeze(['agent_id']),
    allowedParameters: Object.freeze(['agent_id']),
    receiptKinds: Object.freeze(['interrupt-accepted']),
  }),
})

type DelegationBindingName = keyof typeof DELEGATION_BINDINGS

function delegationDescriptor(
  schema: unknown,
  toolSchemaFingerprint: string,
): Extract<DelegationToolDescriptorV1, { readonly classification: 'delegation' }> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const value = schema as Record<string, unknown>
  if (typeof value.name !== 'string' || !(value.name in DELEGATION_BINDINGS)
    || value.parameters === null || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) return undefined
  const name = value.name as DelegationBindingName
  const binding = DELEGATION_BINDINGS[name]
  const parameterSchema = value.parameters as Record<string, unknown>
  const properties = parameterSchema.properties
  const required = parameterSchema.required
  if (parameterSchema.type !== 'object' || properties === null || typeof properties !== 'object' || Array.isArray(properties)
    || !Array.isArray(required) || required.some(parameter => typeof parameter !== 'string')) return undefined
  const parameterNames = Object.keys(properties as Record<string, unknown>)
  const requiredNames = new Set(required as string[])
  if (binding.requiredParameters.some(parameter => !requiredNames.has(parameter))
    || [...requiredNames].some(parameter => !parameterNames.includes(parameter))
    || parameterNames.some(parameter => !(binding.allowedParameters as readonly string[]).includes(parameter))) return undefined
  return Object.freeze({
    classification: 'delegation' as const,
    projectorId: binding.projectorId,
    toolName: name,
    toolSchemaFingerprint,
    operation: binding.operation,
    receiptPolicy: Object.freeze({
      kind: 'required-on-completed' as const,
      receiptKinds: Object.freeze([...binding.receiptKinds]),
    }),
  })
}

/** Build the exact alpha.1 dossier catalog from the same frozen model schemas. */
export function createDshAlpha1DossierCatalog(
  schemas: readonly unknown[],
  approvalCatalog: ApprovalToolCatalog,
): DelegationToolClassificationCatalogV1 {
  const schemasByName = new Map<string, unknown>()
  for (const schema of schemas) {
    const binding = effectiveToolBindingFromSchemaV1(schema)
    if (binding === undefined || schemasByName.has(binding.toolName)) {
      throw new TypeError('registered tool schemas are invalid or duplicated')
    }
    schemasByName.set(binding.toolName, schema)
  }
  const descriptors = approvalCatalog.descriptors.map((descriptor): DelegationToolDescriptorV1 => {
    const schema = schemasByName.get(descriptor.toolName)
    const effective = effectiveToolBindingFromSchemaV1(schema)
    if (effective?.toolSchemaFingerprint !== descriptor.toolSchemaFingerprint) {
      throw new TypeError(`dossier schema binding changed for ${descriptor.toolName}`)
    }
    return delegationDescriptor(schema, descriptor.toolSchemaFingerprint) ?? Object.freeze({
      classification: 'ordinary' as const,
      toolName: descriptor.toolName,
      toolSchemaFingerprint: descriptor.toolSchemaFingerprint,
      classificationId: `approval-class:${descriptor.classification}`,
    })
  })
  const unsealed: DelegationToolClassificationCatalogV1 = {
    version: 1,
    eventProjectionPolicyId: 'dsh-session-facts-v1',
    argumentSemanticsId: approvalCatalog.argumentSemanticsId,
    fingerprint: '',
    descriptors: Object.freeze(descriptors),
  }
  const fingerprint = fingerprintDelegationToolCatalogV1(unsealed)
  if (fingerprint === undefined) throw new TypeError('failed to fingerprint the stock dossier catalog')
  return Object.freeze({ ...unsealed, fingerprint })
}

function argumentRecord(execution: ToolExecution): Record<string, unknown> {
  const raw = execution.arguments
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${execution.name} arguments must be an object`)
  }
  if (Buffer.byteLength(canonicalJson(snapshotJson(raw)), 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new TypeError(`${execution.name} arguments exceed the semantic projection budget`)
  }
  return raw as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], toolName: string): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some(key => !keys.has(key))) throw new TypeError(`${toolName} arguments contain an unrecognized field`)
}

function requiredString(value: Record<string, unknown>, key: string, toolName: string, max = MAX_TEXT): string {
  const field = value[key]
  if (typeof field !== 'string' || field.trim().length === 0 || field.length > max) {
    throw new TypeError(`${toolName}.${key} must be a bounded non-empty string`)
  }
  return field
}

function optionalString(value: Record<string, unknown>, key: string, toolName: string, max = MAX_TEXT): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.length > max) throw new TypeError(`${toolName}.${key} must be a bounded string`)
  return field
}

function sessionCwd(execution: ToolExecution): string {
  const cwd = (execution.agent?.session as unknown as { header?: { cwd?: unknown } } | undefined)?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || cwd.length > 16_384) {
    throw new TypeError(`${execution.name} projection requires a validated session cwd`)
  }
  return cwd
}

function escalationPermissions(value: Record<string, unknown>, toolName: string): readonly RequestedPermission[] {
  const mode = value.sandbox_permissions
  const justification = value.justification
  if (mode === undefined && justification === undefined) return Object.freeze([])
  if ((mode !== 'workspace-write' && mode !== 'danger-full-access')
    || typeof justification !== 'string' || justification.trim().length === 0 || justification.length > 8_192) {
    throw new TypeError(`${toolName} has an invalid sandbox escalation request`)
  }
  return Object.freeze([Object.freeze({
    kind: 'sandbox' as const,
    scope: mode,
    details: Object.freeze({ justification }),
  })])
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function shellProjector(toolNames: readonly string[]): ToolFamilyActionProjector<ToolExecution> {
  return Object.freeze({
    family: DSH_ALPHA1_SHELL_FAMILY,
    projectorId: DSH_ALPHA1_SHELL_PROJECTOR_ID,
    toolNames,
    project(execution: ToolExecution): ActionSnapshotInput {
      const value = argumentRecord(execution)
      exactKeys(value, ['command', 'description', 'timeoutMs', 'workdir', 'run_in_background', 'sandbox_permissions', 'justification'], execution.name)
      const command = requiredString(value, 'command', execution.name, 32_768)
      const description = requiredString(value, 'description', execution.name, 8_192)
      const workdir = optionalString(value, 'workdir', execution.name, 16_384)
      if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) {
        throw new TypeError('bash.timeoutMs must be a positive finite number')
      }
      if (value.run_in_background !== undefined && typeof value.run_in_background !== 'boolean') {
        throw new TypeError('bash.run_in_background must be a boolean')
      }
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        projectorId: DSH_ALPHA1_SHELL_PROJECTOR_ID,
        semantics: {
          family: DSH_ALPHA1_SHELL_FAMILY,
          value: {
            operation: 'bash',
            command,
            description,
            cwd: sessionCwd(execution),
            ...(workdir === undefined ? {} : { workdir }),
            ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
            runInBackground: value.run_in_background === true,
          },
        },
        requestedPermissions: escalationPermissions(value, execution.name),
      }
    },
  })
}

function filesystemProjector(toolNames: readonly string[]): ToolFamilyActionProjector<ToolExecution> {
  return Object.freeze({
    family: DSH_ALPHA1_FILESYSTEM_FAMILY,
    projectorId: DSH_ALPHA1_FILESYSTEM_PROJECTOR_ID,
    toolNames,
    project(execution: ToolExecution): ActionSnapshotInput {
      const value = argumentRecord(execution)
      const cwd = sessionCwd(execution)
      let operation: string
      let targets: readonly { readonly path: string; readonly role: string }[]
      let details: Record<string, unknown> = {}
      switch (execution.name) {
        case 'read': {
          exactKeys(value, ['file_path', 'offset', 'limit'], execution.name)
          operation = 'read'
          targets = [{ path: requiredString(value, 'file_path', execution.name, 16_384), role: 'target' }]
          if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || (value.offset as number) < 1)) throw new TypeError('read.offset must be a positive integer')
          if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1)) throw new TypeError('read.limit must be a positive integer')
          details = { ...(value.offset === undefined ? {} : { offset: value.offset }), ...(value.limit === undefined ? {} : { limit: value.limit }) }
          break
        }
        case 'read_image':
          exactKeys(value, ['file_path'], execution.name)
          operation = 'read'
          targets = [{ path: requiredString(value, 'file_path', execution.name, 16_384), role: 'target' }]
          details = { media: 'image' }
          break
        case 'write': {
          exactKeys(value, ['file_path', 'content', 'sandbox_permissions', 'justification'], execution.name)
          operation = 'write'
          targets = [{ path: requiredString(value, 'file_path', execution.name, 16_384), role: 'target' }]
          const content = optionalString(value, 'content', execution.name)
          if (content === undefined) throw new TypeError('write.content must be a string')
          details = { contentBytes: Buffer.byteLength(content, 'utf8'), contentHash: digestText(content) }
          break
        }
        case 'edit': {
          exactKeys(value, ['file_path', 'old_string', 'new_string', 'replace_all', 'sandbox_permissions', 'justification'], execution.name)
          operation = 'edit'
          targets = [{ path: requiredString(value, 'file_path', execution.name, 16_384), role: 'target' }]
          const oldString = optionalString(value, 'old_string', execution.name)
          const newString = optionalString(value, 'new_string', execution.name)
          if (oldString === undefined || newString === undefined) throw new TypeError('edit old_string/new_string must be strings')
          if (value.replace_all !== undefined && typeof value.replace_all !== 'boolean') throw new TypeError('edit.replace_all must be a boolean')
          details = { oldHash: digestText(oldString), newHash: digestText(newString), replaceAll: value.replace_all === true }
          break
        }
        case 'glob':
          exactKeys(value, ['pattern', 'path'], execution.name)
          operation = 'glob'
          targets = [{ path: optionalString(value, 'path', execution.name, 16_384) ?? '.', role: 'root' }]
          details = { pattern: requiredString(value, 'pattern', execution.name, 16_384) }
          break
        case 'grep':
          exactKeys(value, ['pattern', 'path', 'include'], execution.name)
          operation = 'search'
          targets = [{ path: optionalString(value, 'path', execution.name, 16_384) ?? '.', role: 'root' }]
          details = {
            pattern: requiredString(value, 'pattern', execution.name, 16_384),
            ...(value.include === undefined ? {} : { include: optionalString(value, 'include', execution.name, 16_384) }),
          }
          break
        default:
          throw new TypeError(`filesystem projector has no operation for tool ${execution.name}`)
      }
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        projectorId: DSH_ALPHA1_FILESYSTEM_PROJECTOR_ID,
        semantics: {
          family: DSH_ALPHA1_FILESYSTEM_FAMILY,
          value: {
            operation,
            cwd,
            targets: Object.freeze(targets.map(target => Object.freeze(target))),
            reversible: operation === 'read' || operation === 'glob' || operation === 'search',
            ...details,
          },
        },
        requestedPermissions: escalationPermissions(value, execution.name),
      }
    },
  })
}

function parseUrl(raw: string): { readonly scheme: string; readonly hostname: string; readonly port: number; readonly pathAndQuery: string } {
  let url: URL
  try { url = new URL(raw) } catch { throw new TypeError('web_fetch.url must be an absolute URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hostname === '' || url.hash !== '') {
    throw new TypeError('web_fetch.url must be credential-free fragment-free HTTP(S)')
  }
  return Object.freeze({
    scheme: url.protocol.slice(0, -1),
    hostname: url.hostname.toLowerCase(),
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    pathAndQuery: `${url.pathname}${url.search}`,
  })
}

function networkProjector(toolNames: readonly string[]): ToolFamilyActionProjector<ToolExecution> {
  return Object.freeze({
    family: DSH_ALPHA1_NETWORK_FAMILY,
    projectorId: DSH_ALPHA1_NETWORK_PROJECTOR_ID,
    toolNames,
    project(execution: ToolExecution): ActionSnapshotInput {
      const value = argumentRecord(execution)
      let semantics: Record<string, unknown>
      if (execution.name === 'web_search') {
        exactKeys(value, ['queries'], execution.name)
        if (!Array.isArray(value.queries) || value.queries.length < 1 || value.queries.length > 4
          || value.queries.some(query => typeof query !== 'string' || query.trim().length === 0 || query.length > 16_384)) {
          throw new TypeError('web_search.queries must be a bounded non-empty string array')
        }
        semantics = { operation: 'web-search', queries: Object.freeze([...value.queries]) }
      } else if (execution.name === 'web_fetch') {
        exactKeys(value, ['url'], execution.name)
        semantics = { operation: 'web-fetch', target: parseUrl(requiredString(value, 'url', execution.name, 16_384)) }
      } else {
        throw new TypeError(`network projector has no operation for tool ${execution.name}`)
      }
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        projectorId: DSH_ALPHA1_NETWORK_PROJECTOR_ID,
        semantics: { family: DSH_ALPHA1_NETWORK_FAMILY, value: semantics },
        requestedPermissions: Object.freeze([]),
      }
    },
  })
}

function opaqueProjector(toolNames: readonly string[]): ToolFamilyActionProjector<ToolExecution> {
  return Object.freeze({
    family: DSH_ALPHA1_OPAQUE_FAMILY,
    projectorId: DSH_ALPHA1_OPAQUE_PROJECTOR_ID,
    toolNames,
    project(execution: ToolExecution): ActionSnapshotInput {
      argumentRecord(execution)
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        projectorId: DSH_ALPHA1_OPAQUE_PROJECTOR_ID,
        semantics: { family: DSH_ALPHA1_OPAQUE_FAMILY, value: { operation: 'opaque' } },
        requestedPermissions: Object.freeze([]),
      }
    },
  })
}

/** Build the loader-reachable closed registry bound to one exact catalog. */
export function createDshAlpha1StockProjectorRegistry(
  catalog: ApprovalToolCatalog,
): ToolFamilyActionProjectorRegistry<ToolExecution> {
  if (catalog.argumentSemanticsId !== DSH_ALPHA1_ARGUMENT_SEMANTICS_ID) {
    throw new TypeError(`loader stock projectors require argumentSemanticsId ${DSH_ALPHA1_ARGUMENT_SEMANTICS_ID}`)
  }
  const groups = {
    shell: [] as string[],
    filesystem: [] as string[],
    network: [] as string[],
    opaque: [] as string[],
  }
  for (const descriptor of catalog.descriptors) {
    const expected = bindingFor(descriptor.toolName)
    if (descriptor.actionSemanticsFamily !== expected.family || descriptor.actionProjectorId !== expected.projectorId) {
      throw new TypeError(`toolCatalog descriptor ${descriptor.toolName} is not bound to its stock semantic projector`)
    }
    if (descriptor.toolName === 'bash') groups.shell.push(descriptor.toolName)
    else if (FILESYSTEM_TOOLS.has(descriptor.toolName)) groups.filesystem.push(descriptor.toolName)
    else if (NETWORK_TOOLS.has(descriptor.toolName)) groups.network.push(descriptor.toolName)
    else groups.opaque.push(descriptor.toolName)
  }
  const projectors: ToolFamilyActionProjector<ToolExecution>[] = []
  if (groups.shell.length > 0) projectors.push(shellProjector(Object.freeze(groups.shell)))
  if (groups.filesystem.length > 0) projectors.push(filesystemProjector(Object.freeze(groups.filesystem)))
  if (groups.network.length > 0) projectors.push(networkProjector(Object.freeze(groups.network)))
  if (groups.opaque.length > 0) projectors.push(opaqueProjector(Object.freeze(groups.opaque)))
  return new ToolFamilyActionProjectorRegistry(projectors)
}
