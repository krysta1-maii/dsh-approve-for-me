import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-approve-for-me-profile-probe'
export const inject = ['managedAgents', 'approval', 'tools', 'llm', 'agents', 'sessions']

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId, name, args) {
  const id = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function messageTexts(messages) {
  const texts = []
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts
}

function reviewPacket(messages) {
  const text = messageTexts(messages).findLast(value => value.startsWith('Review the following immutable approval review packet'))
  if (text === undefined) return undefined
  const json = text.slice(text.lastIndexOf('\n') + 1)
  return JSON.parse(json)
}

class ProfileSmokeAdapter extends LlmAdapter {
  constructor(scenarios) {
    super()
    this.scenarios = scenarios
    this.rootCalls = new Map()
    this.rootScenarios = new Map()
    this.reviewCalls = 0
  }

  providerInfo(provider) {
    return { id: provider, name: 'Approve-for-me profile smoke' }
  }

  async listModels(provider) {
    return [{ provider, id: 'profile-smoke-model', name: 'Profile smoke model' }]
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Profile smoke model' }
  }

  async *stream(options) {
    const packet = reviewPacket(options.messages)
    if (process.env.DSH_APPROVE_FOR_ME_DEBUG === '1') {
      console.error('[approve-for-me profile adapter]', {
        packet: packet?.version,
        baselineAuthorization: packet?.baseline?.authorization,
        earlierSandboxDenials: packet?.dossier?.pendingApproval?.earlierSandboxDenials,
        tools: options.tools?.map(tool => tool.name),
        textPrefixes: messageTexts(options.messages).map(text => text.slice(0, 80)),
      })
    }
    let chunks
    if (packet !== undefined) {
      const reviewCall = ++this.reviewCalls
      const humanReview = reviewCall > 1
      const decision = humanReview ? 'human_review' : 'allow'
      const baseline = packet.baseline
      const denialRef = baseline.authorization.sandboxDenialCandidateRefs?.[0]
      if (!humanReview && baseline.categories.includes('permission-expansion') && typeof denialRef !== 'string') {
        throw new Error('automatic expansion scenario has no sandbox-denial candidate')
      }
      chunks = toolCallResponse(`profile-review-${reviewCall}`, 'submit_approval_decision', {
        protocolVersion: 1,
        reviewId: packet.request.reviewId,
        parentSessionId: packet.request.parentSessionId,
        reviewerSessionId: packet.request.reviewerSessionId,
        generation: packet.request.generation,
        actionHash: packet.request.actionHash,
        decision,
        risk: baseline.risk,
        categories: baseline.categories,
        userAuthorization: baseline.authorization.level,
        assessment: {
          version: 1,
          targetCovered: baseline.authorization.targetCovered,
          sideEffectsCovered: baseline.authorization.sideEffectsCovered,
          sourceRefs: baseline.authorization.sourceRefs,
          ...(humanReview || typeof denialRef !== 'string') ? {} : {
            sandboxDenialRelation: { sourceRef: denialRef, relation: 'same-action-legitimate-retry' },
          },
          rationale: humanReview ? 'Exercise the composed human fallback.' : 'Exact direct-user authorization covers the guarded command.',
        },
        rationale: humanReview ? 'Delegate this request to the human channel.' : 'Allow the exact, confined, explicitly authorized action.',
      })
    } else if (!options.tools?.some(tool => tool.name === 'bash')) {
      // The session-title helper shares this provider/model but has no root
      // tool catalog. It must not consume a scripted root-agent response.
      chunks = textResponse('Profile approval smoke')
    } else {
      const sessionId = String(options.sessionId ?? '')
      const call = (this.rootCalls.get(sessionId) ?? 0) + 1
      this.rootCalls.set(sessionId, call)
      let scenario = this.rootScenarios.get(sessionId)
      if (scenario === undefined) {
        scenario = this.rootScenarios.size === 0 ? this.scenarios.automatic : this.scenarios.human
        this.rootScenarios.set(sessionId, scenario)
      }
      if (call === 1) chunks = toolCallResponse(`${scenario.id}-initial`, 'bash', scenario.baseArgs)
      else chunks = textResponse('The approval scenario is complete.')
    }
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('profile smoke adapter aborted')
      yield chunk
    }
  }
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`agent ${agent.id} did not return to idle`))
    }, 10_000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })
}

async function send(ctx, agent, text) {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

function approvalOutcomes(agent) {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'approval/decided')
    .map(event => event.data.outcome)
}

function toolResult(agent, callId) {
  const event = agent.session.snapshotEvents().find(event => (
    event.type === 'tool/result'
    && event.data.message?.source?.kind === 'tool'
    && String(event.data.message.source.callId) === callId
  ))
  return event?.data.message?.content?.find(block => block?.type === 'tool-result' && String(block.toolCallId) === callId)
}

function toolResultText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

async function runScenario(ctx, scenario, fallbackAgents) {
  const handle = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: scenario.workspace },
    agentOptions: { provider: 'profile-smoke-provider', model: 'profile-smoke-model' },
  })
  if (scenario.kind === 'human') fallbackAgents.add(String(handle.agent.id))

  const directive = `/approve-for-me ${JSON.stringify({
    version: 1,
    scope: 'next-action',
    allow: { toolName: 'bash', arguments: scenario.baseArgs, requestedPermissions: [] },
  })}`
  await send(ctx, handle.agent, directive)
  return {
    agent: handle.agent,
    outcomes: approvalOutcomes(handle.agent),
    initial: toolResult(handle.agent, `${scenario.id}-initial`),
  }
}

async function applyArm(ctx, marker) {
  const sessionId = process.env.DSH_APPROVE_FOR_ME_PROFILE_PROBE_SESSION
  if (!sessionId) throw new Error('missing DSH_APPROVE_FOR_ME_PROFILE_PROBE_SESSION in arm phase')
  const workspace = dirname(marker)
  const baseArgs = Object.freeze({
    command: "printf 'pending\\n' > pending-side-effect.txt",
    description: 'Run pending resume smoke command',
    workdir: workspace,
  })

  class ArmAdapter extends LlmAdapter {
    constructor() {
      super()
      this.rootCalls = new Map()
      this.reviewCalls = 0
    }

    providerInfo(provider) {
      return { id: provider, name: 'Approve-for-me profile smoke' }
    }

    async listModels(provider) {
      return [{ provider, id: 'profile-smoke-model', name: 'Profile smoke model' }]
    }

    async resolveModel(provider, model) {
      return { provider, id: model, name: 'Profile smoke model' }
    }

    async *stream(options) {
      const packet = reviewPacket(options.messages)
      let chunks
      if (packet !== undefined) {
        const reviewCall = ++this.reviewCalls
        const baseline = packet.baseline
        chunks = toolCallResponse(`profile-review-${reviewCall}`, 'submit_approval_decision', {
          protocolVersion: 1,
          reviewId: packet.request.reviewId,
          parentSessionId: packet.request.parentSessionId,
          reviewerSessionId: packet.request.reviewerSessionId,
          generation: packet.request.generation,
          actionHash: packet.request.actionHash,
          decision: 'human_review',
          risk: baseline.risk,
          categories: baseline.categories,
          userAuthorization: baseline.authorization.level,
          assessment: {
            version: 1,
            targetCovered: baseline.authorization.targetCovered,
            sideEffectsCovered: baseline.authorization.sideEffectsCovered,
            sourceRefs: baseline.authorization.sourceRefs,
            rationale: 'Exercise the composed human fallback.',
          },
          rationale: 'Delegate this request to the human channel.',
        })
      } else if (!options.tools?.some(tool => tool.name === 'bash')) {
        chunks = textResponse('Profile approval smoke')
      } else {
        const sid = String(options.sessionId ?? '')
        const call = (this.rootCalls.get(sid) ?? 0) + 1
        this.rootCalls.set(sid, call)
        if (call === 1) chunks = toolCallResponse('pending-smoke-initial', 'bash', baseArgs)
        else chunks = textResponse('The approval scenario is complete.')
      }
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('profile smoke adapter aborted')
        yield chunk
      }
    }
  }

  const adapter = new ArmAdapter()
  ctx.llm.registerAdapter(['profile-smoke-provider'], adapter)
  await new Promise(resolve => setTimeout(resolve, 0))

  ctx.on('tools/pre-execute', (exec, next) => {
    const description = exec.arguments?.description
    if (exec.name === 'bash' && typeof description === 'string' && description.includes('pending resume smoke command')) {
      return { kind: 'ask', reason: 'Exercise pending approval cold-resume.' }
    }
    return next()
  })

  let targetAgentId = null
  ctx.on('approval/request', async (request, next) => {
    const reqSessionId = String(request.agent.session?.id ?? '')
    const reqAgentId = String(request.agent.id ?? '')
    if (reqSessionId !== sessionId && reqAgentId !== targetAgentId) return next()

    const events = request.agent.session.snapshotEvents()
    const asked = events.findLast(event => event.type === 'approval/asked')
    if (!asked) {
      throw new Error('expected approval/asked event before answerer call')
    }
    await ctx.sessions.flush(request.agent.session)
    const payload = {
      phase: 'armed',
      sessionId,
      requestId: asked.data.id,
      callId: asked.data.callId ?? null,
    }
    writeFileSync(marker, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    process.kill(process.pid, 'SIGKILL')
    return new Promise(() => {})
  })

  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: workspace },
    agentOptions: { provider: 'profile-smoke-provider', model: 'profile-smoke-model' },
  })
  targetAgentId = String(handle.agent.id)

  const directive = `/approve-for-me ${JSON.stringify({
    version: 1,
    scope: 'next-action',
    allow: { toolName: 'bash', arguments: baseArgs, requestedPermissions: [] },
  })}`
  await send(ctx, handle.agent, directive)
  writeFileSync(`${marker}.failure.json`, JSON.stringify({ error: 'send finished without reaching approval/request SIGKILL' }), 'utf8')
  throw new Error('Phase A arm failed: reached end of send without SIGKILL in approval/request answerer')
}

async function applyVerify(ctx, marker) {
  const sessionId = process.env.DSH_APPROVE_FOR_ME_PROFILE_PROBE_SESSION
  if (!sessionId) throw new Error('missing DSH_APPROVE_FOR_ME_PROFILE_PROBE_SESSION in verify phase')
  const workspace = dirname(marker)
  const armMarker = process.env.DSH_APPROVE_FOR_ME_PROFILE_PROBE_ARM ?? join(workspace, 'probe-arm.json')
  if (!existsSync(armMarker)) {
    throw new Error(`probe-arm.json missing at ${armMarker}`)
  }
  const armData = JSON.parse(readFileSync(armMarker, 'utf8'))
  const armRequestId = armData.requestId
  if (!armRequestId) {
    throw new Error(`probe-arm.json missing requestId: ${JSON.stringify(armData)}`)
  }

  class VerifyAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'Approve-for-me profile smoke' }
    }

    async listModels(provider) {
      return [{ provider, id: 'profile-smoke-model', name: 'Profile smoke model' }]
    }

    async resolveModel(provider, model) {
      return { provider, id: model, name: 'Profile smoke model' }
    }

    async *stream(options) {
      const packet = reviewPacket(options.messages)
      let chunks
      if (packet !== undefined) {
        const baseline = packet.baseline
        chunks = toolCallResponse('pending-smoke-verify-review', 'submit_approval_decision', {
          protocolVersion: 1,
          reviewId: packet.request.reviewId,
          parentSessionId: packet.request.parentSessionId,
          reviewerSessionId: packet.request.reviewerSessionId,
          generation: packet.request.generation,
          actionHash: packet.request.actionHash,
          decision: 'human_review',
          risk: baseline.risk,
          categories: baseline.categories,
          userAuthorization: baseline.authorization.level,
          assessment: {
            version: 1,
            targetCovered: baseline.authorization.targetCovered,
            sideEffectsCovered: baseline.authorization.sideEffectsCovered,
            sourceRefs: baseline.authorization.sourceRefs,
            rationale: 'Exercise the composed human fallback.',
          },
          rationale: 'Delegate this request to the human channel.',
        })
      } else if (!options.tools?.some(tool => tool.name === 'bash')) {
        chunks = textResponse('Profile approval smoke')
      } else {
        chunks = textResponse('Verify phase continuation complete.')
      }
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('profile smoke adapter aborted')
        yield chunk
      }
    }
  }

  const adapter = new VerifyAdapter()
  ctx.llm.registerAdapter(['profile-smoke-provider'], adapter)
  await new Promise(resolve => setTimeout(resolve, 0))

  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'profile-smoke-provider', model: 'profile-smoke-model' },
  })
  const agent = handle.agent

  let continued = false
  try {
    await send(ctx, agent, 'Continue after cold-resume.')
    continued = true
  } catch (err) {
    console.error('[verify] continuation failed:', err)
    continued = false
  }

  const events = agent.session.snapshotEvents()

  // 1. orphanAsked: 存在恰好一条 approval/asked 无匹配 approval/decided, 且其 id === probe-arm.json 的 requestId
  const askedEvents = events.filter(e => e.type === 'approval/asked')
  const decidedIds = new Set(events.filter(e => e.type === 'approval/decided').map(e => e.data?.id))
  const orphanAsks = askedEvents.filter(e => !decidedIds.has(e.data?.id))
  const orphanAsked = orphanAsks.length === 1 && orphanAsks[0].data?.id === armRequestId

  // 2. repaired: 存在一条 tool/result (isError true) 其文本含 interrupted, 且 turn/start 数 === turn/end 数 (turn 平衡)
  const turnStarts = events.filter(e => e.type === 'turn/start').length
  const turnEnds = events.filter(e => e.type === 'turn/end').length
  const turnsBalanced = turnStarts > 0 && turnStarts === turnEnds

  const hasInterruptedResult = events.some(event => {
    if (event.type !== 'tool/result') return false
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) return false
    return blocks.some(block => {
      if (block?.type !== 'tool-result' || block.isError !== true) return false
      const text = (toolResultText(block) + (typeof block.text === 'string' ? block.text : '')).toLowerCase()
      return text.includes('interrupted')
    })
  })
  const repaired = turnsBalanced && hasInterruptedResult

  // 3. noLateDecision: arm 阶段 requestId 在 verify 全程没有任何新 approval/decided (包括 resume 后插件重武装过程)
  const noLateDecision = !events.some(e => e.type === 'approval/decided' && e.data?.id === armRequestId)

  // 4. rearmed: typeof ctx.approval?.registerMachinePolicy === 'function'
  const rearmed = typeof ctx.approval?.registerMachinePolicy === 'function'

  // 5. sideEffect: workspace 下 pending-side-effect.txt 不存在 -> sideEffect: false
  const sideEffect = existsSync(join(workspace, 'pending-side-effect.txt'))

  const payload = {
    sessionId,
    orphanAsked,
    repaired,
    noLateDecision,
    rearmed,
    sideEffect,
    continued,
  }

  if (!orphanAsked || !repaired || !noLateDecision || !rearmed || sideEffect !== false || !continued) {
    writeFileSync(`${marker}.failure.json`, `${JSON.stringify({
      payload,
      armData,
      events,
    }, null, 2)}\n`, 'utf8')
    throw new Error(`verify assertions failed: ${JSON.stringify(payload)}`)
  }

  writeFileSync(marker, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 25)
}

export async function apply(ctx) {
  const marker = process.env.DSH_APPROVE_FOR_ME_PROFILE_PROBE
  if (!marker) return

  const phase = process.env.DSH_APPROVE_FOR_ME_PROFILE_PROBE_PHASE
  if (phase === 'arm') {
    await applyArm(ctx, marker)
    return
  }
  if (phase === 'verify') {
    await applyVerify(ctx, marker)
    return
  }

  const workspace = dirname(marker)
  const makeScenario = (kind, id, description) => Object.freeze({
    kind,
    id,
    workspace,
    baseArgs: Object.freeze({ command: `printf '${kind}\\n'`, description, workdir: workspace }),
  })
  const scenarios = Object.freeze({
    automatic: makeScenario('automatic', 'profile-auto', 'Run automatic approval smoke command'),
    human: makeScenario('human', 'profile-human', 'Run human fallback smoke command'),
  })

  const adapter = new ProfileSmokeAdapter(scenarios)
  ctx.llm.registerAdapter(['profile-smoke-provider'], adapter)
  // Adapter publication emits llm/adapters-updated. Let fail-closed Guardian
  // reconciliation validate and arm the newly published route before driving
  // the first approval request.
  await new Promise(resolve => setTimeout(resolve, 0))
  ctx.on('tools/pre-execute', (exec, next) => {
    const description = exec.arguments?.description
    if (exec.name === 'bash' && typeof description === 'string' && description.includes('smoke command')) {
      return { kind: 'ask', reason: 'Exercise the composed Profile approval path.' }
    }
    return next()
  })
  const fallbackAgents = new Set()
  let humanFallbackCalls = 0
  ctx.on('approval/request', (request, next) => {
    if (!fallbackAgents.has(String(request.agent.id))) return next()
    humanFallbackCalls += 1
    return Promise.resolve('rejected')
  })

  const automatic = await runScenario(ctx, scenarios.automatic, fallbackAgents)
  const automaticExecuted = toolResultText(automatic.initial) === 'automatic\n'
  if (humanFallbackCalls !== 0) throw new Error('automatic approval delegated to the human fallback')
  if (!automatic.outcomes.includes('allowed-once') || automatic.initial?.isError !== false || !automaticExecuted) {
    writeFileSync(`${marker}.failure.json`, `${JSON.stringify({
      outcomes: automatic.outcomes,
      events: automatic.agent.session.snapshotEvents(),
    }, null, 2)}\n`, 'utf8')
    throw new Error(`automatic approval did not execute the guarded command: ${JSON.stringify(automatic.outcomes)}`)
  }

  const human = await runScenario(ctx, scenarios.human, fallbackAgents)
  const humanExecuted = toolResultText(human.initial) === 'human\n'
  if (humanFallbackCalls !== 1) {
    writeFileSync(`${marker}.failure.json`, `${JSON.stringify({
      reviewCalls: adapter.reviewCalls,
      rootScenarios: [...adapter.rootScenarios.entries()].map(([sessionId, scenario]) => [sessionId, scenario.kind]),
      outcomes: human.outcomes,
      events: human.agent.session.snapshotEvents(),
    }, null, 2)}\n`, 'utf8')
    throw new Error(`expected one human fallback call, received ${humanFallbackCalls}`)
  }
  if (!human.outcomes.includes('rejected') || human.initial === undefined || humanExecuted) {
    writeFileSync(`${marker}.failure.json`, `${JSON.stringify({
      reviewCalls: adapter.reviewCalls,
      outcomes: human.outcomes,
      commandOutput: toolResultText(human.initial),
      events: human.agent.session.snapshotEvents(),
    }, null, 2)}\n`, 'utf8')
    throw new Error(`human fallback did not block the guarded command: ${JSON.stringify(human.outcomes)}`)
  }

  const schemas = ctx.tools.schemas()
  const payload = {
    managedAgents: typeof ctx.managedAgents?.create === 'function',
    approvalMachinePolicy: typeof ctx.approval?.registerMachinePolicy === 'function',
    toolCount: schemas.length,
    toolNames: schemas.map(tool => tool.name).sort(),
    automaticApproval: {
      outcome: 'allowed-once',
      terminalFallbackCalls: 0,
      sideEffect: automaticExecuted,
    },
    humanFallback: {
      outcome: 'rejected',
      terminalFallbackCalls: humanFallbackCalls,
      sideEffect: humanExecuted,
    },
  }
  writeFileSync(marker, `${JSON.stringify(payload)}\n`, 'utf8')
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 25)
}
