import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ManagedAgentController } from 'dsh-managed-agent'
import { snapshotJson } from '../domain/json.js'
import type { ReviewerTextBlock } from '../domain/protocol.js'
import type { ManagedReviewerPort } from '../ports/managed-reviewer.js'

/**
 * Adapt the official registration-scoped `ManagedAgentController` to the
 * application port. This is the ONLY place `Agent`/`SessionId`/`ContentBlock`
 * meet domain strings; the controller's identity checks stay authoritative.
 */
export function createManagedReviewerPort(controller: ManagedAgentController): ManagedReviewerPort<Agent, string> {
  return {
    async create(authority, options) {
      return String(await controller.create(authority.live, {
        label: options.label,
        providerData: snapshotJson(options.providerData),
        ...options.signal === undefined ? {} : { signal: options.signal },
      }))
    },
    async list(parentSessionId, signal) {
      const children = await controller.list(SessionId(parentSessionId), signal)
      return children.map((child) => ({
        id: String(child.id),
        parentSessionId: String(child.parentSessionId),
        provider: child.provider,
        label: child.label,
        ...child.providerData === undefined ? {} : { providerData: child.providerData },
        activity: child.activity,
        deliveryAttempts: child.deliveryAttempts,
        retired: child.retired,
        contaminated: child.contaminated,
      }))
    },
    async deliver(authority, childId, content: readonly ReviewerTextBlock[], options) {
      return String(await controller.deliver(
        authority.live,
        SessionId(childId),
        content,
        options?.signal === undefined ? {} : { signal: options.signal },
      ))
    },
    interrupt(authority, childId) {
      controller.interrupt(authority.live, SessionId(childId))
    },
    async rotate(authority, childId, signal) {
      return String(await controller.rotate(
        authority.live,
        SessionId(childId),
        signal,
      ))
    },
    async renew(authority, childId, signal) {
      return String(await controller.renew(
        authority.live,
        SessionId(childId),
        signal,
      ))
    },
  }
}
