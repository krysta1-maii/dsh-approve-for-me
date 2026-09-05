import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SUBMIT_EXTRACTION_TOOL,
  createExtractionTool,
  parseAuthorizationExtractionSubmissionV1,
} from '../../src/index.js'
import type { ScopedExtractionTool } from '../../src/index.js'

function fakeAgent(id: string): Agent {
  return { id: SessionId(id), session: { id: SessionId(id) } } as unknown as Agent
}

function fakeContext(agent: Agent, overrides: {
  callId?: string
} = {}): ToolRunContext {
  return {
    callId: (overrides.callId ?? 'call-1') as ToolRunContext['callId'],
    rootCallId: (overrides.callId ?? 'call-1') as ToolRunContext['callId'],
    name: SUBMIT_EXTRACTION_TOOL,
    arguments: {},
    agent,
    signal: new AbortController().signal,
    token: Symbol('token') as ToolRunContext['token'],
    deferContext: () => {},
    concludeTurn: vi.fn(),
  }
}

function realSubmission() {
  return {
    protocolVersion: 1,
    extractionId: 'ext-1',
    parentSessionId: 'parent-1',
    extractorSessionId: 'extractor-1',
    generation: 'generation-1',
    extractorVersion: 'extractor-v1',
    throughSeq: 42,
    entries: [
      { sourceSeq: 10, quote: 'please allow this', effect: 'grant', coverage: 'action', summary: 'user grants action' },
    ],
  }
}

function success(content: ToolExecutionResult['content'] = []): ToolExecutionResult {
  return {
    isError: false,
    value: { recorded: true },
    content,
  }
}

describe('createExtractionTool', () => {
  it('stages the candidate and concludes the turn without submitting in the body', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({
        status: 'accepted' as const,
        submission: parseAuthorizationExtractionSubmissionV1(realSubmission()),
      })),
    }
    const scoped: ScopedExtractionTool = createExtractionTool('extractor-1', submitter)
    const child = fakeAgent('extractor-1')
    const exec = fakeContext(child)
    const result = await scoped.definition.execute(realSubmission(), exec)
    expect(result).toEqual({ recorded: true })
    expect(submitter.submit).not.toHaveBeenCalled()
    expect(exec.concludeTurn).toHaveBeenCalledOnce()
    // Success terminal result triggers the authoritative submit.
    scoped.observeResult(exec, success())
    expect(submitter.submit).toHaveBeenCalledOnce()
    expect(submitter.submit.mock.calls[0]![0]).toEqual(realSubmission())
    expect(submitter.submit.mock.calls[0]![1]).toBe('extractor-1')
  })

  it('never submits a failed result and discards the staged candidate', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({
        status: 'accepted' as const,
        submission: parseAuthorizationExtractionSubmissionV1(realSubmission()),
      })),
    }
    const scoped = createExtractionTool('extractor-1', submitter)
    const child = fakeAgent('extractor-1')
    const exec = fakeContext(child)
    await scoped.definition.execute(realSubmission(), exec)
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
    const scoped = createExtractionTool('extractor-1', submitter)
    const child = fakeAgent('extractor-1')
    const exec = fakeContext(child)
    const invalid = { ...realSubmission(), extractionId: 42 as unknown as string }
    await expect(scoped.definition.execute(invalid, exec)).rejects.toThrow(/invalid authorization extraction/)
    expect(exec.concludeTurn).not.toHaveBeenCalled()
    scoped.observeResult(exec, success())
    expect(submitter.submit).not.toHaveBeenCalled()
    // A corrected resubmission through a fresh call id still stages normally.
    const retry = fakeContext(child, { callId: 'call-2' })
    await scoped.definition.execute(realSubmission(), retry)
    expect(retry.concludeTurn).toHaveBeenCalledOnce()
  })

  it('accepts the observed string spelling of version constants from extractor models', async () => {
    const submitter = { submit: vi.fn() }
    const scoped = createExtractionTool('extractor-1', submitter)
    const child = fakeAgent('extractor-1')
    const exec = fakeContext(child)
    const stringVersions = { ...realSubmission(), protocolVersion: '1' as unknown as number }
    await expect(scoped.definition.execute(stringVersions, exec)).resolves.toEqual({ recorded: true })
    expect(exec.concludeTurn).toHaveBeenCalledOnce()
  })

  it('rejects a caller that is not the expected extractor child', async () => {
    const submitter = { submit: vi.fn() }
    const scoped = createExtractionTool('extractor-1', submitter)
    const imposter = fakeAgent('extractor-other')
    const exec = fakeContext(imposter)
    await expect(scoped.definition.execute(realSubmission(), exec)).rejects.toThrow(/owning extractor child/)
    expect(submitter.submit).not.toHaveBeenCalled()
    scoped.observeResult(exec, success())
    expect(submitter.submit).not.toHaveBeenCalled()
  })

  it('does not submit when the result carries no caller agent', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({ status: 'unknown' as const, extractionId: 'ext-1' })),
    }
    const scoped = createExtractionTool('extractor-1', submitter)
    const child = fakeAgent('extractor-1')
    const exec = fakeContext(child)
    await scoped.definition.execute(realSubmission(), exec)
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

  it('submits once per staged extraction even on repeated result events', async () => {
    const submitter = {
      submit: vi.fn((_payload: unknown, _actualId: string) => ({
        status: 'accepted' as const,
        submission: parseAuthorizationExtractionSubmissionV1(realSubmission()),
      })),
    }
    const scoped = createExtractionTool('extractor-1', submitter)
    const child = fakeAgent('extractor-1')
    const exec = fakeContext(child)
    await scoped.definition.execute(realSubmission(), exec)
    scoped.observeResult(exec, success())
    scoped.observeResult(exec, success())
    expect(submitter.submit).toHaveBeenCalledOnce()
  })
})
