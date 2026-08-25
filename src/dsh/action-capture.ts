import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JsonSnapshotError } from '../domain/json.js'
import { createActionSnapshot } from '../domain/protocol.js'
import type { RequestedPermission } from '../domain/protocol.js'
import type { ActionCapture, ActionProjector } from '../ports/action-projector.js'

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
