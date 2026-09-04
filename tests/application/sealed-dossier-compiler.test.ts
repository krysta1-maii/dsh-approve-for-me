import { describe, expect, it } from 'vitest'
import {
  createActionSnapshot,
  createActivityV1,
  createSealV1,
  createSealedDossierCompiler,
  genesisSealHash,
  hashAction,
  recomputeDossierHash,
} from '../../src/index.js'
import type {
  ActivityV1,
  SealResultStatusV1,
  SealV1,
  SealedDossierCompileInputV1,
  SealedDossierCurrentFactsV1,
  SealedParentSessionFactsV1,
} from '../../src/index.js'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const lifecycle = 'lifecycle-1'
const catalogFingerprint = hash('a')

function seal(sourceSeq: number, status: SealResultStatusV1, overrides: Partial<SealV1> = {}): SealV1 {
  return createSealV1({
    lifecycleFingerprint: lifecycle,
    sourceSeq,
    request: { eventSeq: sourceSeq, eventType: 'tool/call', callId: `call-${sourceSeq}`, toolName: 'bash' },
    approvalAsked: { eventSeq: sourceSeq + 1, requestId: 'ask-1' },
    actionHash: hash('b'),
    projectorId: 'dsh-approve-for-me/generic-raw-v1',
    catalog: { epoch: 0, headerEventSeq: 3, commitment: hash('c') },
    wireSchemaFingerprint: hash('d'),
    result: { eventSeq: sourceSeq + 2, status },
    epochBoundary: { previousEpoch: null, changed: false },
    previousSealHash: sourceSeq === 0 ? genesisSealHash(lifecycle) : hash('e'),
    ...overrides,
  })
}

function activity(sourceSeq: number, classification: string, targetSummary: string, status: SealResultStatusV1, overrides: Partial<ActivityV1> = {}): ActivityV1 {
  return createActivityV1({
    lifecycleFingerprint: lifecycle,
    sourceSeq,
    occurredAt: 1_000 + sourceSeq,
    classification,
    targetSummary,
    resultCategory: status,
    sourceSealHash: hash('f'),
    ...overrides,
  })
}

function currentFacts(overrides: Partial<SealedDossierCurrentFactsV1> = {}): SealedDossierCurrentFactsV1 {
  const action = createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })
  return {
    action,
    classification: 'class-1',
    classificationCatalogFingerprint: catalogFingerprint,
    approvalRequestId: 'ask-1',
    callId: 'call-1',
    toolName: 'bash',
    requestEventSeq: 5,
    approvalAsked: { seq: 6, type: 'approval/asked', turn: 1, step: 0 },
    freeze: {
      parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000, cwd: '/workspace' },
      throughSeq: 6,
      currentTurn: 1,
      currentStep: 0,
      frozenAt: 1_007,
    },
    ...overrides,
  }
}

function packet(seals: readonly SealV1[], activities: readonly ActivityV1[], overrides: Partial<SealedParentSessionFactsV1> = {}): SealedParentSessionFactsV1 {
  return {
    version: 1,
    lifecycleFingerprint: lifecycle,
    seals,
    activities,
    catalogEpochs: [{ epoch: 0, headerEventSeq: 3, commitment: hash('c') }],
    ...overrides,
  }
}

function input(overrides: Partial<SealedDossierCompileInputV1> = {}): SealedDossierCompileInputV1 {
  return { packet: packet([], []), current: currentFacts(), ...overrides }
}

const compiler = (budget: number) => createSealedDossierCompiler({ maxHotPacketBytes: budget })

describe('createSealedDossierCompiler budget validation', () => {
  it('rejects non-positive, non-integer, and over-limit budgets at construction', () => {
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: 0 })).toThrow(TypeError)
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: -1 })).toThrow(TypeError)
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: 1.5 })).toThrow(TypeError)
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: 256_001 })).toThrow(TypeError)
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: Number.NaN })).toThrow(TypeError)
  })

  it('accepts a positive safe integer at the full-dossier limit', () => {
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: 1 })).not.toThrow()
    expect(() => createSealedDossierCompiler({ maxHotPacketBytes: 256_000 })).not.toThrow()
  })
})

describe('createSealedDossierCompiler happy path', () => {
  it('brands a sealed packet plus current action into a source-verified dossier', () => {
    const compile = compiler(256_000)
    const result = compile(input({ packet: packet([seal(0, 'completed')], [activity(0, 'class-1', 'ran pwd', 'completed')]) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const dossier = result.verified.dossier
    expect(dossier).toMatchObject({
      version: 1,
      kind: 'guardian-dossier',
      freeze: {
        parent: { sessionId: 'parent-1', sessionFormatVersion: 0, createdAt: 1_000, cwd: '/workspace' },
        throughSeq: 6,
        currentTurn: 1,
        currentStep: 0,
        frozenAt: 1_007,
      },
      environment: { version: 1, kind: 'native-header-only' },
      instructions: { messages: [] },
      completeness: { complete: true, sourceThroughSeq: 6, omissions: [] },
    })
    // asked-time freeze is burnt in; the same frozen input yields the same hash.
    expect(result.verified.dossierHash).toBe(recomputeDossierHash(dossier))
    expect(result.metrics.bytes).toBeGreaterThan(0)
    expect(result.metrics.sections.map(section => section.name)).toEqual([
      'environment', 'instructions', 'interaction', 'currentTurnTools', 'pendingApproval',
    ])
    expect(result.metrics.sections.every(section => section.bytes > 0 && section.characters > 0)).toBe(true)
  })

  it('carries the current action, classification, and approval binding into pendingApproval', () => {
    const compile = compiler(256_000)
    const current = currentFacts()
    const result = compile(input({ current, packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const pending = result.verified.dossier.pendingApproval as {
      readonly callId: string
      readonly toolName: string
      readonly approvalRequestId: string
      readonly action: unknown
      readonly actionHash: string
      readonly projectorId: string
      readonly classification: string
      readonly classificationCatalogFingerprint: string
      readonly approvalAsked: { readonly seq: number; readonly type: string; readonly turn: number; readonly step: number }
      readonly confinement: { readonly kind: 'unconfined-composition' }
    }
    expect(pending.callId).toBe('call-1')
    expect(pending.toolName).toBe('bash')
    expect(pending.approvalRequestId).toBe('ask-1')
    expect(pending.approvalAsked).toMatchObject({ seq: 6, type: 'approval/asked', turn: 1, step: 0 })
    expect(pending.actionHash).toBe(hashAction(current.action))
    expect(pending.action).toEqual(current.action)
    expect(pending.projectorId).toBe(current.action.projectorId)
    expect(pending.classification).toBe('class-1')
    expect(pending.classificationCatalogFingerprint).toBe(catalogFingerprint)
    expect(pending.confinement).toEqual({ kind: 'unconfined-composition' })
  })

  it('carries the sealed trajectory with a current seal and bounded ledger', () => {
    const compile = compiler(256_000)
    const theSeal = seal(0, 'completed')
    const theActivity = activity(0, 'class-1', 'ran pwd', 'completed')
    const result = compile(input({ packet: packet([theSeal], [theActivity]) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: {
      readonly current?: unknown
      readonly tail: readonly unknown[]
      readonly ledger: readonly unknown[]
      readonly catalogEpochs: readonly unknown[]
    } }
    expect(sealed.sealed.tail).toEqual([{ sourceSeq: 0, occurredAt: 1_000, classification: 'class-1', targetSummary: 'ran pwd', resultCategory: 'completed' }])
    expect(sealed.sealed.ledger).toEqual([{ sourceSeq: 0, occurredAt: 1_000, classification: 'class-1', targetSummary: 'ran pwd', resultCategory: 'completed' }])
    expect(sealed.sealed.catalogEpochs).toEqual([{ epoch: 0, headerEventSeq: 3, commitment: hash('c') }])
  })

  it('carries a current seal/activity when packet.current is present', () => {
    const compile = compiler(256_000)
    const theSeal = seal(9, 'completed', { approvalAsked: { eventSeq: 10, requestId: 'ask-1' } })
    const theActivity = activity(9, 'class-1', 'sealed current', 'completed')
    const result = compile(input({ packet: packet([], [], { current: { seal: theSeal, activity: theActivity } }) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: { readonly current: { readonly sourceSeq: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: string } } }
    expect(sealed.sealed.current).toEqual({ sourceSeq: 9, occurredAt: 1_009, classification: 'class-1', targetSummary: 'sealed current', resultCategory: 'completed' })
  })

  it('compiles a packet with no current seal (normal pending state)', () => {
    const compile = compiler(256_000)
    const result = compile(input({ packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: { readonly current?: unknown } }
    expect(sealed.sealed.current).toBeUndefined()
  })

  it('compiles empty seals, activities, and catalog epochs and passes epochs through', () => {
    const compile = compiler(256_000)
    const epochs = [{ epoch: 4, headerEventSeq: 20, commitment: hash('9') }]
    const result = compile(input({ packet: packet([], [], { catalogEpochs: epochs }) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: { readonly tail: readonly unknown[]; readonly ledger: readonly unknown[]; readonly catalogEpochs: readonly unknown[] } }
    expect(sealed.sealed.tail).toEqual([])
    expect(sealed.sealed.ledger).toEqual([])
    expect(sealed.sealed.catalogEpochs).toEqual(epochs)
  })
})

describe('createSealedDossierCompiler budget overflow', () => {
  it('fails closed as budget-overflow at the earliest overflowing section', () => {
    // A large tail makes the interaction section (assembled mid-way) overflow
    // while the later currentTurnTools/pendingApproval sections are never built.
    const bigSeals = Array.from({ length: 300 }, (_, i) => seal(i, 'completed'))
    const bigActivities = Array.from({ length: 300 }, (_, i) => activity(i, 'class-1', 'ran pwd', 'completed'))
    const compile = compiler(2_000)
    const result = compile(input({ packet: packet(bigSeals, bigActivities) }))
    expect(result.kind).toBe('incomplete')
    if (result.kind !== 'incomplete' || !('metrics' in result)) return
    expect(result.reason).toBe('budget-overflow')
    // Interaction overflowed, so only the sections built before it are reported;
    // currentTurnTools/pendingApproval were never assembled.
    expect(result.metrics.sections.map(section => section.name)).toEqual(['environment', 'instructions'])
    expect(result.metrics.bytes).toBeGreaterThan(0)
    expect(result.metrics.bytes).toBeLessThan(2_000)
  })

  it('short-circuits at the fixed frame for a degenerate tiny budget', () => {
    const compile = compiler(1)
    const result = compile(input({ packet: packet([], []) }))
    expect(result.kind).toBe('incomplete')
    if (result.kind !== 'incomplete' || !('metrics' in result)) return
    expect(result.reason).toBe('budget-overflow')
    // Nothing was even assembled into a content section.
    expect(result.metrics.sections).toEqual([])
  })

  it('reports non-sensitive candidate accounting on overflow', () => {
    const sealRows = Array.from({ length: 40 }, (_, i) => seal(i, 'completed'))
    const actRows = Array.from({ length: 40 }, (_, i) => activity(i, 'delegation:start', 'sent', 'completed'))
    const compile = compiler(500)
    const result = compile(input({ packet: packet(sealRows, actRows) }))
    expect(result.kind).toBe('incomplete')
    if (result.kind !== 'incomplete' || !('metrics' in result)) return
    expect(result.metrics).toMatchObject({
      dossierVersion: 1,
      delegationClassificationCatalogFingerprint: catalogFingerprint,
      eventCount: 40,
      attemptCount: 40,
      delegationEntryCount: 40,
      includedEventCount: 0,
      excludedEventCount: 0,
      totalBytes: 0,
    })
  })
})

describe('createSealedDossierCompiler leak guard', () => {
  it('never copies tool result content, historical call IDs, or LLM rationale into the dossier', () => {
    // Inject a historical call ID and a raw result body into the sealed row; these
    // are the fields the compiler must never project into the dossier.
    const dirtySeal = {
      ...seal(0, 'completed'),
      request: { ...seal(0, 'completed').request, callId: 'secret-call-X1' },
      canonical: JSON.stringify({ resultBody: 'SENSITIVE-TOOL-OUTPUT-12345' }),
    } as unknown as SealV1
    const dirtyActivity = {
      ...activity(0, 'class-1', 'innocent summary', 'completed'),
      resultBody: 'SENSITIVE-TOOL-OUTPUT-12345',
      llmRationale: 'SECRET-LLM-RATIONALE-98765',
    } as unknown as ActivityV1
    const compile = compiler(256_000)
    const result = compile(input({ packet: packet([dirtySeal], [dirtyActivity]) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const json = JSON.stringify(result.verified.dossier)
    expect(json).not.toContain('SENSITIVE-TOOL-OUTPUT-12345')
    expect(json).not.toContain('SECRET-LLM-RATIONALE-98765')
    expect(json).not.toContain('secret-call-X1')
    // The historical seal's canonical payload must not be forwarded either.
    expect(json).not.toContain('resultBody')
  })

  it('keeps the action arguments (request content) but not tool output', () => {
    const compile = compiler(256_000)
    const current = currentFacts()
    const result = compile(input({ current, packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const pending = result.verified.dossier.pendingApproval as { readonly action: { readonly arguments: { readonly command: string } } }
    expect(pending.action.arguments).toEqual({ command: 'pwd' })
  })
})

describe('createSealedDossierCompiler fail-closed input guards', () => {
  it('returns aborted for an aborted signal', () => {
    const controller = new AbortController()
    controller.abort()
    const compile = compiler(256_000)
    expect(compile(input({ signal: controller.signal }))).toEqual({ kind: 'incomplete', reason: 'aborted' })
  })

  it('rejects a non-v1 packet', () => {
    const compile = compiler(256_000)
    const bad = { ...packet([], []), version: 2 } as unknown as SealedParentSessionFactsV1
    expect(compile(input({ packet: bad }))).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
  })

  it('rejects a packet with non-array sealed collections', () => {
    const compile = compiler(256_000)
    const bad = { ...packet([], []), seals: 42 } as unknown as SealedParentSessionFactsV1
    expect(compile(input({ packet: bad }))).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
  })

  it('rejects malformed current facts (empty classification)', () => {
    const compile = compiler(256_000)
    const current = currentFacts({ classification: '' })
    expect(compile(input({ current }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
  })

  it('rejects malformed current facts (bad freeze identity)', () => {
    const compile = compiler(256_000)
    const current = currentFacts({ freeze: { parent: { sessionId: '', sessionFormatVersion: 0, createdAt: 1_000 }, throughSeq: 6, currentTurn: 1, currentStep: 0, frozenAt: 1_007 } })
    expect(compile(input({ current }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
  })

  it('rejects a malformed action snapshot', () => {
    const compile = compiler(256_000)
    const current = currentFacts({ action: { version: 1, kind: 'bogus', toolName: 'bash', arguments: { command: 'pwd' }, requestedPermissions: [], projectorId: 'p', semantics: { family: 'f', value: {} } } } as unknown as SealedDossierCurrentFactsV1)
    expect(compile(input({ current }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
  })

  it('rejects a malformed sealed row (non-numeric sourceSeq)', () => {
    const compile = compiler(256_000)
    const bad = { version: 1, lifecycleFingerprint: lifecycle, seals: [{ sourceSeq: 'x', result: { status: 'completed' } }], activities: [], catalogEpochs: [] } as unknown as SealedParentSessionFactsV1
    expect(compile(input({ packet: bad }))).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
  })

  it('rejects a malformed terminal outcome status', () => {
    const compile = compiler(256_000)
    const bad = { version: 1, lifecycleFingerprint: lifecycle, seals: [{ sourceSeq: 0, result: { status: 'mysterious' } }], activities: [], catalogEpochs: [] } as unknown as SealedParentSessionFactsV1
    expect(compile(input({ packet: bad }))).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
  })
})

describe('createSealedDossierCompiler rework guards (WP4-b3 review)', () => {
  it('rejects a catalog epoch carrying an unknown field instead of smuggling it (B1)', () => {
    const compile = compiler(256_000)
    const dirtyEpochs = [{ epoch: 0, headerEventSeq: 3, commitment: hash('c'), note: 'SMUGGLED-RESULT-BODY-XYZ' }] as unknown as readonly { epoch: number; headerEventSeq: number; commitment: string }[]
    const got = compile(input({ packet: packet([], [], { catalogEpochs: dirtyEpochs }) }))
    expect(got).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
    // Failed closed: nothing is branded, so the smuggled field never reaches a dossier.
    expect('verified' in got).toBe(false)
  })

  it('projects clean catalog epochs to the closed three-field shape (B1)', () => {
    const compile = compiler(256_000)
    const cleanEpochs = [{ epoch: 0, headerEventSeq: 3, commitment: hash('c') }]
    const result = compile(input({ packet: packet([], [], { catalogEpochs: cleanEpochs }) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: { readonly catalogEpochs: readonly unknown[] } }
    expect(sealed.sealed.catalogEpochs).toEqual([{ epoch: 0, headerEventSeq: 3, commitment: hash('c') }])
  })

  it('rejects a malformed activity row as controlled incomplete rather than throwing (B2)', () => {
    const compile = compiler(256_000)
    // Missing occurredAt must fail closed, not allow cloneJson to escape.
    const missingTime = { sourceSeq: 0, classification: 'class-1', targetSummary: 'ran', resultCategory: 'completed' } as unknown as ActivityV1
    const pktMissing = packet([seal(0, 'completed')], [missingTime])
    expect(() => compile(input({ packet: pktMissing }))).not.toThrow()
    expect(compile(input({ packet: pktMissing }))).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
    // Wrong classification type (object instead of string) must also fail closed.
    const wrongType = { sourceSeq: 0, occurredAt: 1_000, classification: { bad: 'x' }, targetSummary: 'ran', resultCategory: 'completed' } as unknown as ActivityV1
    const pktType = packet([], [wrongType])
    expect(() => compile(input({ packet: pktType }))).not.toThrow()
    expect(compile(input({ packet: pktType }))).toEqual({ kind: 'incomplete', reason: 'invalid-sealed-fact-snapshot' })
  })

  it('freezes the caller input so the branded dossier does not alias a mutable object (S1)', () => {
    const compile = compiler(256_000)
    const denials = [{ source: { event: { seq: 0, type: 'sandbox-denied' }, requestEventSeq: 1, callId: 'call-0' } }]
    const current = currentFacts({ earlierSandboxDenials: denials })
    const result = compile(input({ current, packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(Object.isFrozen(result.verified.dossier)).toBe(true)
    const before = JSON.stringify(result.verified.dossier)
    // Mutating the caller's earlier-sandbox-denials array after compile must not
    // affect the branded dossier: the entry freeze snapshots the input instead of
    // aliasing a mutable external reference.
    denials.push({ source: { event: { seq: 9, type: 'sandbox-denied' }, requestEventSeq: 10, callId: 'call-9' } })
    expect(JSON.stringify(result.verified.dossier)).toBe(before)
  })

  it('pins the inclusive budget boundary: exactly-at-budget passes, one-below overflows (S4)', () => {
    const pkt = packet([seal(0, 'completed'), seal(1, 'completed')], [activity(0, 'class-1', 'ran', 'completed'), activity(1, 'class-1', 'ran', 'completed')])
    const generous = compiler(256_000)(input({ packet: pkt }))
    expect(generous.kind).toBe('ready')
    const trueSize = generous.kind === 'ready' ? generous.metrics.bytes : -1
    expect(trueSize).toBeGreaterThan(0)
    // The accumulated pre-build budget sits just above the true dossier size; search
    // for it near the true size so the boundary is pinned without a huge sweep.
    let boundary = -1
    for (let b = trueSize; b < trueSize + 400; b++) {
      if (compiler(b)(input({ packet: pkt })).kind === 'ready') { boundary = b; break }
    }
    expect(boundary).toBeGreaterThan(trueSize)
    // charge uses > so exactly-at-budget passes.
    expect(compiler(boundary)(input({ packet: pkt })).kind).toBe('ready')
    // One byte below the accumulated total crosses the limit and fails closed.
    const below = compiler(boundary - 1)(input({ packet: pkt }))
    expect(below.kind).toBe('incomplete')
    if (below.kind === 'incomplete' && 'metrics' in below) expect(below.reason).toBe('budget-overflow')
    // The true dossier size stays inside the accumulated budget by a constant
    // conservative margin (the per-member fragment wrapping overhead). Pinning the
    // exact 7-byte margin freezes the inclusive GT boundary (charge passes when it
    // lands exactly at budget); switching charge to GTE would shift the first-ready
    // budget by one and break this assertion.
    expect(boundary - trueSize).toBe(7)
    const near = compiler(boundary)(input({ packet: pkt }))
    if (near.kind === 'ready') expect(near.metrics.bytes).toBeLessThan(boundary)
  })
})

describe('createSealedDossierCompiler excerpt channel (WP4-b4-2a)', () => {
  it('projects the bounded excerpt channel into interaction.sealed with seq and text', () => {
    const compile = compiler(256_000)
    const current = currentFacts({
      excerpts: [{ seq: 2, text: 'inspect the cwd' }, { seq: 4, text: 'then show the diff' }],
      excerptTruncated: 1,
    })
    const result = compile(input({ current, packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: {
      readonly excerpts: readonly { readonly seq: number; readonly text: string }[]
      readonly excerptTruncated: number
    } }
    expect(sealed.sealed.excerpts).toEqual([{ seq: 2, text: 'inspect the cwd' }, { seq: 4, text: 'then show the diff' }])
    expect(sealed.sealed.excerptTruncated).toBe(1)
  })

  it('keeps the no-excerpt behavior unchanged when current carries no excerpts', () => {
    const compile = compiler(256_000)
    const result = compile(input({ packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const sealed = result.verified.dossier.interaction as unknown as { readonly sealed: { readonly excerpts?: unknown; readonly excerptTruncated?: unknown } }
    expect(sealed.sealed.excerpts).toBeUndefined()
    expect(sealed.sealed.excerptTruncated).toBeUndefined()
  })

  it('freezes the caller excerpt payload so a later mutation never reaches the dossier (S1)', () => {
    const compile = compiler(256_000)
    const excerpts = [{ seq: 2, text: 'safe intent' }]
    const current = currentFacts({ excerpts })
    const result = compile(input({ current, packet: packet([], []) }))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const before = JSON.stringify(result.verified.dossier)
    excerpts.push({ seq: 9, text: 'mutated after compile' })
    expect(JSON.stringify(result.verified.dossier)).toBe(before)
  })

  it('rejects an excerpt entry carrying an unknown field (closed set, leak guard)', () => {
    const compile = compiler(256_000)
    const current = currentFacts({ excerpts: [{ seq: 2, text: 'safe', resultBody: 'SMUGGLED-TOOL-OUTPUT-9' }] as unknown as readonly { readonly seq: number; readonly text: string }[] })
    const got = compile(input({ current, packet: packet([], []) }))
    expect(got).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
    expect('verified' in got).toBe(false)
  })

  it('rejects malformed excerpt entries (non-integer seq, empty text, over-length text)', () => {
    const compile = createSealedDossierCompiler({ maxHotPacketBytes: 256_000, maxRecentExcerptBytes: 10 })
    const badSeq = currentFacts({ excerpts: [{ seq: 2.5, text: 'x' }] })
    const emptyText = currentFacts({ excerpts: [{ seq: 2, text: '' }] })
    const overLength = currentFacts({ excerpts: [{ seq: 2, text: 'this text is longer than ten bytes' }] })
    expect(compile(input({ current: badSeq, packet: packet([], []) }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
    expect(compile(input({ current: emptyText, packet: packet([], []) }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
    expect(compile(input({ current: overLength, packet: packet([], []) }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
  })

  it('rejects a malformed excerptTruncated count', () => {
    const compile = compiler(256_000)
    const current = currentFacts({ excerpts: [{ seq: 2, text: 'safe' }], excerptTruncated: -1 })
    expect(compile(input({ current, packet: packet([], []) }))).toEqual({ kind: 'incomplete', reason: 'invalid-current-action-facts' })
  })

  it('charges the excerpt channel against the hot-packet budget', () => {
    const compile = compiler(2_000)
    const bigExcerpts = Array.from({ length: 100 }, (_, index) => ({ seq: index, text: 'a'.repeat(20) }))
    const result = compile(input({ current: currentFacts({ excerpts: bigExcerpts }), packet: packet([], []) }))
    expect(result.kind).toBe('incomplete')
    if (result.kind !== 'incomplete' || !('metrics' in result)) return
    expect(result.reason).toBe('budget-overflow')
  })
})
