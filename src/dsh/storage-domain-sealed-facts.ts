import { canonicalJson } from '../domain/json.js'
import { chainTipHash, genesisSealHash, parseActivityV1, parseSealV1, sealedFactKey } from '../domain/sealed-facts.js'
import type { ActivityV1, SealV1 } from '../domain/sealed-facts.js'
import type { StorageDomainFacility, StorageDomainHandle } from './storage-domain-decision-record.js'

export type SealedFactWriteResult = 'created' | 'identical' | 'conflict' | 'unavailable'
interface TipV1 { readonly version: 1; readonly lifecycleFingerprint: string; readonly keys: readonly string[]; readonly tipHash: string; readonly canonical: string }
const spec = Object.freeze({ name: 'afm_approval_ledger', version: 1, layout: 'per-record', tables: Object.freeze({ seals: Object.freeze({ valueSchema: Object.freeze({ parse: parseSealV1 }) }), chain_tips: Object.freeze({ valueSchema: Object.freeze({ parse: parseTip }) }), activity: Object.freeze({ valueSchema: Object.freeze({ parse: parseActivityV1 }) }) }) })
function sealKey(l: string, seq: number) { return sealedFactKey(l) + '_s_' + seq }
function activityKey(l: string, seq: number) { return sealedFactKey(l) + '_a_' + seq }
function parseTip(value: unknown): TipV1 { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('tip'); const o = value as Record<string, unknown>; const expected = ['version', 'lifecycleFingerprint', 'keys', 'tipHash', 'canonical']; if (Object.keys(o).length !== expected.length || expected.some(k => !Object.hasOwn(o, k)) || o.version !== 1 || typeof o.lifecycleFingerprint !== 'string' || !Array.isArray(o.keys) || o.keys.some(k => typeof k !== 'string') || new Set(o.keys).size !== o.keys.length || typeof o.tipHash !== 'string' || typeof o.canonical !== 'string') throw new TypeError('tip'); const p = { version: 1 as const, lifecycleFingerprint: o.lifecycleFingerprint, keys: Object.freeze([...o.keys] as string[]), tipHash: o.tipHash }; if (o.canonical !== canonicalJson(p)) throw new TypeError('tip'); return Object.freeze({ ...p, canonical: o.canonical }) }
function makeTip(lifecycleFingerprint: string, keys: readonly string[], sealHash: string): TipV1 { const p = { version: 1 as const, lifecycleFingerprint, keys: Object.freeze([...keys]), tipHash: chainTipHash(lifecycleFingerprint, sealHash) }; return Object.freeze({ ...p, canonical: canonicalJson(p) }) }
/** Private append-only ledger. Disk integrity is an index, never authorization. */
export class DshStorageDomainSealedFacts {
 private readonly tails = new Map<string, Promise<void>>(); private admissionOpen = true
 private readonly ready: Promise<StorageDomainHandle | undefined>
 constructor(facility: StorageDomainFacility | undefined) { this.ready = facility === undefined ? Promise.resolve(undefined) : facility.open(spec).catch(() => undefined) }
 async append(seal: SealV1, activity: ActivityV1): Promise<SealedFactWriteResult> {
  try { seal = parseSealV1(seal); activity = parseActivityV1(activity) } catch { return 'conflict' }
  if (seal.lifecycleFingerprint !== activity.lifecycleFingerprint || seal.sourceSeq !== activity.sourceSeq || seal.sealHash !== activity.sourceSealHash) return 'conflict'
  return this.serial(seal.lifecycleFingerprint, async () => {
   if (!this.admissionOpen) return 'unavailable'; const domain = await this.ready; if (!domain) return 'unavailable'
   try {
    const seals = domain.table('seals'), activities = domain.table('activity'), tips = domain.table('chain_tips'), sk = sealKey(seal.lifecycleFingerprint, seal.sourceSeq), ak = activityKey(seal.lifecycleFingerprint, seal.sourceSeq)
    const existing = seals.get(sk)
    if (existing !== undefined && canonicalJson(parseSealV1(existing)) !== canonicalJson(seal)) return 'conflict'
    const old = tips.get(sealedFactKey(seal.lifecycleFingerprint)) === undefined ? undefined : parseTip(tips.get(sealedFactKey(seal.lifecycleFingerprint))!)
    const priorKey = old?.keys.at(-1); const prior = priorKey === undefined ? undefined : parseSealV1(seals.get(priorKey))
    const previous = prior?.sealHash ?? genesisSealHash(seal.lifecycleFingerprint)
    const previousSeq = prior?.sourceSeq
    if (seal.previousSealHash !== previous || (previousSeq !== undefined && seal.sourceSeq <= previousSeq)) return 'conflict'
    if (existing === undefined) await seals.put(sk, seal)
    // A crash after seals.put leaves an orphan. An identical replay resumes the
    // remaining writes only when it is the exact next link; any other shape is conflict.
    const storedActivity = activities.get(ak)
    if (storedActivity !== undefined && canonicalJson(parseActivityV1(storedActivity)) !== canonicalJson(activity)) return 'conflict'
    if (storedActivity === undefined) await activities.put(ak, activity)
    const alreadyIndexed = old?.keys.includes(sk) ?? false
    if (alreadyIndexed) return this.validated(domain, seal.lifecycleFingerprint) === undefined ? 'conflict' : 'identical'
    await tips.put(sealedFactKey(seal.lifecycleFingerprint), makeTip(seal.lifecycleFingerprint, [...(old?.keys ?? []), sk], seal.sealHash))
    // Re-validating the complete chain on idempotent paths intentionally fails
    // closed if unrelated persistent corruption was observed (O(R), bounded tail).
    return this.validated(domain, seal.lifecycleFingerprint) === undefined ? 'unavailable' : existing === undefined ? 'created' : 'identical'
   } catch { return 'unavailable' }
  })
 }
 /** Undefined means unavailable or polluted; an empty array means no tip exists for this lifecycle. */
 async read(lifecycleFingerprint: string): Promise<readonly { readonly seal: SealV1; readonly activity: ActivityV1 }[] | undefined> { if (!this.admissionOpen) return undefined; const domain = await this.ready; return domain === undefined ? undefined : this.validated(domain, lifecycleFingerprint) }
 async drain(): Promise<void> { this.admissionOpen = false; await Promise.all(this.tails.values()); const domain = await this.ready; if (domain) await domain.close() }
 private validated(domain: StorageDomainHandle, lifecycleFingerprint: string): readonly { readonly seal: SealV1; readonly activity: ActivityV1 }[] | undefined { try { const raw = domain.table('chain_tips').get(sealedFactKey(lifecycleFingerprint)); if (raw === undefined) return Object.freeze([]); const t = parseTip(raw); if (t.lifecycleFingerprint !== lifecycleFingerprint || t.keys.length === 0) return undefined; let previous = genesisSealHash(lifecycleFingerprint); let previousSeq = -1; const rows: { seal: SealV1; activity: ActivityV1 }[] = []; for (const key of t.keys) { const seal = parseSealV1(domain.table('seals').get(key)); const activity = parseActivityV1(domain.table('activity').get(activityKey(lifecycleFingerprint, seal.sourceSeq))); if (seal.lifecycleFingerprint !== lifecycleFingerprint || seal.sourceSeq <= previousSeq || seal.previousSealHash !== previous || activity.lifecycleFingerprint !== lifecycleFingerprint || activity.sourceSeq !== seal.sourceSeq || activity.sourceSealHash !== seal.sealHash) return undefined; previous = seal.sealHash; previousSeq = seal.sourceSeq; rows.push({ seal, activity }) } if (t.tipHash !== chainTipHash(lifecycleFingerprint, previous)) return undefined; return Object.freeze(rows) } catch { return undefined } }
 private serial<T>(lifecycle: string, operation: () => Promise<T>): Promise<T> { const before = this.tails.get(lifecycle) ?? Promise.resolve(); const result = before.then(operation); const tail = result.then(() => undefined, () => undefined); this.tails.set(lifecycle, tail); return result.finally(() => { if (this.tails.get(lifecycle) === tail) this.tails.delete(lifecycle) }) }
}
