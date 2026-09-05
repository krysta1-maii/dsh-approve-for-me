import { describe, expect, it, vi } from 'vitest'
import {
  DefaultAuthorizationExtractionCoordinator,
  boundedSyncTailDeadline,
} from '../../src/application/authorization-extraction-coordinator.js'
import { DefaultExtractionChannel } from '../../src/application/extraction-channel.js'
import type { ExtractionChannel } from '../../src/application/extraction-channel.js'
import { ReviewProtocolError } from '../../src/application/decision-channel.js'
import type { ReviewClock } from '../../src/application/decision-channel.js'
import { SerialLanes } from '../../src/application/serial-lanes.js'
import { DshStorageDomainAuthorizationLedger } from '../../src/dsh/storage-domain-authorization-ledger.js'
import type { StorageDomainFacility } from '../../src/dsh/storage-domain-decision-record.js'
import {
  AUTHORIZATION_EXTRACTOR_VERSION,
  EXTRACTION_PROVIDER,
  createExtractorProviderData,
} from '../../src/domain/extraction-protocol.js'
import type { ExtractedAuthorizationCandidateV1 } from '../../src/domain/extraction-protocol.js'
import type { ReviewerProviderDataV1, ReviewerTextBlock } from '../../src/domain/protocol.js'
import type {
  ManagedOwnedReviewer,
  ManagedReviewerPort,
  ParentAuthority,
} from '../../src/ports/managed-reviewer.js'
import type { JsonValue } from '../../src/domain/json.js'

const LIFE = 'lifecycle-1'
const AUTHORITY: ParentAuthority<unknown, string> = { live: {}, sessionId: 'parent-1' }

const preset = createExtractorProviderData({
  generation: 'gen-1',
  extractorVersion: AUTHORIZATION_EXTRACTOR_VERSION,
  modelRoute: { providerId: 'test-provider', modelId: 'test-model' },
})

/** Fake clock driving both the extraction channel and the coordinator's now(). */
class FakeClock implements ReviewClock {
  value = 10_000
  private id = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now(): number { return this.value }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.id
    this.timers.set(id, { at: this.value + delayMs, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    this.value += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.value) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }
}

/** In-memory storage facility, mirroring the WP7-a storage test fake. */
function fakeFacility() {
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let t = tables.get(name)
    if (!t) { t = new Map(); tables.set(name, t) }
    return { get: (k: string) => t!.get(k), put: async (k: string, v: unknown) => { t!.set(k, v) } }
  }
  return { tables, facility: { open: async () => ({ table, close: async () => {} }) } as StorageDomainFacility }
}

interface FakeEvent { readonly seq: number; readonly type: string; readonly time: number; readonly data: unknown }

function userEvent(seq: number, time: number, text: string): FakeEvent {
  return { seq, type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function eventAtFrom(events: readonly FakeEvent[]) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return (seq: number) => bySeq.get(seq)
}

/** Default model behavior: grant the first window line, deny the second. */
const defaultModel = (window: ReadonlyArray<{ seq: number; text: string }>): ExtractedAuthorizationCandidateV1[] => {
  const entries: ExtractedAuthorizationCandidateV1[] = []
  if (window[0] !== undefined) {
    entries.push(Object.freeze({
      sourceSeq: window[0].seq,
      quote: window[0].text.slice(0, 12),
      effect: 'grant',
      coverage: 'action',
      summary: 'user grants the action',
    }))
  }
  if (window[1] !== undefined) {
    entries.push(Object.freeze({
      sourceSeq: window[1].seq,
      quote: window[1].text,
      effect: 'deny',
      coverage: 'session',
      summary: 'user denies standing',
    }))
  }
  return entries
}

interface FakeChild {
  id: string
  parentSessionId: string
  provider: string
  label: string
  providerData?: JsonValue
  activity: 'running' | 'inactive'
  deliveryAttempts: number
  retired: boolean
  contaminated: boolean
}

/**
 * In-memory managed port. deliver() parses the single delivered text block
 * and immediately submits a model-produced structured extraction to the real
 * channel, simulating the extractor child answering within the same turn.
 * deliverHook can inject failures (contamination, transport) or suppress the
 * answer to simulate a silent model.
 */
class FakePort implements ManagedReviewerPort<unknown, string> {
  readonly children: FakeChild[] = []
  createCount = 0
  rotateCount = 0
  renewCount = 0
  deliverCount = 0
  interruptCount = 0
  deliverHook: ((attempt: number, childId: string, parsed: {
    extractionId: string
    parentSessionId: string
    extractorSessionId: string
    generation: string
    extractorVersion: string
    throughSeq: number
    window: ReadonlyArray<{ seq: number; text: string }>
  }) => Error | 'silent' | undefined) | undefined

  constructor(
    private readonly channel: ExtractionChannel,
    private readonly model: (window: ReadonlyArray<{ seq: number; text: string }>) => readonly ExtractedAuthorizationCandidateV1[] = defaultModel,
  ) {}

  async create(
    authority: ParentAuthority<unknown, string>,
    options: { readonly label: string; readonly providerData: ReviewerProviderDataV1; readonly signal?: AbortSignal },
  ): Promise<string> {
    this.createCount += 1
    const id = 'extractor-' + this.createCount
    this.children.push({
      id,
      parentSessionId: authority.sessionId,
      provider: EXTRACTION_PROVIDER,
      label: options.label,
      providerData: options.providerData as unknown as JsonValue,
      activity: 'inactive',
      deliveryAttempts: 0,
      retired: false,
      contaminated: false,
    })
    return id
  }

  async list(parentSessionId: string): Promise<ManagedOwnedReviewer<string>[]> {
    return this.children
      .filter(child => child.parentSessionId === parentSessionId)
      .map(child => ({
        ...child,
        ...child.providerData === undefined ? {} : { providerData: child.providerData as JsonValue },
      }))
  }

  async rotate(authority: ParentAuthority<unknown, string>, childId: string): Promise<string> {
    this.rotateCount += 1
    const child = this.children.find(candidate => candidate.id === childId)
    if (child === undefined) throw new Error('unknown child ' + childId)
    child.contaminated = true
    return this.create(authority, { label: child.label, providerData: child.providerData as unknown as ReviewerProviderDataV1 })
  }

  async renew(authority: ParentAuthority<unknown, string>, childId: string): Promise<string> {
    this.renewCount += 1
    const child = this.children.find(candidate => candidate.id === childId)
    if (child === undefined) throw new Error('unknown child ' + childId)
    child.retired = true
    return this.create(authority, { label: child.label, providerData: child.providerData as unknown as ReviewerProviderDataV1 })
  }

  async deliver(
    authority: ParentAuthority<unknown, string>,
    childId: string,
    content: readonly ReviewerTextBlock[],
  ): Promise<unknown> {
    this.deliverCount += 1
    const parsed = JSON.parse(content[0]!.text) as Parameters<NonNullable<FakePort['deliverHook']>>[2]
    const hook = this.deliverHook?.(this.deliverCount, childId, parsed)
    if (hook instanceof Error) throw hook
    if (hook === 'silent') return undefined
    const result = this.channel.submit({
      protocolVersion: 1,
      extractionId: parsed.extractionId,
      parentSessionId: parsed.parentSessionId,
      extractorSessionId: parsed.extractorSessionId,
      generation: parsed.generation,
      extractorVersion: parsed.extractorVersion,
      throughSeq: parsed.throughSeq,
      entries: [...this.model(parsed.window)],
    }, { actualExtractorSessionId: childId })
    if (result.status !== 'accepted') {
      throw new ReviewProtocolError('invalid-result', 'unexpected submit disposition ' + result.status)
    }
    return undefined
  }

  interrupt(): void {
    this.interruptCount += 1
  }
}

function makeHarness(options: {
  events: readonly FakeEvent[]
  model?: (window: ReadonlyArray<{ seq: number; text: string }>) => readonly ExtractedAuthorizationCandidateV1[]
  ledger?: DshStorageDomainAuthorizationLedger
} = { events: [] }) {
  const clock = new FakeClock()
  const channel = new DefaultExtractionChannel(clock)
  const port = new FakePort(channel, options.model)
  const ledger = options.ledger ?? new DshStorageDomainAuthorizationLedger(fakeFacility().facility)
  const lane = new SerialLanes()
  const coordinator = new DefaultAuthorizationExtractionCoordinator<unknown, string>({
    port,
    channel,
    ledger,
    preset,
    lane,
    timeoutMs: 60_000,
    now: () => clock.now(),
  })
  return { clock, channel, port, ledger, lane, coordinator }
}

const deadlineOf = (clock: FakeClock): number => clock.value + 30_000

describe('DefaultAuthorizationExtractionCoordinator', () => {
  it('extracts a grant and a deny, writes the batch, and advances the checkpoint', async () => {
    const events = [
      userEvent(1, 1000, 'please deploy the app for me'),
      { seq: 2, type: 'tools/result', time: 1001, data: {} },
      userEvent(3, 1002, 'never modify production data'),
    ]
    const { clock, port, ledger, coordinator } = makeHarness({ events })
    const eventAt = eventAtFrom(events)
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt,
      throughSeq: 3,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('created')
    expect(port.createCount).toBe(1)
    expect(port.deliverCount).toBe(1)
    const entries = await ledger.read(LIFE)
    expect(entries!.map(entry => [entry.sourceSeq, entry.effect, entry.coverage])).toEqual([
      [1, 'grant', 'action'],
      [3, 'deny', 'session'],
    ])
    expect(entries![0]!.occurredAt).toBe(1000)
    expect(entries![1]!.occurredAt).toBe(1002)
    expect(entries![0]!.quote).toBe('please deplo')
    expect(entries![1]!.quote).toBe('never modify production data')
    const tip = await ledger.readCheckpoint(LIFE)
    expect(tip).not.toBeNull()
    expect(tip!.throughSeq).toBe(3)
    expect(tip!.producedEntryHashes).toEqual(entries!.map(entry => entry.entryHash))
    // The drawer chain is hash-linked from genesis.
    const { genesisAuthorizationHash } = await import('../../src/domain/authorization-ledger.js')
    expect(entries![0]!.previousEntryHash).toBe(genesisAuthorizationHash(LIFE))
    expect(entries![1]!.previousEntryHash).toBe(entries![0]!.entryHash)
  })

  it('skips an already-consumed range without delivering again', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, coordinator } = makeHarness({ events })
    const eventAt = eventAtFrom(events)
    const input = {
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt,
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    }
    await expect(coordinator.extract(input)).resolves.toBe('created')
    expect(port.deliverCount).toBe(1)
    await expect(coordinator.extract(input)).resolves.toBe('skipped')
    expect(port.deliverCount).toBe(1)
    expect(port.createCount).toBe(1)
  })

  it('advances the checkpoint deterministically on an empty window without waking the model', async () => {
    const events = [{ seq: 1, type: 'tools/result', time: 1000, data: {} }]
    const { clock, port, ledger, coordinator } = makeHarness({ events })
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('created')
    expect(port.deliverCount).toBe(0)
    expect(port.createCount).toBe(0)
    expect(await ledger.read(LIFE)).toEqual([])
    const tip = await ledger.readCheckpoint(LIFE)
    expect(tip).not.toBeNull()
    expect(tip!.throughSeq).toBe(1)
    expect(tip!.producedEntryHashes).toEqual([])
  })

  it('rotates once after a contaminated delivery and still extracts', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, ledger, coordinator } = makeHarness({ events })
    port.deliverHook = attempt => attempt === 1
      ? new Error('child contaminated: unauthorized transcript received')
      : undefined
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('created')
    expect(port.deliverCount).toBe(2)
    expect(port.rotateCount).toBe(1)
    expect(port.children[0]!.contaminated).toBe(true)
    expect((await ledger.read(LIFE))!).toHaveLength(1)
  })

  it('reuses the exact same absolute deadline across a contamination rotate', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, channel, port, coordinator } = makeHarness({ events })
    const armed: number[] = []
    const originalArm = channel.arm.bind(channel)
    vi.spyOn(channel, 'arm').mockImplementation((args) => {
      armed.push(args.deadlineAt)
      return originalArm(args)
    })
    port.deliverHook = attempt => {
      if (attempt === 1) clock.value += 5_000 // time passes before the rotate re-arms
      return attempt === 1
        ? new Error('child contaminated: unauthorized transcript received')
        : undefined
    }
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('created')
    expect(port.rotateCount).toBe(1)
    expect(armed).toHaveLength(2)
    // The rotate must never buy extra time: both arms carry the first deadline.
    expect(armed[1]).toBe(armed[0])
  })

  it('fails when the rotated child is contaminated again, writing nothing', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, ledger, coordinator } = makeHarness({ events })
    port.deliverHook = () => new Error('child contaminated: unauthorized transcript received')
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('failed')
    expect(port.deliverCount).toBe(2)
    expect(port.rotateCount).toBe(1)
    expect(await ledger.read(LIFE)).toEqual([])
    expect(await ledger.readCheckpoint(LIFE)).toBeNull()
  })

  it('fails on an ordinary delivery failure without rotating or writing', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, ledger, coordinator } = makeHarness({ events })
    port.deliverHook = () => new Error('transport unavailable')
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('failed')
    expect(port.deliverCount).toBe(1)
    expect(port.rotateCount).toBe(0)
    expect(await ledger.read(LIFE)).toEqual([])
    expect(await ledger.readCheckpoint(LIFE)).toBeNull()
  })

  it('rejects a non-verbatim quote as invalid and writes nothing', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, ledger, coordinator } = makeHarness({
      events,
      model: window => [{ sourceSeq: window[0]!.seq, quote: 'paraphrased permission', effect: 'grant', coverage: 'action', summary: 'x' }],
    })
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('invalid')
    expect(port.deliverCount).toBe(1)
    expect(await ledger.read(LIFE)).toEqual([])
    expect(await ledger.readCheckpoint(LIFE)).toBeNull()
  })

  it('rejects a candidate citing a seq outside the delivered window as invalid', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, ledger, coordinator } = makeHarness({
      events,
      model: () => [{ sourceSeq: 999, quote: 'please deploy', effect: 'grant', coverage: 'action', summary: 'x' }],
    })
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('invalid')
    expect(await ledger.read(LIFE)).toEqual([])
    expect(await ledger.readCheckpoint(LIFE)).toBeNull()
  })

  it('fails when the deadline passes before the extractor answers', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, ledger, coordinator } = makeHarness({ events })
    port.deliverHook = () => 'silent'
    const promise = coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: clock.value + 50,
    })
    // Let the lane task arm the channel and deliver (the model stays silent),
    // then run the shared absolute deadline past the fake clock.
    await new Promise(resolve => setTimeout(resolve, 0))
    clock.advance(100)
    await expect(promise).resolves.toBe('failed')
    expect(await ledger.read(LIFE)).toEqual([])
    expect(await ledger.readCheckpoint(LIFE)).toBeNull()
  })

  it('fails when the caller aborts before an answer arrives', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const { clock, port, coordinator } = makeHarness({ events })
    port.deliverHook = () => 'silent'
    const controller = new AbortController()
    const promise = coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
      signal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(promise).resolves.toBe('failed')
    expect(port.deliverCount).toBe(1)
  })

  it('reports unavailable when the drawer storage is unavailable', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const unavailable = new DshStorageDomainAuthorizationLedger(undefined, () => {})
    const { clock, port, coordinator } = makeHarness({ events, ledger: unavailable })
    const status = await coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: deadlineOf(clock),
    })
    expect(status).toBe('unavailable')
    expect(port.deliverCount).toBe(0)
    expect(port.createCount).toBe(0)
  })

  it('bounds the sync tail to a quarter slice of the remaining run budget', async () => {
    expect(boundedSyncTailDeadline(0, 4000)).toBe(1000)
    expect(boundedSyncTailDeadline(1000, 5000)).toBe(2000)
    // A nearly-expired run still gets a minimal slice (floor 1ms), never an extension.
    expect(boundedSyncTailDeadline(0, 3)).toBe(1)
    // No remaining budget or invalid inputs skip the tail entirely.
    expect(boundedSyncTailDeadline(0, 1)).toBeUndefined()
    expect(boundedSyncTailDeadline(0, 0)).toBeUndefined()
    expect(boundedSyncTailDeadline(100, 50)).toBeUndefined()
    expect(boundedSyncTailDeadline(-1, 4000)).toBeUndefined()
    expect(boundedSyncTailDeadline(0, 1.5)).toBeUndefined()
  })

  it('never extends the caller deadline beyond the coordinator budget', async () => {
    const events = [userEvent(1, 1000, 'please deploy the app for me')]
    const short = makeHarness({ events })
    // Capture the armed request: the deadline cap is asserted on the wire, not
    // on a fake clock that never advances. A Math.min→Math.max mutation arms
    // the 10-minute caller deadline here and turns this test red.
    const armSpy = vi.spyOn(short.channel, 'arm')
    // timeoutMs is 60s; asking for a 10-minute outer deadline must be capped.
    const status = await short.coordinator.extract({
      authority: AUTHORITY,
      lifecycleFingerprint: LIFE,
      eventAt: eventAtFrom(events),
      throughSeq: 1,
      deadlineAt: short.clock.value + 600_000,
    })
    expect(status).toBe('created')
    // The armed request carries the capped deadline, not the 10-minute one.
    expect(armSpy).toHaveBeenCalledOnce()
    expect(armSpy.mock.calls[0]![0].deadlineAt).toBe(10_000 + 60_000)
    const tip = await short.ledger.readCheckpoint(LIFE)
    expect(tip).not.toBeNull()
    armSpy.mockRestore()
  })
})
