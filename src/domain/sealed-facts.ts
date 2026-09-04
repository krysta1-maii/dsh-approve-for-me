import { createHash } from 'node:crypto'
import { canonicalJson, snapshotJson } from './json.js'
import type { JsonValue } from './json.js'

export const SEALED_FACTS_VERSION = 1 as const
export const SEAL_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/seal/v1\0'
export const GENESIS_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/genesis/v1\0'
export const TIP_HASH_DOMAIN = 'dsh-approve-for-me/approval-ledger/tip/v1\0'
const HASH = /^sha256:[0-9a-f]{64}$/
export type SealResultStatusV1 = 'completed' | 'tool-error' | 'sandbox-denied'
export interface SealV1 {
 readonly version: 1; readonly lifecycleFingerprint: string; readonly sourceSeq: number
 readonly request: { readonly eventSeq: number; readonly eventType: 'tool/call' | 'tool/code-dispatch-start'; readonly callId: string; readonly toolName: string }
 readonly approvalAsked: { readonly eventSeq: number; readonly requestId: string }
 readonly actionHash: string; readonly projectorId: string
 readonly catalog: { readonly epoch: number; readonly headerEventSeq: number; readonly commitment: string }
 readonly wireSchemaFingerprint: string; readonly result: { readonly eventSeq: number; readonly status: SealResultStatusV1 }
 readonly epochBoundary: { readonly previousEpoch: number | null; readonly changed: boolean }
 readonly previousSealHash: string; readonly sealHash: string; readonly canonical: string
}
export interface ActivityV1 { readonly version: 1; readonly lifecycleFingerprint: string; readonly sourceSeq: number; readonly occurredAt: number; readonly classification: string; readonly targetSummary: string; readonly resultCategory: SealResultStatusV1; readonly sourceSealHash: string; readonly canonical: string }
function object(value: unknown, name: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name); return value as Record<string, unknown> }
function keys(o: Record<string, unknown>, expected: readonly string[], name: string) { if (Object.keys(o).length !== expected.length || expected.some(k => !Object.hasOwn(o,k)) || Object.keys(o).some(k=>!expected.includes(k))) throw new TypeError(name) }
function str(v: unknown, n: string): string { if (typeof v !== 'string' || v.length === 0) throw new TypeError(n); return v }
function int(v: unknown,n:string):number { if (!Number.isSafeInteger(v) || (v as number)<0) throw new TypeError(n); return v as number }
function digest(domain:string, value:unknown) { return 'sha256:'+createHash('sha256').update(domain).update(canonicalJson(value)).digest('hex') }
export function genesisSealHash(lifecycleFingerprint: string): string { return digest(GENESIS_HASH_DOMAIN, { version: 1, lifecycleFingerprint }) }
export function sealHash(input: Omit<SealV1,'sealHash'|'canonical'> | Omit<SealV1,'canonical'>): string { const payload = { ...(input as Record<string, unknown>) }; delete payload.sealHash; return digest(SEAL_HASH_DOMAIN, payload) }
export function chainTipHash(lifecycleFingerprint:string, sealHashValue:string): string { return digest(TIP_HASH_DOMAIN,{version:1,lifecycleFingerprint,sealHash:sealHashValue}) }
export function parseSealV1(input: unknown): SealV1 {
 const o=object(input,'seal'); keys(o,['version','lifecycleFingerprint','sourceSeq','request','approvalAsked','actionHash','projectorId','catalog','wireSchemaFingerprint','result','epochBoundary','previousSealHash','sealHash','canonical'],'seal'); if(o.version!==1) throw new TypeError('seal.version')
 const request=object(o.request,'request');keys(request,['eventSeq','eventType','callId','toolName'],'request'); const asked=object(o.approvalAsked,'asked');keys(asked,['eventSeq','requestId'],'asked'); const catalog=object(o.catalog,'catalog');keys(catalog,['epoch','headerEventSeq','commitment'],'catalog'); const result=object(o.result,'result');keys(result,['eventSeq','status'],'result'); const boundary=object(o.epochBoundary,'boundary');keys(boundary,['previousEpoch','changed'],'boundary')
 const parsed: Omit<SealV1,'canonical'>={version:1,lifecycleFingerprint:str(o.lifecycleFingerprint,'lifecycle'),sourceSeq:int(o.sourceSeq,'sourceSeq'),request:{eventSeq:int(request.eventSeq,'request.seq'),eventType:request.eventType==='tool/call'||request.eventType==='tool/code-dispatch-start'?request.eventType:(()=>{throw new TypeError('eventType')})(),callId:str(request.callId,'callId'),toolName:str(request.toolName,'toolName')},approvalAsked:{eventSeq:int(asked.eventSeq,'asked.seq'),requestId:str(asked.requestId,'requestId')},actionHash:str(o.actionHash,'actionHash'),projectorId:str(o.projectorId,'projectorId'),catalog:{epoch:int(catalog.epoch,'epoch'),headerEventSeq:int(catalog.headerEventSeq,'header'),commitment:str(catalog.commitment,'commitment')},wireSchemaFingerprint:str(o.wireSchemaFingerprint,'wire'),result:{eventSeq:int(result.eventSeq,'result.seq'),status:['completed','tool-error','sandbox-denied'].includes(result.status as string)?result.status as SealResultStatusV1:(()=>{throw new TypeError('status')})()},epochBoundary:{previousEpoch:boundary.previousEpoch===null?null:int(boundary.previousEpoch,'previousEpoch'),changed:typeof boundary.changed==='boolean'?boundary.changed:(()=>{throw new TypeError('changed')})()},previousSealHash:str(o.previousSealHash,'previous'),sealHash:str(o.sealHash,'sealHash')}
 if(parsed.request.eventSeq!==parsed.sourceSeq || parsed.result.eventSeq<=parsed.sourceSeq || parsed.approvalAsked.eventSeq<=parsed.sourceSeq || !HASH.test(parsed.actionHash)||!HASH.test(parsed.wireSchemaFingerprint)||!HASH.test(parsed.previousSealHash)||!HASH.test(parsed.sealHash)||parsed.sealHash!==sealHash(parsed)||o.canonical!==canonicalJson(parsed)) throw new TypeError('invalid seal')
 return Object.freeze({...parsed,canonical:o.canonical as string})
}
export function createSealV1(input: Omit<SealV1,'version'|'sealHash'|'canonical'>): SealV1 { const base={version:1 as const,...input}; const hashed={...base,sealHash:sealHash(base)}; return parseSealV1({...hashed,canonical:canonicalJson(hashed)}) }
export function parseActivityV1(input:unknown):ActivityV1 { const o=object(input,'activity');keys(o,['version','lifecycleFingerprint','sourceSeq','occurredAt','classification','targetSummary','resultCategory','sourceSealHash','canonical'],'activity'); if(o.version!==1)throw new TypeError('activity.version'); const resultCategory=['completed','tool-error','sandbox-denied'].includes(o.resultCategory as string)?o.resultCategory as SealResultStatusV1:(()=>{throw new TypeError('activity.status')})(); const p={version:1 as const,lifecycleFingerprint:str(o.lifecycleFingerprint,'activity.lifecycle'),sourceSeq:int(o.sourceSeq,'activity.seq'),occurredAt:int(o.occurredAt,'activity.time'),classification:str(o.classification,'activity.classification'),targetSummary:str(o.targetSummary,'activity.target'),resultCategory,sourceSealHash:str(o.sourceSealHash,'activity.seal')}; if(!HASH.test(p.sourceSealHash)||o.canonical!==canonicalJson(p)) throw new TypeError('invalid activity'); return Object.freeze({...p,canonical:o.canonical as string}) }
export function createActivityV1(input: Omit<ActivityV1,'version'|'canonical'>):ActivityV1 { const row={version:1 as const,...input}; return parseActivityV1({...row,canonical:canonicalJson(row)}) }
/**
 * Derive the sealed activity classification from a catalog descriptor. This is
 * the domain-authoritative classifier shared by the capture bridge and the
 * sealed-facts reader (WP4-c switches the bridge onto it); it throws on any
 * descriptor it cannot map so untrusted sidecars fail closed. It reproduces the
 * exact production rule: ordinary -> classificationId, delegation ->
 * 'delegation:'+operation.
 */
export function activityClassificationFromDescriptorV1(descriptor: unknown): string {
 const d=object(descriptor,'descriptor'); if(d.classification==='ordinary')return str(d.classificationId,'descriptor.classificationId'); if(d.classification==='delegation')return `delegation:${str(d.operation,'descriptor.operation')}`; throw new TypeError('descriptor.classification') }
export function sealedFactKey(lifecycleFingerprint:string):string { return 'l1_'+createHash('sha256').update('l1\0').update(lifecycleFingerprint).digest('hex') }
