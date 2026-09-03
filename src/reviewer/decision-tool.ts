import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { parseApprovalDecision } from '../domain/protocol.js'
import { REVIEWER_DECISION_PARAMETERS } from './policy.js'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubmitDecisionResult } from '../application/decision-channel.js'

/** Stable native tool name exposed only in a Reviewer child scope. */
export const SUBMIT_DECISION_TOOL = 'submit_approval_decision'

/**
 * Authority-safe result channel used by the scoped decision tool. Only the
 * application `DecisionChannel` implementation is injected here; the provider
 * never sees pending reviews or deadlines.
 */
export interface DecisionSubmitter {
  submit(payload: unknown, actualReviewerSessionId: string): SubmitDecisionResult
}

/**
 * Two-phase scoped decision tool:
 *
 * 1. `ToolDefinition.execute` validates the caller identity, parses/stages the
 *    candidate decision, and marks the turn terminal via `concludeTurn()`.
 * 2. The child-scoped `tools/result` observer submits ONLY after the same
 *    execution settled as a successful terminal result; any failure or
 *    identity mismatch discards the candidate without submitting.
 */
export interface ScopedDecisionTool {
  readonly definition: ToolDefinition
  observeResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
}

export function createDecisionTool(
  expectedChildSessionId: string,
  submitter: DecisionSubmitter,
  decisionParameters: ObjectJsonSchema = REVIEWER_DECISION_PARAMETERS,
): ScopedDecisionTool {
  const staged = new Map<string, unknown>()
  // Fresh object literal: gives the loosely-typed ToolSchema.parameters field
  // its implicit index signature without any cast at the DSH seam.
  const parameters: Record<string, unknown> = { ...decisionParameters }

  const definition: ToolDefinition = {
    name: SUBMIT_DECISION_TOOL,
    description: 'Submit the structured decision for the current approval request.',
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['recorded'],
        properties: { recorded: { type: 'boolean' } },
      },
      render: () => [{ type: 'text', text: 'Approval decision recorded.' }],
    },
    async execute(args, exec) {
      // Never trust payload identity: the actual live caller is authoritative.
      const actual = exec.agent?.session.id
      if (actual === undefined || String(actual) !== expectedChildSessionId) {
        throw new Error(`${SUBMIT_DECISION_TOOL} is only available to its owning Reviewer child`)
      }
      // Validate BEFORE returning success. Real-world reviewer models
      // occasionally emit schema-noncompliant payloads (e.g. protocolVersion
      // as a string); surfacing the parse error as a tool failure lets the
      // Reviewer correct and resubmit within its turn instead of silently
      // killing the pending review with an 'invalid-result' it never sees.
      try {
        parseApprovalDecision(args)
      } catch (error: unknown) {
        throw new Error(
          `invalid approval decision: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      staged.set(String(exec.callId), args)
      exec.concludeTurn()
      return { recorded: true }
    },
  }

  return {
    definition,
    observeResult(exec, result): undefined {
      const candidate = staged.get(String(exec.callId))
      if (candidate === undefined) return
      staged.delete(String(exec.callId))
      const actual = exec.agent?.session.id
      if (result.isError || actual === undefined) return
      if (String(actual) !== expectedChildSessionId) return
      submitter.submit(candidate, String(actual))
    },
  }
}
