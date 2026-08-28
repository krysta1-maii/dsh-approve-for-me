import { resolve, relative, isAbsolute } from 'node:path'
import type {
  TrustEnvelopeConfigV1,
  TrustEnvelopeEvaluationV1,
  TrustEnvelopeEvaluatorV1,
  TrustEnvelopeInputV1,
  TrustEnvelopeRejectReasonV1,
} from '../approval-gate/trust-envelope.js'

type SandboxRank = 'read-only' | 'workspace-write' | 'danger-full-access'

const RANK: Record<SandboxRank, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

function rank(mode: TrustEnvelopeInputV1['effectiveMode']): number {
  return RANK[mode] ?? Number.POSITIVE_INFINITY
}

function isStrictWidening(from: SandboxRank, to: SandboxRank): boolean {
  return RANK[to] === RANK[from] + 1
}

function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = resolve(workspaceRoot)
  const absolute = isAbsolute(target) ? target : resolve(root, target)
  const rel = relative(root, absolute)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Pure evaluator for the deterministic trust envelope fast path. */
export function createTrustEnvelopeEvaluator(config: TrustEnvelopeConfigV1): TrustEnvelopeEvaluatorV1 {
  return Object.freeze({
    evaluate(input: TrustEnvelopeInputV1): TrustEnvelopeEvaluationV1 {
      const outside = (reason: TrustEnvelopeRejectReasonV1): TrustEnvelopeEvaluationV1 =>
        ({ kind: 'outside', reason })

      if (!config.enabled) return outside('disabled')
      if (!config.tools.includes(input.toolFamily)) return outside('tool-family-not-covered')
      if (input.requestedMode !== undefined && rank(input.requestedMode) > rank(config.maxRequestedMode)) {
        return outside('mode-above-ceiling')
      }
      if (rank(input.effectiveMode) > rank(config.maxRequestedMode)) return outside('mode-above-ceiling')
      if (config.workspaceOnly && input.targets.some(target => !isInsideWorkspace(input.workspaceRoot, target))) {
        return outside('outside-workspace')
      }
      if (config.requireJustification && (input.justification === undefined || input.justification.trim().length === 0)) {
        return outside('missing-justification')
      }
      if (config.requireStrictWidening && input.requestedMode !== undefined) {
        if (!isStrictWidening(input.effectiveMode, input.requestedMode)) {
          return outside('not-strictly-wider')
        }
      }
      return { kind: 'inside' }
    },
  })
}
