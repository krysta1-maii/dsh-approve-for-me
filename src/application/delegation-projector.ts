import type {
  DelegationToolClassificationCatalogV1,
  DelegationToolDescriptorV1,
  DelegationReceiptFactRecordV1,
  PrincipalDelegationEntryV1,
  PrincipalDelegationProjector,
  ToolAttemptV1,
} from '../domain/dossier.js'

function requestOrder(attempt: ToolAttemptV1): readonly [number, number, number] {
  if (attempt.request.kind === 'model-tool-call') {
    return [attempt.request.issuedIn.turn ?? 0, attempt.request.issuedIn.seq, attempt.request.blockIndex]
  }
  return [attempt.request.dispatchStart.turn ?? 0, attempt.request.dispatchStart.seq, 0]
}

function receiptMatchesDescriptor(
  descriptor: Extract<DelegationToolDescriptorV1, { readonly classification: 'delegation' }>,
  receipt: DelegationReceiptFactRecordV1 | undefined,
  attempt: ToolAttemptV1,
): boolean {
  if (descriptor.receiptPolicy.kind === 'none') return receipt === undefined
  if (attempt.outcome.kind !== 'completed') return true
  if (receipt === undefined) return false
  return descriptor.receiptPolicy.receiptKinds.includes(receipt.receipt.kind)
}

/**
 * Deterministic stock/subagent delegation projector. It never reads child
 * Sessions; it only projects the parent-side tool attempt and any content-free
 * durable receipt already joined by the fact layer.
 */
export class DefaultPrincipalDelegationProjector implements PrincipalDelegationProjector {
  // The descriptor is supplied from the per-execution durable catalog. The
  // projection algorithm itself has no independent catalog authority.
  constructor(_legacyCatalog?: DelegationToolClassificationCatalogV1) {}

  project(input: {
    readonly principalSessionId: string
    readonly attempt: ToolAttemptV1
    readonly descriptor: Extract<DelegationToolDescriptorV1, { readonly classification: 'delegation' }>
    readonly receipt?: DelegationReceiptFactRecordV1
  }): { kind: 'delegation'; readonly entry: PrincipalDelegationEntryV1 } | { kind: 'invalid'; readonly reason: string } {
    const { attempt, descriptor } = input
    if (attempt.request.callId.length === 0) return { kind: 'invalid', reason: 'malformed-request' }
    if (descriptor.toolName !== attempt.request.toolName) return { kind: 'invalid', reason: 'catalog-mismatch' }
    if (!receiptMatchesDescriptor(descriptor, input.receipt, attempt)) {
      return { kind: 'invalid', reason: 'receipt-mismatch' }
    }
    const entry: PrincipalDelegationEntryV1 = Object.freeze({
      projectorId: descriptor.projectorId,
      order: Object.freeze(requestOrder(attempt)) as readonly [number, number, number],
      attempt,
      operation: descriptor.operation,
      ...input.receipt === undefined ? {} : { receipt: input.receipt.receipt },
    })
    return { kind: 'delegation', entry }
  }
}
