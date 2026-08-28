import type {
  ApprovalToolCatalog,
  ToolApprovalClassificationResult,
  ToolApprovalClassifier,
} from '../approval-gate/catalog.js'

/**
 * Closed-world classifier over one frozen effective-tool catalog. A tool that
 * is absent from the catalog is unclassified; a tool whose schema fingerprint
 * drifted is a catalog-mismatch — both fail closed at the gate.
 */
export function createToolApprovalClassifier(catalog: ApprovalToolCatalog): ToolApprovalClassifier {
  const byName = new Map(catalog.descriptors.map(descriptor => [descriptor.toolName, descriptor]))

  return Object.freeze({
    classify(input: {
      readonly toolName: string
      readonly toolSchemaFingerprint: string
    }): ToolApprovalClassificationResult {
      const descriptor = byName.get(input.toolName)
      if (descriptor === undefined) return { kind: 'unclassified' }
      if (descriptor.toolSchemaFingerprint !== input.toolSchemaFingerprint) {
        return { kind: 'catalog-mismatch' }
      }
      return { kind: 'classified', classification: descriptor.classification }
    },
  })
}
