import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { parseAuthorizationExtractionSubmissionV1 } from '../domain/extraction-protocol.js'
import type { SubmitExtractionResult } from '../application/extraction-channel.js'

/** Stable native tool name exposed only in an authorization-extractor child scope. */
export const SUBMIT_EXTRACTION_TOOL = 'submit_authorization_extraction'

/**
 * Authority-safe extraction channel injected into the scoped tool. Only the
 * application ExtractionChannel implementation is visible; the provider never
 * sees pending extractions or deadlines.
 */
export interface ExtractionSubmitter {
  submit(payload: unknown, actualExtractorSessionId: string): SubmitExtractionResult
}

/**
 * The closed extraction submission schema (WP7-b). The extractor reports only
 * parser candidates: seqs it was shown, verbatim quotes, effect, coverage and
 * a bounded summary. Times, hashes, lifecycle identity and chain links are all
 * filled in and verified by the Host, never taken from the model.
 */
export const EXTRACTION_SUBMISSION_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'extractionId', 'parentSessionId', 'extractorSessionId', 'generation', 'extractorVersion', 'throughSeq', 'entries'],
  properties: {
    protocolVersion: { type: 'integer', const: 1 },
    extractionId: { type: 'string', minLength: 1 },
    parentSessionId: { type: 'string', minLength: 1 },
    extractorSessionId: { type: 'string', minLength: 1 },
    generation: { type: 'string', minLength: 1 },
    extractorVersion: { type: 'string', minLength: 1 },
    throughSeq: { type: 'integer', minimum: 0 },
    entries: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceSeq', 'quote', 'effect', 'coverage', 'summary'],
        properties: {
          sourceSeq: { type: 'integer', minimum: 0 },
          quote: { type: 'string', minLength: 1 },
          effect: { type: 'string', enum: ['grant', 'deny'] },
          coverage: { type: 'string', enum: ['action', 'turn', 'session'] },
          summary: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const)

/**
 * Two-phase scoped extraction tool (mirrors createDecisionTool):
 * 1. execute validates the live caller identity, parses/stages the candidate,
 *    and marks the turn terminal via concludeTurn(); a schema-noncompliant
 *    payload fails the tool call so the model can correct and resubmit.
 * 2. The child-scoped tools/result observer submits only after that same
 *    execution settled successfully; failure or identity mismatch discards it.
 */
export interface ScopedExtractionTool {
  readonly definition: ToolDefinition
  observeResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
}

export function createExtractionTool(
  expectedChildSessionId: string,
  submitter: ExtractionSubmitter,
): ScopedExtractionTool {
  const staged = new Map<string, unknown>()
  const parameters: Record<string, unknown> = { ...EXTRACTION_SUBMISSION_PARAMETERS }

  const definition: ToolDefinition = {
    name: SUBMIT_EXTRACTION_TOOL,
    description: 'Submit the structured authorization extraction for the supplied message window.',
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['recorded'],
        properties: { recorded: { type: 'boolean' } },
      },
      render: () => [{ type: 'text', text: 'Authorization extraction recorded.' }],
    },
    async execute(args, exec) {
      // Never trust payload identity: the actual live caller is authoritative.
      const actual = exec.agent?.session.id
      if (actual === undefined || String(actual) !== expectedChildSessionId) {
        throw new Error(SUBMIT_EXTRACTION_TOOL + ' is only available to its owning extractor child')
      }
      try {
        parseAuthorizationExtractionSubmissionV1(args)
      } catch (error: unknown) {
        throw new Error('invalid authorization extraction: ' + (error instanceof Error ? error.message : String(error)))
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
