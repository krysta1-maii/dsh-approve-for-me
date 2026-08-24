import { describe, expect, it } from 'vitest'
import {
  JsonSnapshotError,
  approvalReviewRequestContent,
  createActionSnapshot,
  createApprovalReviewRequest,
  createReviewerProviderData,
  hashAction,
  parseApprovalDecision,
  parseApprovalReviewRequest,
  parseReviewerProviderData,
  resolveApprovalDecision,
  snapshotJson,
} from '../../src/index.js'

const providerData = () => createReviewerProviderData({
  generation: 'generation-1',
  modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat', reasoningEffort: 'high' },
  policyVersion: 'policy-1',
  toolsetVersion: 1,
})

const action = () => createActionSnapshot({
  toolName: 'bash',
  arguments: { command: 'git status', sandbox_permissions: 'workspace-write' },
  requestedPermissions: [{ kind: 'sandbox', scope: 'workspace-write' }],
})

const request = () => createApprovalReviewRequest(action(), {
  reviewId: 'review-1',
  parentSessionId: 'parent-1',
  reviewerSessionId: 'reviewer-1',
  generation: 'generation-1',
  callId: 'call-1',
  reason: 'requires a wider sandbox',
  issuedAt: 100,
  deadlineAt: 200,
})

const decision = () => ({
  protocolVersion: 1,
  reviewId: 'review-1',
  parentSessionId: 'parent-1',
  reviewerSessionId: 'reviewer-1',
  generation: 'generation-1',
  actionHash: request().actionHash,
  decision: 'allow',
  risk: 'low',
  categories: ['workspace-write'],
  userAuthorization: 'explicit',
  rationale: 'The user explicitly requested this exact write.',
})

describe('reviewer provider data', () => {
  it('computes and verifies a frozen composition fingerprint', () => {
    const data = providerData()
    expect(data.modelRoute.reasoningEffort).toBe('high')
    expect(data.configurationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(parseReviewerProviderData(structuredClone(data))).toEqual(data)
    expect(Object.isFrozen(data)).toBe(true)
    expect(Object.isFrozen(data.modelRoute)).toBe(true)
  })

  it('includes reasoningEffort in the configuration fingerprint', () => {
    const withEffort = providerData()
    const withoutEffort = createReviewerProviderData({
      generation: 'generation-1',
      modelRoute: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      policyVersion: 'policy-1',
      toolsetVersion: 1,
    })
    expect(withEffort.configurationFingerprint).not.toBe(withoutEffort.configurationFingerprint)
    expect(() => parseReviewerProviderData({
      ...withoutEffort,
      modelRoute: { ...withoutEffort.modelRoute, effort: 'high' },
    })).toThrow(/not supported/)
  })

  it('rejects unknown versions, fields, and forged fingerprints', () => {
    const data = providerData()
    expect(() => parseReviewerProviderData({ ...data, version: 2 })).toThrow(/version/)
    expect(() => parseReviewerProviderData({ ...data, secret: 'x' })).toThrow(/not supported/)
    expect(() => parseReviewerProviderData({ ...data, configurationFingerprint: `sha256:${'0'.repeat(64)}` }))
      .toThrow(/does not match/)
  })
})

describe('action snapshots and requests', () => {
  it('hashes object keys canonically while preserving array order', () => {
    const first = createActionSnapshot({ toolName: 'bash', arguments: { b: 2, a: { y: 2, x: 1 } } })
    const second = createActionSnapshot({ toolName: 'bash', arguments: { a: { x: 1, y: 2 }, b: 2 } })
    const reordered = createActionSnapshot({ toolName: 'bash', arguments: { a: [2, 1], b: 2 } })
    const ordered = createActionSnapshot({ toolName: 'bash', arguments: { a: [1, 2], b: 2 } })
    expect(hashAction(first)).toBe(hashAction(second))
    expect(hashAction(reordered)).not.toBe(hashAction(ordered))
  })

  it('snapshots and recursively freezes mutable arguments', () => {
    const input = { nested: { value: 1 } }
    const frozen = createActionSnapshot({ toolName: 'write', arguments: input })
    input.nested.value = 2
    expect(frozen.arguments).toEqual({ nested: { value: 1 } })
    expect(Object.isFrozen(frozen.arguments)).toBe(true)
    expect(Object.isFrozen((frozen.arguments as { nested: object }).nested)).toBe(true)
  })

  it('rejects values that do not survive lossless JSON', () => {
    expect(() => snapshotJson({ missing: undefined })).toThrow(JsonSnapshotError)
    expect(() => snapshotJson({ invalid: Number.NaN })).toThrow(JsonSnapshotError)
    expect(() => snapshotJson(-0)).toThrow(JsonSnapshotError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => snapshotJson(cyclic)).toThrow(/cycle/)
  })

  it('recomputes actionHash when parsing an untrusted request', () => {
    const value = request()
    expect(parseApprovalReviewRequest(structuredClone(value))).toEqual(value)
    expect(() => parseApprovalReviewRequest({ ...value, actionHash: `sha256:${'0'.repeat(64)}` })).toThrow(/does not match/)
  })

  it('serializes one complete immutable request block', () => {
    const content = approvalReviewRequestContent(request())
    expect(content).toHaveLength(1)
    const encoded = content[0]!.text.split('\n').at(-1)!
    expect(parseApprovalReviewRequest(JSON.parse(encoded))).toEqual(request())
    expect(Object.isFrozen(content)).toBe(true)
  })
})

describe('approval decisions', () => {
  it('strictly parses a complete decision', () => {
    const parsed = parseApprovalDecision(decision())
    expect(parsed.decision).toBe('allow')
    expect(Object.isFrozen(parsed.categories)).toBe(true)
  })

  it('rejects free text, extra fields, bad hashes, and unknown enums', () => {
    expect(() => parseApprovalDecision('allow')).toThrow(/object/)
    expect(() => parseApprovalDecision({ ...decision(), extra: true })).toThrow(/not supported/)
    expect(() => parseApprovalDecision({ ...decision(), actionHash: 'abc' })).toThrow(/sha256/)
    expect(() => parseApprovalDecision({ ...decision(), risk: 'safe' })).toThrow(/must be one of/)
  })

  it('maps only a validated allow to an automatic grant', () => {
    const allow = parseApprovalDecision(decision())
    const deny = parseApprovalDecision({ ...decision(), decision: 'deny' })
    const human = parseApprovalDecision({ ...decision(), decision: 'human_review' })
    expect(resolveApprovalDecision(allow, 'auto')).toEqual({ kind: 'outcome', outcome: 'allowed-once' })
    expect(resolveApprovalDecision(deny, 'auto-then-user')).toEqual({ kind: 'outcome', outcome: 'rejected' })
    expect(resolveApprovalDecision(human, 'auto')).toEqual({ kind: 'outcome', outcome: 'rejected' })
    expect(resolveApprovalDecision(human, 'auto-then-user')).toEqual({ kind: 'delegate' })
  })
})
