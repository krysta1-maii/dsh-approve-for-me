import z from '@deepseek-ai/schemastery'
import { createReviewerProviderData } from './domain/protocol.js'
import type {
  ReviewMode,
  ReviewerConfiguration,
  ReviewerProviderDataV1,
} from './domain/protocol.js'

/** Stable Cordis plugin identity. */
export const name = 'dsh-approve-for-me'

/**
 * Cordis service injects. All four services are REQUIRED: a missing service
 * means this plugin cannot mount, never a silently degraded Reviewer.
 */
export const inject = ['managedAgents', 'tools', 'systemPrompt', 'approval'] as const

/**
 * Serializable plugin configuration (YAML/JSON-loader expressible). Code-level
 * behavior such as the permission projector stays out of this schema and is
 * supplied through the programmatic install port.
 */
export interface Config {
  readonly mode?: 'auto' | 'auto-then-user'
  readonly timeoutMs?: number
  readonly reviewer: {
    readonly generation: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly policyVersion: string
    readonly toolsetVersion: 1
  }
}

export const Config: z<Config> = z.object({
  mode: z.union(['auto', 'auto-then-user'] as const).default('auto'),
  timeoutMs: z.number().default(30_000),
  reviewer: z.object({
    generation: z.string().min(1).required(),
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    // Schemastery object properties are optional by default; only optional
    // fields are declared without `.required()`.
    reasoningEffort: z.string(),
    policyVersion: z.string().min(1).required(),
    toolsetVersion: z.const(1).required(),
  }),
})

export interface NormalizedConfig {
  readonly mode: ReviewMode
  readonly timeoutMs: number
  readonly preset: ReviewerProviderDataV1
}

/** Validate and normalize loader config before any provider registration. */
export function normalizeConfig(config: Config): NormalizedConfig {
  const mode = config.mode ?? 'auto'
  if (mode !== 'auto' && mode !== 'auto-then-user') {
    throw new TypeError('mode must be "auto" or "auto-then-user"')
  }
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer')
  }
  const reviewerConfig: ReviewerConfiguration = {
    generation: config.reviewer.generation,
    modelRoute: {
      providerId: config.reviewer.provider,
      modelId: config.reviewer.model,
      ...config.reviewer.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: config.reviewer.reasoningEffort },
    },
    policyVersion: config.reviewer.policyVersion,
    toolsetVersion: config.reviewer.toolsetVersion,
  }
  return Object.freeze({
    mode,
    timeoutMs,
    preset: createReviewerProviderData(reviewerConfig),
  })
}
