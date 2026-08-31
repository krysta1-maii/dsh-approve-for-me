import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ApprovalSnapshotRecordV1,
  ParentSessionFactSnapshotV1,
  ToolExecutionFactRecordV1,
} from '../domain/dossier.js'

/**
 * Immutable fact packet bound to the exact live requester and its Session.
 * Implementations must not infer a session from an Agent id or a caller string.
 */
/** Resolves an exact live Agent by its Session id without accepting aliases. */
export interface LiveAgentRegistry {
  get(sessionId: string): Agent | undefined
}

export interface ParentSessionFactSource {
  snapshot(input: {
    readonly agent: Agent
    readonly approvalRequestId: string
    readonly callId: string
    readonly toolName: string
    readonly executionFacts: readonly ToolExecutionFactRecordV1[]
    readonly approvalSnapshots: readonly ApprovalSnapshotRecordV1[]
    readonly signal?: AbortSignal
  }): ParentSessionFactSnapshotV1 | undefined
}
