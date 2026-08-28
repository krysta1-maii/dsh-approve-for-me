import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest, type MachineApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Same minimal stand-in as `approval.spec.ts`: the service only reaches
 * `agent.session.append` and folds `.events`.
 */
function fakeAgent(seed: Array<{ type: string }> = [{ type: 'turn/start' }, { type: 'user/message' }]): {
  agent: Agent
  appended: Array<{ type: string; data: Record<string, unknown> }>
} {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    session: {
      events: seed,
      append: (type: string, data: Record<string, unknown>) => {
        appended.push({ type, data })
        return { type, data } as unknown as SessionEvent
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ApprovalService)
  return ctx
}

function requestOf(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'echo', ...overrides }
}

function policy(id: string, decide: MachineApprovalPolicy['decide']): MachineApprovalPolicy {
  return { id, decide }
}

describe('ApprovalService.registerMachinePolicy', () => {
  it('runs before every interactive answerer, even a prepended one', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const consulted: string[] = []
    ctx.on('approval/request', () => {
      consulted.push('listener')
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }, { prepend: true })
    const dispose = ctx.approval.registerMachinePolicy(policy('afm/v1', async (request) => {
      consulted.push('machine')
      expect(request.requestId).toBeTypeOf('string')
      return 'rejected'
    }))

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('rejected')
    expect(consulted).toEqual(['machine'])
    dispose()
  })

  it('is preempted by the deterministic never policy', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent([{ type: 'turn/start' }, { type: 'user/message' }, { type: 'approval/policy', data: { policy: 'never' } }])
    const consulted = vi.fn(async () => 'allowed-once' as const)
    ctx.approval.registerMachinePolicy(policy('afm/allow', consulted))

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('rejected')
    expect(consulted).not.toHaveBeenCalled()
  })

  it('delegates to the next machine policy and then the interactive waterfall', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const order: string[] = []
    ctx.on('approval/request', () => {
      order.push('listener')
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }, { prepend: true })
    ctx.approval.registerMachinePolicy(policy('afm/first', async () => {
      order.push('first')
      return 'delegate'
    }))
    ctx.approval.registerMachinePolicy(policy('afm/second', async () => {
      order.push('second')
      return 'delegate'
    }))

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('allowed-once')
    expect(order).toEqual(['first', 'second', 'listener'])
  })

  it('claims with the first non-delegate result in registration order', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const order: string[] = []
    ctx.approval.registerMachinePolicy(policy('afm/first', async () => {
      order.push('first')
      return 'allowed-once'
    }))
    const second = vi.fn(async () => 'rejected' as const)
    ctx.approval.registerMachinePolicy(policy('afm/second', second))

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('allowed-once')
    expect(order).toEqual(['first'])
    expect(second).not.toHaveBeenCalled()
  })

  it('rejects duplicate ids and removes an entry through its disposer', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const dispose = ctx.approval.registerMachinePolicy(policy('afm/v1', async () => 'rejected'))

    expect(() => ctx.approval.registerMachinePolicy(policy('afm/v1', async () => 'allowed-once'))).toThrow(/duplicate machine approval policy id/)
    dispose()
    const outcome = await ctx.approval.request(requestOf(agent))
    expect(outcome).toBe('unavailable')
  })

  it('fails the question closed when a machine policy throws', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    ctx.approval.registerMachinePolicy(policy('afm/throwing', async () => {
      throw new Error('policy bug')
    }))

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('unavailable')
  })

  it('normalizes a rogue machine-policy return to unavailable', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    ctx.approval.registerMachinePolicy(policy('afm/rogue', async () => 'yolo' as ApprovalOutcome))

    const outcome = await ctx.approval.request(requestOf(agent))

    expect(outcome).toBe('unavailable')
  })

  it('carries the exact requestId that pairs approval/asked with approval/decided', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    let seenRequestId: string | undefined
    ctx.approval.registerMachinePolicy(policy('afm/id', async (request) => {
      seenRequestId = request.requestId
      return 'allowed-once'
    }))

    const outcome = await ctx.approval.request(requestOf(agent, { callId: ToolCallId('call-1') }))

    expect(outcome).toBe('allowed-once')
    const [asked, decided] = appended
    expect(asked?.data['id']).toBe(seenRequestId)
    expect(decided?.data['id']).toBe(seenRequestId)
  })
})
