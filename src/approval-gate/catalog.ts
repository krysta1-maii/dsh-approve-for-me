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

export interface ToolApprovalClassifier {
  classify(input: {
    readonly toolName: string
    readonly toolSchemaFingerprint: string
  }): ToolApprovalClassificationResult
}
