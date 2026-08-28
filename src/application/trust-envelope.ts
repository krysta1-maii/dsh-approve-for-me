import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
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
  try {
    // Resolve symlinks on both sides; a path that points outside the workspace
    // must never be accepted just because the lexical path looks contained.
    const root = realpathSync(resolve(workspaceRoot))
    const absolute = realpathSync(isAbsolute(target) ? target : resolve(root, target))
    const rel = relative(root, absolute)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    // A path that cannot be resolved (including a dangling symlink or a
    // nonexistent target) cannot be proven inside; for a not-yet-created
    // target, resolve its nearest existing parent and re-check that path.
    try {
      const root = realpathSync(resolve(workspaceRoot))
      const lexical = isAbsolute(target) ? target : resolve(root, target)
      const parent = realpathSync(dirname(lexical))
      const absolute = join(parent, basename(lexical))
      const rel = relative(root, absolute)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    } catch {
      return false
    }
  }
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
