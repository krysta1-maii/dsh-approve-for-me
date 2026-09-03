import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SUBMIT_DECISION_TOOL,
  createDecisionTool,
  parseApprovalDecision,
} from '../../src/index.js'
import type { ScopedDecisionTool } from '../../src/index.js'

function fakeAgent(id: string): Agent {
  return { id: SessionId(id), session: { id: SessionId(id) } } as unknown as Agent
}

function fakeContext(agent: Agent, overrides: {
  callId?: string
} = {}): ToolRunContext {
  return {
    callId: (overrides.callId ?? 'call-1') as ToolRunContext['callId'],
    rootCallId: (overrides.callId ?? 'call-1') as ToolRunContext['callId'],
    name: SUBMIT_DECISION_TOOL,
    arguments: {},
    agent,
    signal: new AbortController().signal,
    token: Symbol('token') as ToolRunContext['token'],
    deferContext: () => {},
    concludeTurn: vi.fn(),
  }
}

function realDecision() {
  return {
    protocolVersion: 1,
    reviewId: 'review-1',
    parentSessionId: 'parent-1',
    reviewerSessionId: 'reviewer-1',
    generation: 'generation-1',
    actionHash: `sha256:${'0'.repeat(64)}`,
    decision: 'allow',
    risk: 'low',
    categories: [],
    userAuthorization: 'explicit',
    rationale: 'Explicitly authorized.',
  }
}

function success(content: ToolExecutionResult['content'] = []): ToolExecutionResult {
  return {
    isError: false,
    value: { recorded: true },
    content,
  }
}

describe('createDecisionTool', () => {
  it('stages the candidate and concludes the turn without submitting in the body', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({
        status: 'accepted' as const,
        decision: parseApprovalDecision(realDecision()),
      })),
    }
    const scoped: ScopedDecisionTool = createDecisionTool('reviewer-1', submitter)
    const child = fakeAgent('reviewer-1')
    const exec = fakeContext(child)
    const result = await scoped.definition.execute(realDecision(), exec)
    expect(result).toEqual({ recorded: true })
    expect(submitter.submit).not.toHaveBeenCalled()
    expect(exec.concludeTurn).toHaveBeenCalledOnce()
    // Success terminal result triggers the authoritative submit.
    scoped.observeResult(exec, success())
    expect(submitter.submit).toHaveBeenCalledOnce()
    expect(submitter.submit.mock.calls[0]![0]).toEqual(realDecision())
    expect(submitter.submit.mock.calls[0]![1]).toBe('reviewer-1')
  })

  it('never submits a failed result and discards the staged candidate', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({
        status: 'accepted' as const,
        decision: parseApprovalDecision(realDecision()),
      })),
    }
    const scoped = createDecisionTool('reviewer-1', submitter)
    const child = fakeAgent('reviewer-1')
    const exec = fakeContext(child)
    await scoped.definition.execute(realDecision(), exec)
    scoped.observeResult(exec, {
      isError: true,
      error: { message: 'tool blew up' },
      content: [],
    } satisfies ToolExecutionResult)
    expect(submitter.submit).not.toHaveBeenCalled()
    scoped.observeResult(exec, success())
    expect(submitter.submit).not.toHaveBeenCalled()
  })

  it('rejects a schema-noncompliant payload with corrective feedback before staging', async () => {
    const submitter = { submit: vi.fn() }
    const scoped = createDecisionTool('reviewer-1', submitter)
    const child = fakeAgent('reviewer-1')
    const exec = fakeContext(child)
    const invalid = { ...realDecision(), reviewId: 42 as unknown as string }
    await expect(scoped.definition.execute(invalid, exec)).rejects.toThrow(/invalid approval decision/)
    expect(exec.concludeTurn).not.toHaveBeenCalled()
    scoped.observeResult(exec, success())
    expect(submitter.submit).not.toHaveBeenCalled()
    // A corrected resubmission through a fresh call id still stages normally.
    const retry = fakeContext(child, { callId: 'call-2' })
    await scoped.definition.execute(realDecision(), retry)
    expect(retry.concludeTurn).toHaveBeenCalledOnce()
  })

  it('accepts the observed string spelling of version constants from reviewer models', async () => {
    const submitter = { submit: vi.fn() }
    const scoped = createDecisionTool('reviewer-1', submitter)
    const child = fakeAgent('reviewer-1')
    const exec = fakeContext(child)
    const stringVersions = { ...realDecision(), protocolVersion: '1' as unknown as number }
    await expect(scoped.definition.execute(stringVersions, exec)).resolves.toEqual({ recorded: true })
    expect(exec.concludeTurn).toHaveBeenCalledOnce()
  })

  it('rejects a caller that is not the expected Reviewer child', async () => {
    const submitter = { submit: vi.fn() }
    const scoped = createDecisionTool('reviewer-1', submitter)
    const imposter = fakeAgent('reviewer-other')
    const exec = fakeContext(imposter)
    await expect(scoped.definition.execute(realDecision(), exec)).rejects.toThrow(/owning Reviewer child/)
    expect(submitter.submit).not.toHaveBeenCalled()
    scoped.observeResult(exec, success())
    expect(submitter.submit).not.toHaveBeenCalled()
  })

  it('does not submit when the result carries no caller agent', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({ status: 'unknown' as const, reviewId: 'review-1' })),
    }
    const scoped = createDecisionTool('reviewer-1', submitter)
    const child = fakeAgent('reviewer-1')
    const exec = fakeContext(child)
    await scoped.definition.execute(realDecision(), exec)
    const callerLess: ToolExecution = {
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      name: exec.name,
      arguments: exec.arguments,
      signal: exec.signal,
      token: exec.token,
    }
    scoped.observeResult(callerLess, success())
    expect(submitter.submit).not.toHaveBeenCalled()
  })

  it('submits once per staged decision even on repeated result events', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({
        status: 'accepted' as const,
        decision: parseApprovalDecision(realDecision()),
      })),
    }
    const scoped = createDecisionTool('reviewer-1', submitter)
    const child = fakeAgent('reviewer-1')
    const exec = fakeContext(child)
    await scoped.definition.execute(realDecision(), exec)
    scoped.observeResult(exec, success())
    scoped.observeResult(exec, success())
    expect(submitter.submit).toHaveBeenCalledOnce()
  })
})
