import type { ActionSnapshotInput } from '../domain/protocol.js'
import type { ActionProjector } from './action-projector.js'

/**
 * A code-level semantic projector for one closed set of DSH tool names.
 *
 * Projectors deliberately live outside serializable plugin configuration. A
 * registry has no generic fallback: an unrecognised tool has no sufficiently
 * complete semantic snapshot and capture must fail closed for auto approval.
 */
export interface ToolFamilyActionProjector<Execution> {
  readonly family: string
  /** Stable implementation/version identity committed into ActionSnapshot. */
  readonly projectorId: string
  readonly toolNames: readonly string[]
  project(execution: Execution): ActionSnapshotInput
}

/**
 * Resolves tool calls to exactly one registered tool-family projector.
 * Duplicate/empty registrations are rejected at composition time; an
 * unregistered tool throws TypeError, which the capture bridge treats as a
 * missing action snapshot rather than allowing auto approval.
 */
export class ToolFamilyActionProjectorRegistry<Execution extends { readonly name: string }>
  implements ActionProjector<Execution> {
  private readonly byToolName = new Map<string, ToolFamilyActionProjector<Execution>>()

  constructor(projectors: readonly ToolFamilyActionProjector<Execution>[]) {
    for (const projector of projectors) {
      if (typeof projector.family !== 'string' || projector.family.length === 0) {
        throw new TypeError('tool-family projector family must be a non-empty string')
      }
      if (typeof projector.projectorId !== 'string' || projector.projectorId.length === 0) {
        throw new TypeError(`tool-family projector ${projector.family} must have a non-empty projector id`)
      }
      if (!Array.isArray(projector.toolNames) || projector.toolNames.length === 0) {
        throw new TypeError(`tool-family projector ${projector.family} must register at least one tool`)
      }
      for (const toolName of projector.toolNames) {
        if (typeof toolName !== 'string' || toolName.length === 0) {
          throw new TypeError(`tool-family projector ${projector.family} has an invalid tool name`)
        }
        if (this.byToolName.has(toolName)) {
          throw new TypeError(`tool ${toolName} is registered by more than one tool-family projector`)
        }
        this.byToolName.set(toolName, projector)
      }
    }
  }

  /** Returns the full closed set of tool names registered for semantic capture. */
  registeredToolNames(): readonly string[] {
    return Object.freeze([...this.byToolName.keys()].sort())
  }

  /** True only when a catalog descriptor binds this exact registered projector. */
  matches(toolName: string, family: string, projectorId: string): boolean {
    const projector = this.byToolName.get(toolName)
    return projector?.family === family && projector.projectorId === projectorId
  }

  /**
   * WP8-c: true only when the tool's registered projector claims this exact
   * implementation identity. The seal backfill re-resolves the projector for
   * every sidecar record before promoting it, so a forged projectorId on an
   * old row can never be backfilled into the ledger.
   */
  matchesProjector(toolName: string, projectorId: string): boolean {
    if (typeof toolName !== 'string' || toolName.length === 0
      || typeof projectorId !== 'string' || projectorId.length === 0) return false
    return this.byToolName.get(toolName)?.projectorId === projectorId
  }

  project(execution: Execution): ActionSnapshotInput {
    const toolName = execution.name
    const projector = this.byToolName.get(toolName)
    if (projector === undefined) {
      throw new TypeError(`no complete action semantics are registered for tool ${toolName}`)
    }
    const action = projector.project(execution)
    if (action.toolName !== toolName) {
      throw new TypeError(`tool-family projector ${projector.family} projected a mismatched tool name`)
    }
    if (action.projectorId !== projector.projectorId || action.semantics?.family !== projector.family) {
      throw new TypeError(`tool-family projector ${projector.family} emitted an unbound semantic action`)
    }
    return action
  }
}
