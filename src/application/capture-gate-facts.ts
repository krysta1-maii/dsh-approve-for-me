import type { ActionSnapshot } from '../domain/protocol.js'
import type {
  AllowCacheKeyV1,
  ExactDenialBreakerKeyV1,
} from '../approval-gate/breaker.js'
import type {
  ToolApprovalClassificationResult,
} from '../approval-gate/catalog.js'
import type {
  GateActionFactResolver,
  GateActionFacts,
} from './gate-pipeline.js'
import type {
  TrustEnvelopeInputV1,
} from '../approval-gate/trust-envelope.js'
import type { ParentAuthority } from '../ports/managed-reviewer.js'

export interface GateFactRegistration {
  readonly parentSessionId: string
  readonly actionHash: string
  readonly action: ActionSnapshot
  readonly toolSchemaFingerprint: string
  readonly classification: ToolApprovalClassificationResult
  readonly trustEnvelope?: TrustEnvelopeInputV1
  readonly breakerKey: ExactDenialBreakerKeyV1
  readonly allowCacheKey: AllowCacheKeyV1
  readonly rootRequester: boolean
  readonly directChildOrigin: boolean
  readonly generation: string
  readonly configurationFingerprint: string
  readonly authority: ParentAuthority<unknown, string>
}

/**
 * In-memory action-fact registry. The DSH adapter fills it once per ask from
 * the exact live Agent/capture before the gate resolves; the application layer
 * only sees a session/actionHash keyed view. A future D1 source-backed resolver
 * can replace this without touching the gate pipeline.
 */
export class InMemoryGateActionFactStore implements GateActionFactResolver {
  private readonly byHash = new Map<string, GateActionFacts>()
  private readonly authorityBySession = new Map<string, ParentAuthority<unknown, string>>()

  register(input: GateFactRegistration): void {
    const facts: GateActionFacts = {
      action: input.action,
      toolSchemaFingerprint: input.toolSchemaFingerprint,
      classification: input.classification,
      ...input.trustEnvelope === undefined ? {} : { trustEnvelope: input.trustEnvelope },
      breakerKey: input.breakerKey,
      allowCacheKey: input.allowCacheKey,
      rootRequester: input.rootRequester,
      directChildOrigin: input.directChildOrigin,
      generation: input.generation,
      configurationFingerprint: input.configurationFingerprint,
    }
    this.byHash.set(input.actionHash, facts)
    this.authorityBySession.set(input.parentSessionId, input.authority)
  }

  async resolve(request: { actionHash: string }): Promise<GateActionFacts | undefined> {
    return this.byHash.get(request.actionHash)
  }

  authorityFor(parentSessionId: string): ParentAuthority<unknown, string> | undefined {
    return this.authorityBySession.get(parentSessionId)
  }
}
