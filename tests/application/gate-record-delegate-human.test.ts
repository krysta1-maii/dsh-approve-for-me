import { describe, expect, it, vi } from 'vitest'
import {
  DefaultGatePipeline,
  DshStorageDomainGateDecisionRecordStore,
  GateFailure,
  InMemoryGateDecisionRecordStore,
  InMemorySealedDispositionRegistry,
  canonicalJson,
  createActionSnapshot,
  parseGateDecisionRecord,
} from '../../src/index.js'
import type {
  GateActionFacts,
  GateDecisionRecord,
  GateDecisionRecordResult,
  GateMachineRequestV1,
  GatePipelineDependencies,
  GatePreReview,
  SealedDispositionV1,
  StorageDomainFacility,
} from '../../src/index.js'

/**
 * WP10-d reproduction/pin-down: a guardian human_review outcome (delegate-human),
 * the sealed-replay human/deny best-effort branches, and the post-facts-failure
 * rows must produce durable, parseable DshStorageDomain decision records — not
 * only InMemory ones. Live evidence (2026-09-06) showed a full guardian human
 * chain landing zero records in afm_decision_records while the silently-swallowed
 * best-effort write hid the failure point.
 */

const hash = (char: string) => `sha256:${char.repeat(64)}`

const action = () => createActionSnapshot({ toolName: 'bash', arguments: { command: 'pwd' } })

function request(mode: 'auto' | 'auto-then-user' = 'auto'): GateMachineRequestV1 {
  return {
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    callId: 'call-1',
    toolName: 'bash',
    actionHash: hash('a'),
    deadlineAt: Number.MAX_SAFE_INTEGER,
    mode,
  }
}

function facts(overrides: Partial<GateActionFacts> = {}): GateActionFacts {
  return {
    action: action(),
    toolSchemaFingerprint: hash('bash'),
    classification: { kind: 'classified', classification: 'body-escalation' },
    breakerKey: { parentLifecycleFingerprint: 'life-1', turn: 1, actionHash: hash('a') },
    allowCacheKey: {
      parentLifecycleFingerprint: 'life-1',
      turn: 1,
      directUserFrontierSeq: 2,
      actionHash: hash('a'),
      configurationFingerprint: hash('c'),
      generation: 'generation-1',
    },
    rootRequester: true,
    directChildOrigin: false,
    generation: 'generation-1',
    configurationFingerprint: hash('c'),
    policyVersion: 'policy-v2',
    ...overrides,
  }
}

function sealed(disposition: SealedDispositionV1['disposition']): SealedDispositionV1 {
  return {
    version: 1,
    reviewRunId: 'run-1',
    requestId: 'ask-1',
    parentSessionId: 'parent-1',
    callId: 'call-1',
    actionHash: hash('a'),
    generation: 'generation-1',
    configurationFingerprint: hash('c'),
    disposition,
    reviewAttempts: 1,
    contaminatedRotationAttempts: 0,
    contaminatedRotations: 0,
    issuedAt: 100,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    replayable: true,
  }
}

/** In-memory storage-domain double: one shared row map per table name. */
function facility() {
  const tables = new Map<string, Map<string, unknown>>()
  const put = vi.fn(async (table: string, key: string, value: unknown) => {
    let rows = tables.get(table)
    if (rows === undefined) tables.set(table, rows = new Map())
    rows.set(key, value)
  })
  const close = vi.fn(async () => {})
  const open = vi.fn(async (spec: unknown) => {
    void spec
    return {
      table: (name: string) => {
        let rows = tables.get(name)
        if (rows === undefined) tables.set(name, rows = new Map())
        return {
          get: (key: string) => rows.get(key),
          put: (key: string, value: unknown) => put(name, key, value),
          delete: async (key: string) => { rows.delete(key) },
        }
      },
      close,
    }
  })
  return { facility: { open } as StorageDomainFacility, tables, put, close, open }
}

function storedRecords(tables: Map<string, Map<string, unknown>>): unknown[] {
  return [...(tables.get('records')?.values() ?? [])]
}

/** A durable row only counts when it survives the closed record round-trip. */
function expectParseableStoredRecord(rows: unknown[], expected: {
  route: GateDecisionRecord['route']
  normalizedDecision: GateDecisionRecord['normalizedDecision']
  pluginDisposition: GateDecisionRecord['pluginDisposition']
  disposition: GateDecisionRecord['disposition']
}): GateDecisionRecord {
  expect(rows).toHaveLength(1)
  const row = rows[0] as { version: number; canonical: string; record: unknown }
  expect(row.version).toBe(1)
  const record = parseGateDecisionRecord(row.record)
  expect(canonicalJson(record)).toBe(row.canonical)
  expect(record).toMatchObject(expected)
  return record
}

/** Wrap a real store and capture every record it accepted, for shape assertions. */
function capturing(store: GatePipelineDependencies['records']) {
  const accepted: GateDecisionRecord[] = []
  return {
    accepted,
    store: {
      createConfirmed: async (record: GateDecisionRecord): Promise<GateDecisionRecordResult> => {
        const result = await store.createConfirmed(record)
        if (result === 'confirmed') accepted.push(parseGateDecisionRecord(record))
        return result
      },
      recordBestEffort: async (record: GateDecisionRecord) => {
        await store.recordBestEffort(record)
        accepted.push(parseGateDecisionRecord(record))
      },
      readReasonCode: (requestId: string) => store.readReasonCode(requestId),
    },
  }
}

function makePipeline(overrides: {
  mode?: 'auto' | 'auto-then-user'
  records: GatePipelineDependencies['records']
  factsResult?: GateActionFacts
  preReview?: GatePreReview
  seals?: GatePipelineDependencies['seals']
}): DefaultGatePipeline {
  const deps: GatePipelineDependencies = {
    trustEnvelope: { evaluate: () => ({ kind: 'outside', reason: 'tool-family-not-covered' }) },
    breaker: { lookup: () => false, recordGuardianDeny: vi.fn(), clearParent: vi.fn() },
    allowCache: { lookup: () => false, recordGuardianAllow: vi.fn(), clearParent: vi.fn() },
    seals: overrides.seals ?? new InMemorySealedDispositionRegistry(),
    facts: { resolve: async () => overrides.factsResult ?? facts() },
    preReview: overrides.preReview ?? { preReview: async () => sealed('allow') },
    records: overrides.records,
    mode: overrides.mode ?? 'auto',
  }
  return new DefaultGatePipeline(deps)
}

describe('WP10-d: guardian delegate-human decision record lands durably', () => {
  it('records a guardian human_review outcome in the InMemory store with the closed shape', async () => {
    const memory = new InMemoryGateDecisionRecordStore()
    const capture = capturing(memory)
    const pipeline = makePipeline({
      mode: 'auto-then-user',
      records: capture.store,
      preReview: { preReview: async () => sealed('human') },
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    expect(capture.accepted).toHaveLength(1)
    expect(capture.accepted[0]).toMatchObject({
      version: 2,
      route: 'guardian',
      normalizedDecision: 'human_review',
      pluginDisposition: 'delegate-human',
      disposition: 'human',
      reviewRunId: 'run-1',
      requestId: 'ask-1',
      parentSessionId: 'parent-1',
      callId: 'call-1',
      actionHash: hash('a'),
      reviewAttempts: 1,
      contaminatedRotationAttempts: 0,
      contaminatedRotations: 0,
    })
  })

  it('persists the same guardian human_review record through the DshStorageDomain store', async () => {
    const fake = facility()
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const pipeline = makePipeline({
      mode: 'auto-then-user',
      records,
      preReview: { preReview: async () => sealed('human') },
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    await records.drain()
    expectParseableStoredRecord(storedRecords(fake.tables), {
      route: 'guardian',
      normalizedDecision: 'human_review',
      pluginDisposition: 'delegate-human',
      disposition: 'human',
    })
  })

  it('confirms (never conflicts) on a repeated identical delegate-human best-effort write', async () => {
    const fake = facility()
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const pipeline = makePipeline({
      mode: 'auto-then-user',
      records,
      preReview: { preReview: async () => sealed('human') },
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    // A second identical write for the same ask identity is a same-decision
    // confirmation, not a conflict, so recordBestEffort must not throw.
    await expect(records.recordBestEffort(parseGateDecisionRecord(
      (storedRecords(fake.tables)[0] as { record: unknown }).record,
    ))).resolves.toBeUndefined()
    await records.drain()
    expect(fake.put).toHaveBeenCalledOnce()
  })

  it('persists a guardian deny best-effort record through the DshStorageDomain store', async () => {
    const fake = facility()
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const pipeline = makePipeline({
      records,
      preReview: { preReview: async () => sealed('deny') },
    })
    await expect(pipeline.decide(request())).resolves.toBe('rejected')
    await records.drain()
    expectParseableStoredRecord(storedRecords(fake.tables), {
      route: 'guardian',
      normalizedDecision: 'deny',
      pluginDisposition: 'deny',
      disposition: 'deny',
    })
  })

  it('still returns the safe outcome when the durable best-effort write conflicts', async () => {
    const fake = facility()
    const seeded = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    await seeded.createConfirmed({
      version: 2, reviewRunId: 'run-0', route: 'guardian', normalizedDecision: 'deny', pluginDisposition: 'deny',
      requestId: 'ask-1', parentSessionId: 'parent-1', parentLifecycleFingerprint: 'life-1', callId: 'call-1',
      actionHash: hash('a'), generation: 'generation-1', policyVersion: 'policy-v2',
      configurationFingerprint: hash('c'), disposition: 'deny', reviewAttempts: 1,
      contaminatedRotationAttempts: 0, contaminatedRotations: 0,
    })
    await seeded.drain()
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const pipeline = makePipeline({
      mode: 'auto-then-user',
      records,
      preReview: { preReview: async () => sealed('human') },
    })
    // The conflicting audit write throws inside recordBestEffort, is swallowed by
    // the gate, and must not change the human outcome.
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    await records.drain()
    expect(storedRecords(fake.tables)).toHaveLength(1)
  })
})

describe('WP10-d: sealed-replay human/deny best-effort records land durably', () => {
  it.each([
    ['human', 'auto-then-user', 'delegate', 'human_review', 'delegate-human', 'human'],
    ['deny', 'auto', 'rejected', 'deny', 'deny', 'deny'],
  ] as const)('persists a sealed-replay %s best-effort record', async (
    disposition, mode, outcome, normalizedDecision, pluginDisposition, recordDisposition,
  ) => {
    const fake = facility()
    const seals = new InMemorySealedDispositionRegistry()
    seals.seal(sealed(disposition))
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const preReview = { preReview: vi.fn(async () => sealed('allow')) }
    const pipeline = makePipeline({ mode, records, seals, preReview })
    await expect(pipeline.decide(request(mode))).resolves.toBe(outcome)
    expect(preReview.preReview).not.toHaveBeenCalled()
    await records.drain()
    const record = expectParseableStoredRecord(storedRecords(fake.tables), {
      route: 'sealed-replay',
      normalizedDecision,
      pluginDisposition,
      disposition: recordDisposition,
    })
    expect(record.reviewRunId).toBe('run-1')
    expect(record.reviewAttempts).toBe(1)
  })
})

describe('WP10-d: post-facts-failure rows and the reason-code index land durably', () => {
  it('persists a post-facts no-decision row (direct-child requester failure)', async () => {
    const fake = facility()
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const pipeline = makePipeline({
      mode: 'auto-then-user',
      records,
      factsResult: facts({ directChildOrigin: true }),
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('unavailable')
    await records.drain()
    expectParseableStoredRecord(storedRecords(fake.tables), {
      route: 'post-facts-failure',
      normalizedDecision: 'no-decision',
      pluginDisposition: 'unavailable',
      disposition: 'no-decision',
    })
  })

  it('records a delegate-able GateFailure correlation row and its metadata-only reason code', async () => {
    const fake = facility()
    const records = new DshStorageDomainGateDecisionRecordStore(fake.facility)
    const correlation = {
      parentSessionId: 'parent-1', parentLifecycleFingerprint: 'life-1', requestId: 'ask-1', callId: 'call-1',
      actionHash: hash('a'), generation: 'generation-1', policyVersion: 'policy-v2', configurationFingerprint: hash('c'),
    }
    const pipeline = new DefaultGatePipeline({
      trustEnvelope: { evaluate: () => ({ kind: 'outside', reason: 'tool-family-not-covered' }) },
      breaker: { lookup: () => false, recordGuardianDeny: vi.fn(), clearParent: vi.fn() },
      allowCache: { lookup: () => false, recordGuardianAllow: vi.fn(), clearParent: vi.fn() },
      seals: new InMemorySealedDispositionRegistry(),
      facts: { resolve: async () => { throw new GateFailure('retryable-capability', 'reviewer temporarily unavailable', { correlation }) } },
      preReview: { preReview: async () => sealed('allow') },
      records,
      mode: 'auto-then-user',
    })
    await expect(pipeline.decide(request('auto-then-user'))).resolves.toBe('delegate')
    await records.drain()
    const record = expectParseableStoredRecord(storedRecords(fake.tables), {
      route: 'post-facts-failure',
      normalizedDecision: 'no-decision',
      pluginDisposition: 'delegate',
      disposition: 'no-decision',
    })
    expect(record.failureStage).toBe('verified-dossier')
    expect(record.failureCode).toBe('retryable-capability')
    // WP5-c metadata-only index is in sync and readable by request id.
    await expect(records.readReasonCode('ask-1')).resolves.toBe('retryable-capability')
    const indexRows = [...(fake.tables.get('reasonCode')?.values() ?? [])]
    expect(indexRows).toHaveLength(1)
    expect(Object.keys(indexRows[0] as object).sort()).toEqual(['failureCode', 'version'])
  })
})

describe('WP10-d: silent durable-write failures become observable under the debug flag', () => {
  const delegateHumanRecord = (): GateDecisionRecord => ({
    version: 2, reviewRunId: 'run-1', route: 'guardian', normalizedDecision: 'human_review', pluginDisposition: 'delegate-human',
    requestId: 'ask-1', parentSessionId: 'parent-1', parentLifecycleFingerprint: 'life-1', callId: 'call-1',
    actionHash: hash('a'), generation: 'generation-1', policyVersion: 'policy-v2',
    configurationFingerprint: hash('c'), disposition: 'human', reviewAttempts: 1,
    contaminatedRotationAttempts: 0, contaminatedRotations: 0,
  })

  it('logs a bounded metadata line when the domain cannot open, only under DSH_APPROVE_FOR_ME_DEBUG=1', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.stubEnv('DSH_APPROVE_FOR_ME_DEBUG', '1')
      // The backend error message is truncated to a 200-char bound: the
      // recognizable prefix survives in the log line, the tail does not.
      const longTail = 'x'.repeat(400)
      const store = new DshStorageDomainGateDecisionRecordStore({ open: async () => { throw new Error(`offline ${longTail}`) } })
      await store.recordBestEffort(delegateHumanRecord())
      await store.drain()
      expect(spy).toHaveBeenCalled()
      const lines = spy.mock.calls.map(c => c.join(' '))
      // The constructor-time open failure has no record context yet...
      const openLine = lines.find(l => l.includes('domain-open-failed'))
      expect(openLine).toBeDefined()
      expect(openLine).toContain('offline ')
      expect(openLine).not.toContain(longTail)
      // ...the write it forces surfaces with bounded record metadata.
      const line = lines.find(l => l.includes('domain-unavailable'))
      expect(line).toBeDefined()
      expect(line).toContain('delegate-human')
      // Metadata-only boundary: no hash identity leaks into the log line.
      expect(line).not.toContain(hash('a'))

      vi.stubEnv('DSH_APPROVE_FOR_ME_DEBUG', '')
      const quiet = new DshStorageDomainGateDecisionRecordStore({ open: async () => { throw new Error('offline') } })
      spy.mockClear()
      await quiet.recordBestEffort(delegateHumanRecord())
      await quiet.drain()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      spy.mockRestore()
    }
  })

  it('logs record-invalid when a malformed row reaches the write boundary', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.stubEnv('DSH_APPROVE_FOR_ME_DEBUG', '1')
      const fake = facility()
      const store = new DshStorageDomainGateDecisionRecordStore(fake.facility)
      await store.recordBestEffort({ ...delegateHumanRecord(), actionHash: 'not-a-digest' } as unknown as GateDecisionRecord)
      await store.drain()
      const line = spy.mock.calls.map(c => c.join(' ')).find(l => l.includes('record-invalid'))
      expect(line).toBeDefined()
      expect(fake.put).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      spy.mockRestore()
    }
  })

  it('logs the reason-code index failure without changing the confirmed record outcome', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.stubEnv('DSH_APPROVE_FOR_ME_DEBUG', '1')
      const tables = new Map<string, Map<string, unknown>>()
      const recordsRows = new Map<string, unknown>()
      tables.set('records', recordsRows)
      const failingIndex = {
        get: () => undefined,
        put: async () => { throw new Error('index full') },
        delete: async () => {},
      }
      const store = new DshStorageDomainGateDecisionRecordStore({
        open: async () => ({
          table: (name: string) => name === 'reasonCode'
            ? failingIndex
            : { get: (k: string) => recordsRows.get(k), put: async (k: string, v: unknown) => { recordsRows.set(k, v) }, delete: async () => {} },
          close: async () => {},
        }),
      })
      const failureRow: GateDecisionRecord = {
        version: 2, route: 'post-facts-failure', normalizedDecision: 'no-decision', pluginDisposition: 'delegate',
        requestId: 'ask-fail', parentSessionId: 'parent-1', parentLifecycleFingerprint: 'life-1', callId: 'call-1',
        actionHash: hash('a'), generation: 'generation-1', policyVersion: 'policy-v2',
        configurationFingerprint: hash('c'), disposition: 'no-decision', reviewAttempts: 0,
        contaminatedRotationAttempts: 0, contaminatedRotations: 0, failureStage: 'verified-dossier', failureCode: 'retryable-capability',
      }
      await expect(store.recordBestEffort(failureRow)).resolves.toBeUndefined()
      await store.drain()
      // The durable record itself still landed; only the index write failed.
      expect(storedRecords(tables)).toHaveLength(1)
      await expect(store.readReasonCode('ask-fail')).resolves.toBeUndefined()
      const line = spy.mock.calls.map(c => c.join(' ')).find(l => l.includes('reason-code-index'))
      expect(line).toBeDefined()
    } finally {
      vi.unstubAllEnvs()
      spy.mockRestore()
    }
  })
})
