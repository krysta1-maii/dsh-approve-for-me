import { randomUUID } from 'node:crypto'
import { DecisionBroker, ReviewProtocolError } from './broker.js'
import type { ReviewClock } from './broker.js'
import {
  approvalRequestContent,
  createApprovalRequest,
  parseReviewerProviderData,
  REVIEWER_PROVIDER,
} from './protocol.js'
import type {
  ActionSnapshot,
  ApprovalDecision,
  ReviewerProviderDataV1,
  ReviewerTextBlock,
} from './protocol.js'
import type { JsonValue } from './json.js'

export interface ManagedOwnedReviewer {
  readonly id: string
  readonly parentSessionId: string
  readonly provider: string
  readonly label: string
  readonly providerData?: JsonValue
  readonly activity: 'running' | 'inactive'
}

/** Narrow port matching dsh-managed-agent's finalized Controller contract. */
export interface ManagedReviewerController<Parent> {
  create(parent: Parent, options: {
    readonly label: string
    readonly providerData: ReviewerProviderDataV1
    readonly signal?: AbortSignal
  }): Promise<string>
  list(parentSessionId: string, signal?: AbortSignal): Promise<ManagedOwnedReviewer[]>
  deliver(
    parent: Parent,
    childId: string,
    content: readonly ReviewerTextBlock[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<string>
  interrupt(parent: Parent, childId: string): void
}

export interface ReviewerSessionManagerOptions {
  readonly timeoutMs: number
  readonly clock?: ReviewClock
  readonly now?: () => number
  readonly reviewId?: () => string
}

export interface ReviewActionOptions {
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

class KeyedSerialExecutor {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    return run.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
  }
}

/** Application-owned singleton, serialization, delivery, and result protocol. */
export class ReviewerSessionManager<Parent> {
  private readonly broker: DecisionBroker
  private readonly serial = new KeyedSerialExecutor()
  private readonly now: () => number
  private readonly reviewId: () => string

  constructor(
    private readonly controller: ManagedReviewerController<Parent>,
    private readonly options: ReviewerSessionManagerOptions,
  ) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }
    this.broker = new DecisionBroker(options.clock)
    this.now = options.now ?? (options.clock === undefined ? Date.now : () => options.clock!.now())
    this.reviewId = options.reviewId ?? randomUUID
  }

  review(
    parent: Parent,
    parentSessionId: string,
    action: ActionSnapshot,
    providerData: ReviewerProviderDataV1,
    options: ReviewActionOptions = {},
  ): Promise<ApprovalDecision> {
    return this.serial.run(parentSessionId, async () => {
      const desired = parseReviewerProviderData(providerData)
      const childId = await this.ensureReviewer(parent, parentSessionId, desired, options.signal)
      const issuedAt = this.now()
      const request = createApprovalRequest(action, {
        reviewId: this.reviewId(),
        parentSessionId,
        reviewerSessionId: childId,
        generation: desired.generation,
        ...options.callId === undefined ? {} : { callId: options.callId },
        ...options.reason === undefined ? {} : { reason: options.reason },
        issuedAt,
        deadlineAt: issuedAt + this.options.timeoutMs,
      })
      const result = this.broker.arm(request, options.signal)
      // A very fast scoped tool may settle before deliver()'s acceptance promise
      // resumes this task. Attach containment immediately while preserving the
      // original promise for the authoritative await below.
      void result.catch(() => undefined)
      try {
        await this.controller.deliver(
          parent,
          childId,
          approvalRequestContent(request),
          options.signal === undefined ? {} : { signal: options.signal },
        )
      } catch (error: unknown) {
        this.broker.cancel(request.reviewId, 'delivery-failed', `review ${request.reviewId} delivery failed`)
        await result.catch(() => undefined)
        throw error
      }
      try {
        return await result
      } catch (error: unknown) {
        if (error instanceof ReviewProtocolError && error.code !== 'disposed') {
          this.controller.interrupt(parent, childId)
        }
        throw error
      }
    })
  }

  /** Entry used by the provider-installed scoped approval decision tool. */
  submitDecision(input: unknown, actualReviewerSessionId: string, receivedAt?: number): ReturnType<DecisionBroker['submit']> {
    return this.broker.submit(input, {
      actualReviewerSessionId,
      ...receivedAt === undefined ? {} : { receivedAt },
    })
  }

  dispose(): void {
    this.broker.close()
  }

  private async ensureReviewer(
    parent: Parent,
    parentSessionId: string,
    providerData: ReviewerProviderDataV1,
    signal?: AbortSignal,
  ): Promise<string> {
    const desired = parseReviewerProviderData(providerData)
    const children = await this.controller.list(parentSessionId, signal)
    const matching = children.filter((child) => {
      if (child.provider !== REVIEWER_PROVIDER || child.parentSessionId !== parentSessionId) return false
      try {
        const data = parseReviewerProviderData(child.providerData)
        return data.generation === desired.generation
          && data.configurationFingerprint === desired.configurationFingerprint
      } catch {
        return false
      }
    })
    if (matching.length > 1) {
      throw new Error(`multiple Approval Reviewers match parent ${parentSessionId} and generation ${desired.generation}`)
    }
    const existing = matching[0]
    if (existing !== undefined) return existing.id
    return this.controller.create(parent, {
      label: 'Approval Reviewer',
      providerData: desired,
      ...signal === undefined ? {} : { signal },
    })
  }
}
