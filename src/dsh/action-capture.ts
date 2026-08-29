import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JsonSnapshotError, canonicalJson, snapshotJson } from '../domain/json.js'
import { createActionSnapshot } from '../domain/protocol.js'
import type { RequestedPermission } from '../domain/protocol.js'
import type { ActionCapture, ActionProjector } from '../ports/action-projector.js'
import type { ToolFamilyActionProjector } from '../ports/tool-family-action-projector.js'

/**
 * Fixed v1 projector: keep tool name, full arguments, and the requested
 * permissions projected from DSH-known facts. Tool-family specific projection
 * extends this port; the serializable Config never carries functions.
 */
export function createDefaultActionProjector(
  projectPermissions?: (execution: ToolExecution) => readonly RequestedPermission[],
): ActionProjector<ToolExecution> {
  return {
    project(execution) {
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        ...projectPermissions === undefined
          ? {}
          : { requestedPermissions: projectPermissions(execution) },
      }
    },
  }
}

const SHELL_PROCESS_PROJECTOR_ID = 'dsh-approve-for-me/shell-process-v1'
const SHELL_PROCESS_FAMILY = 'shell-process-v1'
const MAX_SHELL_ARGUMENT_BYTES = 65_536
const FILESYSTEM_PROJECTOR_ID = 'dsh-approve-for-me/filesystem-v1'
const FILESYSTEM_FAMILY = 'filesystem-v1'
const MAX_FILESYSTEM_ARGUMENT_BYTES = 65_536

type FilesystemOperation = 'read' | 'list' | 'glob' | 'write' | 'edit' | 'delete' | 'move' | 'mkdir'

/** Explicit tool-name binding: semantics are never inferred from arbitrary arguments. */
export type FilesystemToolNames = Readonly<Partial<Record<FilesystemOperation, string>>>

const DEFAULT_FILESYSTEM_TOOL_NAMES: Readonly<Required<FilesystemToolNames>> = Object.freeze({
  read: 'read', list: 'list', glob: 'glob', write: 'write', edit: 'edit', delete: 'delete', move: 'move', mkdir: 'mkdir',
})

function shellArguments(execution: ToolExecution): { readonly command: string; readonly argv?: readonly string[]; readonly environment?: Readonly<Record<string, string>> } {
  const raw = execution.arguments
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('shell-process arguments must be an object')
  if (Buffer.byteLength(canonicalJson(snapshotJson(raw)), 'utf8') > MAX_SHELL_ARGUMENT_BYTES) {
    throw new TypeError('shell-process arguments exceed the semantic projection budget')
  }
  const value = raw as Record<string, unknown>
  if (typeof value.command !== 'string' || value.command.length === 0 || value.command.length > 32_768) {
    throw new TypeError('shell-process projection requires a bounded non-empty command')
  }
  let argv: readonly string[] | undefined
  if (value.argv !== undefined) {
    if (!Array.isArray(value.argv) || value.argv.length > 256 || value.argv.some(item => typeof item !== 'string' || item.length > 8_192)) {
      throw new TypeError('shell-process argv must be a bounded string array')
    }
    argv = Object.freeze([...value.argv]) as readonly string[]
  }
  let environment: Readonly<Record<string, string>> | undefined
  if (value.env !== undefined) {
    if (value.env === null || typeof value.env !== 'object' || Array.isArray(value.env)
      || Object.keys(value.env).length > 64 || Object.entries(value.env).some(([key, entry]) => key.length === 0 || key.length > 256 || typeof entry !== 'string' || entry.length > 8_192)) {
      throw new TypeError('shell-process env must be a bounded string map')
    }
    environment = Object.freeze({ ...value.env as Record<string, string> })
  }
  return { command: value.command, ...(argv === undefined ? {} : { argv }), ...(environment === undefined ? {} : { environment }) }
}

/** Build a fail-closed semantic projector for shell/process tools such as bash. */
export function createShellProcessActionProjector(
  toolNames: readonly string[] = ['bash'],
  projectPermissions?: (execution: ToolExecution) => readonly RequestedPermission[],
): ToolFamilyActionProjector<ToolExecution> {
  if (toolNames.length === 0 || toolNames.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('shell-process projector requires non-empty tool names')
  }
  return Object.freeze({
    family: SHELL_PROCESS_FAMILY,
    projectorId: SHELL_PROCESS_PROJECTOR_ID,
    toolNames: Object.freeze([...toolNames]),
    project(execution: ToolExecution) {
      const cwd = (execution.agent?.session as unknown as { header?: { cwd?: unknown } } | undefined)?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 16_384) {
        throw new TypeError('shell-process projection requires a validated session cwd')
      }
      const semantic = shellArguments(execution)
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        projectorId: SHELL_PROCESS_PROJECTOR_ID,
        semantics: { family: SHELL_PROCESS_FAMILY, value: { ...semantic, cwd } },
        ...(projectPermissions === undefined ? {} : { requestedPermissions: projectPermissions(execution) }),
      }
    },
  })
}

type FilesystemTargetRole = 'target' | 'source' | 'destination' | 'root'

function filesystemPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.startsWith('/') || value.includes('\\')
    || value.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`filesystem projection requires a bounded workspace-relative ${field}`)
  }
  return value
}

function filesystemArguments(execution: ToolExecution, operation: FilesystemOperation): {
  readonly operation: FilesystemOperation
  readonly targets: readonly { readonly path: string; readonly role: FilesystemTargetRole }[]
  readonly recursive: boolean
  readonly reversible: boolean
} {
  const raw = execution.arguments
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('filesystem arguments must be an object')
  if (Buffer.byteLength(canonicalJson(snapshotJson(raw)), 'utf8') > MAX_FILESYSTEM_ARGUMENT_BYTES) {
    throw new TypeError('filesystem arguments exceed the semantic projection budget')
  }
  const value = raw as Record<string, unknown>
  const recursive = value.recursive === undefined ? false : value.recursive
  if (typeof recursive !== 'boolean') throw new TypeError('filesystem recursive must be a boolean')
  const target = (field: string, role: FilesystemTargetRole) => ({ path: filesystemPath(value[field], field), role })
  const targets = operation === 'move'
    ? [target('source', 'source'), target('destination', 'destination')]
    : operation === 'list' || operation === 'glob'
      ? [target('root', 'root')]
      : [target('path', 'target')]
  if (new Set(targets.map(item => item.path)).size !== targets.length) {
    throw new TypeError('filesystem projection rejects duplicate targets')
  }
  if ((operation === 'read' || operation === 'glob') && recursive) {
    throw new TypeError(`filesystem ${operation} does not accept recursive traversal`)
  }
  return {
    operation,
    targets: Object.freeze(targets.map(target => Object.freeze(target))),
    recursive,
    reversible: operation === 'read' || operation === 'list' || operation === 'glob',
  }
}

/** Build a fail-closed semantic projector for explicitly-bound filesystem tools. */
export function createFilesystemActionProjector(
  toolNames: FilesystemToolNames = DEFAULT_FILESYSTEM_TOOL_NAMES,
  projectPermissions?: (execution: ToolExecution) => readonly RequestedPermission[],
): ToolFamilyActionProjector<ToolExecution> {
  const byToolName = new Map<string, FilesystemOperation>()
  for (const [operation, toolName] of Object.entries(toolNames) as [FilesystemOperation, string | undefined][]) {
    if (toolName === undefined) continue
    if (typeof toolName !== 'string' || toolName.length === 0 || byToolName.has(toolName)) {
      throw new TypeError('filesystem projector requires unique non-empty explicitly-bound tool names')
    }
    byToolName.set(toolName, operation)
  }
  if (byToolName.size === 0) throw new TypeError('filesystem projector requires at least one tool binding')
  return Object.freeze({
    family: FILESYSTEM_FAMILY,
    projectorId: FILESYSTEM_PROJECTOR_ID,
    toolNames: Object.freeze([...byToolName.keys()]),
    project(execution: ToolExecution) {
      const operation = byToolName.get(execution.name)
      if (operation === undefined) throw new TypeError(`filesystem projector has no operation for tool ${execution.name}`)
      return {
        toolName: execution.name,
        arguments: execution.arguments,
        projectorId: FILESYSTEM_PROJECTOR_ID,
        semantics: { family: FILESYSTEM_FAMILY, value: filesystemArguments(execution, operation) },
        ...(projectPermissions === undefined ? {} : { requestedPermissions: projectPermissions(execution) }),
      }
    },
  })
}

/**
 * Real `tools/pre-execute` / `tools/result` bridge. Pre-execute runs with
 * `{ prepend: true }` so the complete action is in the capture store before
 * any policy listener asks for approval.
 *
 * Capture is best-effort: an action that cannot be snapshotted (arguments
 * that do not survive lossless JSON, an oversized permission set, a throwing
 * data projector) degrades by SKIPPING the capture, never by breaking the
 * tool call itself. The approval ask then fails closed without a snapshot
 * (`auto` → unavailable, `auto-then-user` → next()). Unexpected projector
 * errors still propagate loudly so programming bugs stay visible.
 */
export interface CaptureBridge {
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
  observeResult(exec: Readonly<ToolExecution>): undefined
}

export function createCaptureBridge(
  projector: ActionProjector<ToolExecution>,
  capture: ActionCapture<Agent, string>,
): CaptureBridge {
  return {
    async preExecute(exec, next) {
      const owner = exec.agent
      if (owner !== undefined) {
        try {
          capture.remember(owner, String(exec.callId), createActionSnapshot(projector.project(exec)))
        } catch (error: unknown) {
          if (!(error instanceof JsonSnapshotError) && !(error instanceof TypeError)) throw error
        }
      }
      return next()
    },
    observeResult(exec): undefined {
      if (exec.agent !== undefined) capture.release(exec.agent, String(exec.callId))
      return undefined
    },
  }
}
