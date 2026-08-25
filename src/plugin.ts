import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Config, normalizeConfig } from './config.js'
import type { Config as ApproveForMeConfig, NormalizedConfig } from './config.js'
import { DefaultDecisionChannel } from './application/decision-channel.js'
import { DefaultReviewCoordinator } from './application/review-coordinator.js'
import { DefaultReviewerDirectory } from './application/reviewer-directory.js'
import { SerialLanes } from './application/serial-lanes.js'
import { DefaultActionCapture } from './ports/action-projector.js'
import { createCaptureBridge, createDefaultActionProjector } from './dsh/action-capture.js'
import { createApprovalAnswerer } from './dsh/approval-answerer.js'
import { createManagedReviewerPort } from './dsh/managed-controller.js'
import { createReviewerProvider } from './reviewer/provider.js'
import type { RequestedPermission } from './domain/protocol.js'

export interface ApproveForMePlugin {
  readonly config: NormalizedConfig
  dispose(): Promise<void>
}

/**
 * Programmatic install options beyond the serializable Config. Code-level
 * projection strategies are injected ports, never loader data.
 */
export interface ApproveForMeInstallOptions {
  /** Project requested permissions from exact DSH execution facts. */
  projectPermissions?(execution: ToolExecution): readonly RequestedPermission[]
}

export { Config }

/**
 * Mount the complete DSH business adapter on the standard Guarded Continuable
 * `dsh-managed-agent` Host. Composition order matters: channel → provider →
 * registration → adapters → hooks, so the decision tool never waits on a
 * half-initialized manager.
 */
export function installApproveForMe(
  ctx: Context,
  config: ApproveForMeConfig,
  options: ApproveForMeInstallOptions = {},
): ApproveForMePlugin {
  const normalized = normalizeConfig(config)
  const channel = new DefaultDecisionChannel()
  const captures = new DefaultActionCapture<Agent, string>()
  const bridge = createCaptureBridge(createDefaultActionProjector(options.projectPermissions), captures)

  const registration = ctx.managedAgents.registerProvider(createReviewerProvider({
    submitDecision: {
      submit: (payload, actualReviewerSessionId) =>
        channel.submit(payload, { actualReviewerSessionId }),
    },
  }))
  const port = createManagedReviewerPort(registration.controller)
  const coordinator = new DefaultReviewCoordinator({
    port,
    directory: new DefaultReviewerDirectory(port),
    channel,
    lane: new SerialLanes(),
    timeoutMs: normalized.timeoutMs,
    preset: normalized.preset,
  })
  const answerer = createApprovalAnswerer({ coordinator, captures, mode: normalized.mode })

  const stopPreExecute = ctx.on('tools/pre-execute', bridge.preExecute, { prepend: true })
  const stopResult = ctx.on('tools/result', bridge.observeResult)
  const stopAnswerer = ctx.on('approval/request', answerer, { prepend: true })

  return {
    config: normalized,
    async dispose(): Promise<void> {
      stopAnswerer()
      stopResult()
      stopPreExecute()
      channel.dispose()
      await registration.dispose()
    },
  }
}

/**
 * Loader entrypoint. The Cordis effect exclusively owns the provider disposer,
 * so unload and HMR revoke the Controller before a replacement can register.
 */
export function apply(ctx: Context, config: ApproveForMeConfig): void {
  ctx.effect(() => {
    const plugin = installApproveForMe(ctx, config)
    return () => plugin.dispose()
  }, 'dsh-approve-for-me.install()')
}
