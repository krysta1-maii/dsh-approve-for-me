import { createHash } from 'node:crypto'
import { canonicalJson } from '../domain/json.js'

/**
 * Closed-world classification of an enabled tool instance for the
 * approve-for-me gate. Every instance in the frozen effective-tool set must
 * classify exactly once; unknown instances fail closed at execution time and
 * fail profile validation at mount time.
 */
export type ToolApprovalClass =
  /** Tool never asks for approval; pass the pre-execute gate through unchanged. */
  | 'ordinary'
  /** Tool asks through the tools/pre-execute `ask` gate. */
  | 'gate-ask'
  /** Tool asks from inside its body (e.g. bash/fs/pwsh sandbox escalation). */
  | 'body-escalation'

export interface ToolApprovalDescriptor {
  readonly toolName: string
  readonly toolSchemaFingerprint: string
  readonly classification: ToolApprovalClass
  /** Closed semantic tool family required for this exact tool instance. */
  readonly actionSemanticsFamily: string
  /** Stable code projector identity required for this exact tool instance. */
  readonly actionProjectorId: string
}

export interface ApprovalToolCatalog {
  readonly version: 1
  readonly argumentSemanticsId: string
  readonly fingerprint: string
  /** Exactly one descriptor per enabled tool instance. */
  readonly descriptors: readonly ToolApprovalDescriptor[]
}

export type ToolApprovalClassificationResult =
  | { readonly kind: 'classified'; readonly classification: ToolApprovalClass }
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'catalog-mismatch' }

const APPROVAL_TOOL_CATALOG_HASH_DOMAIN = 'dsh-approve-for-me/approval-tool-catalog/v1\0'

/** Returns a deterministic content commitment, or undefined for malformed input. */
export function fingerprintApprovalToolCatalogV1(catalog: ApprovalToolCatalog): string | undefined {
  if (catalog.version !== 1 || typeof catalog.argumentSemanticsId !== 'string' || catalog.argumentSemanticsId.length === 0
    || !Array.isArray(catalog.descriptors)) return undefined
  const names = new Set<string>()
  const descriptors: ToolApprovalDescriptor[] = []
  for (const descriptor of catalog.descriptors) {
    if (descriptor === null || typeof descriptor !== 'object' || typeof descriptor.toolName !== 'string' || descriptor.toolName.length === 0
      || typeof descriptor.toolSchemaFingerprint !== 'string' || descriptor.toolSchemaFingerprint.length === 0
      || !['ordinary', 'gate-ask', 'body-escalation'].includes(descriptor.classification)
      || typeof descriptor.actionSemanticsFamily !== 'string' || descriptor.actionSemanticsFamily.length === 0
      || typeof descriptor.actionProjectorId !== 'string' || descriptor.actionProjectorId.length === 0
      || names.has(descriptor.toolName)) {
      return undefined
    }
    names.add(descriptor.toolName)
    descriptors.push({
      toolName: descriptor.toolName,
      toolSchemaFingerprint: descriptor.toolSchemaFingerprint,
      classification: descriptor.classification,
      actionSemanticsFamily: descriptor.actionSemanticsFamily,
      actionProjectorId: descriptor.actionProjectorId,
    })
  }
  const core = { version: 1, argumentSemanticsId: catalog.argumentSemanticsId, descriptors: descriptors.sort((left, right) => left.toolName.localeCompare(right.toolName)) }
  return `sha256:${createHash('sha256').update(APPROVAL_TOOL_CATALOG_HASH_DOMAIN).update(canonicalJson(core)).digest('hex')}`
}

export interface ToolApprovalClassifier {
  classify(input: {
    readonly toolName: string
    readonly toolSchemaFingerprint: string
  }): ToolApprovalClassificationResult
}
