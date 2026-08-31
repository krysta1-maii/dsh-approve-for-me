# dsh-approve-for-me 施工蓝图（v2：机器决策槽）

> 状态：2026-08-28。本文是 v2 的**实施蓝图**：给出模块切分、每层抽象、关键接口、数据流、状态机与验收口径，供后续按阶段施工。语义权威仍是 [宿主契约](host-contract.md) 与 [卷宗规范](guardian-dossier.md)；本文不另立冲突语义，只把契约落到可实现的模块与接口。
>
> 原始代码基线（v2 重构前）归档在 git tag `archive/0.1.1-rc.2-guardian-skeleton`。

## 1. 目标与边界

### 1.1 目标

- 在 stock DSH 0.1.2-alpha.2 上，只 patch 官方 `@deepseek-ai/dsh-user-approval`，实现机器决策槽；
- 本体插件以 `registerMachinePolicy()` 为唯一自动裁决入口，裁决优先级与 `approval/request` listener 顺序无关；
- 长程任务无人值守：`trustEnvelope` 确定性快路径 + deny breaker + allow-cache；
- Guardian Reviewer 经独立插件 `dsh-managed-agent` 的 Guarded Continuable 承载；
- 自动 allow 只可能来自身份/事实校验通过的确定性结果或 Guardian 裁决，且最小决策记录先 durable；
- 人工兜底只通过 `'delegate'` 进入官方 `api-remotes → client/ui-approval` 瀑布。

### 1.2 非目标（v2）

- 不修改除 `dsh-user-approval` 外的任何官方包；
- 不引入第三审批 policy 模式；
- 不做语义等价熔断、跨工具绕过识别、child Session 遍历授权；
- 不恢复跨 unload/reload 的 pending approval；
- 不保存 provider 凭据、隐藏 reasoning、完整 transcript 或任意 child 输出正文。

### 1.3 约束

- 领域层（`domain/`、`approval-gate/`）不 import Cordis/DSH 类型；
- 应用层只依赖领域协议与端口；
- `dsh-managed-agent` 只作为 peer dependency 消费 `ctx.managedAgents`；
- fork tarball 保留官方包 `name`/`version`，用 `dshApprovalPatch` 标记第三方身份。

## 2. 模块总图

```text
src/
├── domain/                     # 审批协议、JSON、hash、身份
├── approval-gate/              # 裁决执行器端口与纯逻辑（无 DSH 类型）
├── ports/                      # managed reviewer / capture / fact / storage 端口
├── application/                # 编排：seal、breaker、run、channel、lanes、directory
├── reviewer/                   # Guardian 组合、决策工具、policy registry
├── dsh/                        # DSH 适配：capture、controller、machine policy、storage
├── config.ts / plugin.ts / index.ts

patch/dsh-user-approval/        # 官方 patch：overlay + 构建/校验
```

依赖方向：

```text
plugin ──> dsh ──> application ──> ports
                    │              │
                    └──> approval-gate ──> domain
dsh ──> reviewer ──> application/ports
```

## 3. 官方 patch（`patch/dsh-user-approval`）

### 3.1 变更集

```ts
// src/types.ts
export type MachineApprovalDecision = ApprovalOutcome | 'delegate'

export interface MachineApprovalPolicy {
  readonly id: string
  decide(request: ApprovalRequestEvent): Promise<MachineApprovalDecision>
}

export interface ApprovalRequestEvent {
  readonly agent: Agent
  readonly toolName: string
  /** 服务派发的每个请求都存在；等于 approval/asked.id。 */
  readonly requestId?: ApprovalRequestId
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly signal?: AbortSignal
}
```

```ts
// src/index.ts
export class ApprovalService extends Service {
  registerMachinePolicy(policy: MachineApprovalPolicy): () => void
  // decide(): never → machinePolicies（注册序，首个非 delegate 认领）
  //          → approval/request waterfall → normalize/fail-closed
}
```

### 3.2 必须保持的语义

| 场景 | 结果 |
|---|---|
| 未注册机器策略 | 行为与上游完全一致 |
| `never` 生效 | 不调用机器策略，直接 `rejected` |
| 机器策略返回合法 outcome | 认领，waterfall 不执行 |
| `'delegate'` | 下一机器策略；全部 delegate 后进入 waterfall |
| 抛错/非法返回值 | `unavailable` |
| 重复 `id` | 注册抛错 |
| disposer | 精确移除；幂等（重复调用无害） |

### 3.3 交付物

- `upstream.json`（tag/commit/version/patchVersion/changes）；
- `overlay/src/{index,types,invariant}.ts`；
- `overlay/tests/approval-machine-policy.spec.ts`；
- `scripts/build-fork.sh`（一次性上游 clone 覆盖 → pnpm build → `pnpm pack` → 校验，产出 `.build/dsh-user-approval-afm-0.1.2-alpha.2.tgz`）；
- `scripts/mark-package.mjs`（写 `dshApprovalPatch` 标记，name/version 不变）；
- `scripts/verify-fork.mjs`（校验标记与 lib 内 `registerMachinePolicy`/`requestId`）。

CI 门禁：上游 commit 不匹配时构建失败；官方合并 patch 后删除 fork tarball 交付。

## 4. 领域层

### 4.1 JSON 与 hash

沿用 `src/domain/json.ts`：

```ts
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export function snapshotJson(input: unknown): JsonValue      // lossless，拒绝 cycle/hole/-0/非有限数
export function freezeJson<T extends JsonValue>(value: T): Readonly<T>
export function canonicalJson(value: JsonValue): string       // key 排序、词法稳定
export class JsonSnapshotError extends TypeError {}
```

hash 规则：`sha256:` + lower hex，preimage = UTF8(domain separator 含结尾 NUL) + UTF8(canonicalJson(value))。

### 4.2 审批协议 v1（现有）

```ts
export interface ActionSnapshot {
  readonly version: 1
  readonly kind: 'tool-call'
  readonly toolName: string
  readonly arguments: JsonValue
  readonly requestedPermissions: readonly RequestedPermission[]
}

export interface RequestedPermission {
  readonly kind: 'filesystem' | 'network' | 'sandbox' | 'process' | 'other'
  readonly scope: string
  readonly details?: JsonValue
}

export interface ApprovalDecision {
  readonly protocolVersion: 1
  readonly reviewId: string
  readonly parentSessionId: string
  readonly reviewerSessionId: string
  readonly generation: string
  readonly actionHash: string
  readonly decision: 'allow' | 'deny' | 'human_review'
  readonly risk: 'low' | 'medium' | 'high' | 'critical' | 'unknown'
  readonly categories: readonly string[]
  readonly userAuthorization: 'explicit' | 'implicit' | 'absent' | 'conflicting' | 'unknown'
  readonly rationale: string
}

export function hashAction(action: ActionSnapshot): string
export function createActionSnapshot(input: ActionSnapshotInput): ActionSnapshot
export function parseActionSnapshot(input: unknown): ActionSnapshot
export function createApprovalReviewRequest(action, options): ApprovalReviewRequest
export function parseApprovalReviewRequest(input): ApprovalReviewRequest
export function parseApprovalDecision(input): ApprovalDecision
export function resolveApprovalDecision(decision, mode): ApprovalResolution
```

### 4.3 v2 身份协议（新增）

```ts
export interface ReviewRunIdentityV2 {
  readonly version: 2
  readonly reviewRunId: string
  /** patched requestId；等于 approval/asked.id。 */
  readonly requestId: string
  readonly parentSessionId: string
  readonly parentLifecycleFingerprint: string
  readonly callId: string
  readonly toolName: string
  readonly actionHash: string
  readonly dossierHash: string
  readonly generation: string
  readonly configurationFingerprint: string
  readonly issuedAt: number
  readonly deadlineAt: number
}

export interface ReviewAttemptIdentityV2 {
  readonly ordinal: 1 | 2
  readonly reviewId: string
  readonly reviewerSessionId: string
  readonly generation: string
}

export interface ReviewAttemptInputV2 {
  readonly run: ReviewRunIdentityV2
  readonly attempt: ReviewAttemptIdentityV2
  readonly request: ApprovalReviewRequestV2
  readonly packet: ApprovalReviewPacketV1
  readonly signal?: AbortSignal
}

export interface ApprovalReviewRequestV2 extends ApprovalReviewRequest {
  readonly requestId: string
  readonly parentLifecycleFingerprint: string
  readonly dossierHash: string
  readonly configurationFingerprint: string
}

export interface ReviewerRecoveryRecordV2 {
  readonly ordinal: number
  readonly kind: 'contaminated-child'
  readonly reviewerSessionId: string
  readonly discardedReviewId?: string
  readonly generation: string
  readonly occurredAt: number
}
```

不变量：

- `requestId` 与 asked id 精确相等；`callId`/`toolName`/`actionHash` 与 asked、capture、sidecar 逐一交叉相等；
- 每个业务 attempt 唯一 `reviewId`，且不能复用外层 `reviewRunId`；
- 同一 Run 内 generation/configuration/dossier/actionHash/deadline 不变。

### 4.4 approval-gate 领域类型

```ts
// catalog.ts
export type ToolApprovalClass = 'ordinary' | 'gate-ask' | 'body-escalation'

export interface ToolApprovalDescriptor {
  readonly toolName: string
  readonly toolSchemaFingerprint: string
  readonly classification: ToolApprovalClass
}

export interface ApprovalToolCatalog {
  readonly version: 1
  readonly argumentSemanticsId: string
  readonly fingerprint: string
  readonly descriptors: readonly ToolApprovalDescriptor[]
}

export type ToolApprovalClassificationResult =
  | { readonly kind: 'classified'; readonly classification: ToolApprovalClass }
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'catalog-mismatch' }

export interface ToolApprovalClassifier {
  classify(input: {
    readonly toolName: string
    readonly toolSchemaFingerprint: string
  }): ToolApprovalClassificationResult
}

// trust-envelope.ts
export interface TrustEnvelopeConfigV1 {
  readonly version: 1
  readonly enabled: boolean
  readonly tools: readonly TrustEnvelopeToolFamily[]
  readonly maxRequestedMode: 'read-only' | 'workspace-write'
  readonly workspaceOnly: boolean
  readonly requireJustification: boolean
  readonly requireStrictWidening: boolean
}

export type TrustEnvelopeEvaluationV1 =
  | { readonly kind: 'inside' }
  | { readonly kind: 'outside'; readonly reason: TrustEnvelopeRejectReasonV1 }

export interface TrustEnvelopeInputV1 {
  readonly toolFamily: TrustEnvelopeToolFamily
  readonly requestedMode?: 'workspace-write' | 'danger-full-access'
  readonly effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly targets: readonly string[]
  readonly justification?: string
}

export interface TrustEnvelopeEvaluatorV1 {
  evaluate(input: TrustEnvelopeInputV1): TrustEnvelopeEvaluationV1
}

// breaker.ts
export interface ExactDenialBreakerKeyV1 {
  readonly parentLifecycleFingerprint: string
  readonly turn: number
  readonly directUserFrontierSeq: number
  readonly actionHash: string
}

export interface ExactDenialBreakerV1 {
  lookup(key: ExactDenialBreakerKeyV1): boolean
  recordGuardianDeny(key: ExactDenialBreakerKeyV1): void
  clearParent(parentLifecycleFingerprint: string): void
}

export interface AllowCacheKeyV1 extends ExactDenialBreakerKeyV1 {
  readonly configurationFingerprint: string
  readonly generation: string
}

export interface AllowCacheV1 {
  lookup(key: AllowCacheKeyV1): boolean
  recordGuardianAllow(key: AllowCacheKeyV1): void
  clearParent(parentLifecycleFingerprint: string): void
}

// sealed-decision.ts
export type SealedDispositionKind = 'allow' | 'deny' | 'human'

export interface SealedDispositionV1 {
  readonly version: 1
  readonly reviewRunId: string
  readonly requestId: string
  readonly parentSessionId: string
  readonly callId: string
  readonly actionHash: string
  readonly generation: string
  readonly configurationFingerprint: string
  readonly disposition: SealedDispositionKind
  readonly issuedAt: number
  readonly deadlineAt: number
  readonly replayable: boolean
}

export type SealedDispositionLookupV1 =
  | { readonly kind: 'sealed'; readonly disposition: SealedDispositionV1 }
  | { readonly kind: 'missing' }
  | { readonly kind: 'mismatch'; readonly reason: string }
  | { readonly kind: 'consumed' }

export interface SealedDispositionRegistryV1 {
  seal(disposition: SealedDispositionV1): void
  lookup(requestId: string, callId: string, actionHash: string): SealedDispositionLookupV1
  consume(requestId: string, callId: string): boolean
  clearParent(parentSessionId: string): void
}

// machine-policy.ts
export type GateMachineDecisionV1 =
  | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'delegate'

export interface GateMachineRequestV1 {
  readonly requestId?: string
  readonly parentSessionId: string
  readonly callId?: string
  readonly toolName: string
  readonly reason?: string
  readonly actionHash: string
  readonly mode: 'auto' | 'auto-then-user'
  readonly signal?: AbortSignal
}

export interface GateMachinePolicyV1 {
  readonly id: 'dsh-approve-for-me/v1'
  decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1>
}
```

## 5. 端口层（`src/ports`）

```ts
export interface ParentAuthority<Parent, SessionId> {
  readonly live: Parent          // exact live Agent（或等价 owner）
  readonly sessionId: SessionId  // 只用于归属/发现/串行，不授予控制权
}

export interface ManagedOwnedReviewer<SessionId> {
  readonly id: SessionId
  readonly parentSessionId: SessionId
  readonly provider: string
  readonly label: string
  readonly providerData?: JsonValue
  readonly activity: 'running' | 'inactive'
  readonly contaminated: boolean
}

export interface ManagedReviewerPort<Parent, SessionId> {
  create(authority, options: { label; providerData; signal? }): Promise<SessionId>
  list(parentSessionId, signal?): Promise<ManagedOwnedReviewer<SessionId>[]>
  rotate(authority, childId, signal?): Promise<SessionId>
  deliver(authority, childId, content, options?): Promise<unknown>
  interrupt(authority, childId): void
}

export interface ActionProjector<Execution> {
  project(execution: Execution): ActionSnapshotInput
}

export interface ActionCapture<Owner, CallId> {
  remember(owner, callId, action): void
  lookup(owner, callId, toolName): ActionSnapshot | undefined
  release(owner, callId): boolean
}
```

### 事实与存储端口（v2 新增，类型不 import DSH）

```ts
export interface ParentSessionFactSource<Parent> {
  bindAndSnapshot(input: {
    authority: ParentAuthority<Parent, string>
    liveRequest: { requestId: string; callId: string; toolName: string; reason?: string }
    signal?: AbortSignal
  }): Promise<ParentSessionFactSnapshotV1>
}

export interface ExecutionFactRepository {
  put(record: ToolExecutionFactRecordV1): Promise<void>
  get(input: { session; callId; requestEventSeq }): Promise<ToolExecutionFactRecordV1 | undefined>
}

export interface ApprovalSnapshotRepository {
  create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical'>
  get(input: { session; approvalRequestId; approvalAskedSeq }): Promise<ApprovalSnapshotRecordV1 | undefined>
}

export interface DecisionRecordStore {
  createConfirmed(record: ReviewDecisionRecordV1): Promise<'confirmed' | 'conflict' | 'unavailable'>
  drain(): Promise<void>
}

export interface CaseCaptureSink {
  enqueue(artifact: GuardianCaseArtifactV1): void
  drain(): Promise<void>
}

export interface ApproveForMeStorageLifecycle {
  drainSafetyCritical(): Promise<void>
  close(): Promise<void>
}

export interface HostTelemetryPort {
  emit(event: HostTelemetryEventV2): void
}
```

`ExecutionFactRepository`/`ApprovalSnapshotRepository` 的 record 类型、key 编码与一致性规则以 [卷宗规范](guardian-dossier.md) 第 12 节为准；`DecisionRecordStore.createConfirmed` 必须区分瞬时不可用与内容冲突（宿主契约第 5 节映射依赖该区分）。

## 6. 应用层（`src/application`）

### 6.1 已有模块（保留并迁移）

```ts
export class DefaultDecisionChannel implements DecisionChannel {
  arm(request, signal?): Promise<ApprovalDecision>   // 同步失败：disposed/重复/已 abort/已过期
  submit(payload, context): SubmitDecisionResult    // 实际 caller id 为准；invalid 路径同样先校验 caller
  cancel(reviewId, code?, message?): boolean
  dispose(): void
}

export class SerialLanes {
  run<T>(key: string, task: () => Promise<T>): Promise<T>
  drain(): Promise<void>                             // v2 新增：卸载前等待本 lane 任务 settle
}

export class DefaultReviewerDirectory<Parent, SessionId> {
  ensure(authority, preset, signal?): Promise<SessionId>
  // 过滤：provider/父 id/contaminated/parse providerData/generation/fingerprint
  // 多个匹配：失败关闭；零匹配：create()
}
```

`DecisionChannel.submit` 的无效 payload 路径必须先以 `context.actualReviewerSessionId` 与 pending entry 匹配，再决定是否终结 pending，防止跨 child 误杀（v2 修复项）。

### 6.2 前置裁决编排

```ts
export interface PreReviewCoordinatorOptions<Parent, SessionId> {
  readonly port: ManagedReviewerPort<Parent, SessionId>
  readonly directory: ReviewerDirectory<Parent, SessionId>
  readonly channel: DecisionChannel
  readonly lane: SerialLanes
  readonly seals: SealedDispositionRegistryV1
  readonly timeoutMs: number
  readonly preset: ReviewerProviderDataV1
  readonly now?: () => number
  readonly reviewId?: () => string
}

export interface PreReviewCoordinator<Parent, SessionId> {
  preReview(input: {
    readonly authority: ParentAuthority<Parent, SessionId>
    readonly requestId: string
    readonly callId: string
    readonly action: ActionSnapshot
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<SealedDispositionV1>

  replay(input: {
    readonly requestId: string
    readonly callId: string
    readonly actionHash: string
  }): SealedDispositionLookupV1
}
```

`preReview` 顺序：

```text
abort 预检 → lane 串行
→ directory.ensure（污染发现可 rotate，最多一次基础设施恢复）
→ 构造 ReviewRunIdentityV2（issuedAt=now，deadlineAt=now+timeoutMs）
→ channel.arm(reviewId)
→ port.deliver(packet)
→ await 结果（timeout/abort/dispose 由 channel 终结）
→ 校验 identity/actionHash/generation/requestId
→ 构造 SealedDispositionV1 并 seal
→ 返回 seal；body 内/审批链内的后续 ask 只能 replay
```

重试矩阵：

| 错误 | 行为 |
|---|---|
| 污染（typed `CONTAMINATED_CHILD`） | rotate + 新 attempt；不延长 deadline；算基础设施恢复 |
| provider/network/rate-limit/model/no-tool-call/schema-repairable | 有 attempt 预算与 deadline 时进入下一业务 attempt |
| deny/human/身份冲突/deadline/abort/draining/disposed | 不重试，按映射终结 |

### 6.3 裁决管线编排

```ts
export interface GatePipelineDependencies {
  readonly classifier: ToolApprovalClassifier
  readonly trustEnvelope: TrustEnvelopeEvaluatorV1
  readonly breaker: ExactDenialBreakerV1
  readonly allowCache: AllowCacheV1
  readonly seals: SealedDispositionRegistryV1
  readonly preReview: PreReviewCoordinator<Parent, SessionId>
  readonly records: DecisionRecordStore
  readonly mode: 'auto' | 'auto-then-user'
  readonly now?: () => number
}

export interface GatePipeline {
  decide(request: GateMachineRequestV1): Promise<GateMachineDecisionV1>
}
```

`GatePipeline.decide` 固定顺序：

```text
1. requestId/callId 存在？分类结果 known？capture actionHash 一致？根 requester？
   ├─ 冲突 → unavailable（两种 mode 都不 delegate）
   └─ 无 callId/未知工具 → auto: unavailable；auto-then-user: delegate
2. breaker.lookup(hit) → rejected
3. trustEnvelope.evaluate(inside) → durable record → allowed-once
   └─ record: unavailable（auto）/ delegate（auto-then-user）；conflict → unavailable
4. allowCache.lookup(hit) → allowed-once
5. seal 已存在且未 consume → replay 映射
6. preReview.preReview() → disposition
7. 映射：
   allow  → durable record → allowed-once
   deny   → record（best-effort）→ rejected；record 失败不改变 deny
   human  → auto: rejected；auto-then-user: delegate
   retryable/unavailable → auto: unavailable；auto-then-user: delegate
   aborted → cancelled
8. 除 delegate/cancelled 外，将 disposition 与 Run 摘要写入最小记录
```

记录失败映射必须区分：`'conflict'` 两种 mode 都 `unavailable`；`'unavailable'` 仅在 auto-then-user 可 `delegate`。

### 6.4 breaker/allow-cache 实现（应用层）

```ts
export class InMemoryExactDenialBreaker implements ExactDenialBreakerV1 {
  // Map<parentLifecycleFingerprint, Map<turn, Map<directUserFrontierSeq, Set<actionHash>>>>
}

export class InMemoryAllowCache implements AllowCacheV1 {
  // 键同上 + configurationFingerprint + generation；clearParent 全清
}
```

丢失状态只导致多一次裁决，绝不产生 allow；持久化缓存（Storage Domain）是 v1.1 优化，不在 v2 验收范围。

## 7. Reviewer 层（`src/reviewer`）

```ts
export interface ReviewerPolicy {
  readonly version: string
  readonly systemPrompt: string
  readonly decisionParameters: ObjectJsonSchema
  buildRequestContent(request: ApprovalReviewRequest): ContentBlock[]
}

export interface PolicyRegistry {
  resolve(version: string): ReviewerPolicy   // 未知版本抛错
  versions(): readonly string[]
}

export interface DecisionSubmitter {
  submit(payload: unknown, actualReviewerSessionId: string): SubmitDecisionResult
}

export function createReviewerProvider(options): ManagedAgentProvider
// materialize: parseReviewerProviderData → policies.resolve
// agentOptions: 固定 provider/model（+reasoningEffort）
// toolFilter: { allow: [] }；setup 不继承全局工具
// systemPrompt.section({ complete: true }) + suppressRuntimeContext
// tools.restrict({ allow: [] }) + 注册唯一 submit_approval_decision
// child approval=never、sandbox=read-only
```

决策工具两阶段不变：

```text
ToolDefinition.execute()  校验 exec.agent.session.id === expected child
                          → parse/stage candidate → concludeTurn()
child tools/result        同 exec 成功终态 → submitter.submit(candidate, actualId)
                          failure/身份不符/无 caller → 丢弃 staged candidate
```

v2 增加：child transcript 保留策略。每 parent 的 Reviewer 持久 child 达到配置 `maxReviewsPerChild`（默认 64）后 rotate 到新 child；旧 child 只读保留/随后由目录跳过，避免历史 packet 无限累积造成的跨审批注入面。

## 8. DSH 适配层（`src/dsh`）

```ts
export interface CaptureBridge {
  preExecute(exec: ToolExecution, next): Promise<PreToolDecision>
  observeResult(exec: Readonly<ToolExecution>): undefined
}

export function createManagedReviewerPort(controller: ManagedAgentController): ManagedReviewerPort<Agent, string>

export interface MachinePolicyAdapterOptions {
  readonly gate: GateMachinePolicyV1
}
export function createMachinePolicyAdapter(options): MachineApprovalPolicy
// id: 'dsh-approve-for-me/v1'
// decide(req): 把 patched ApprovalRequest 映射为 GateMachineRequestV1：
//   requestId→requestId, agent.id→parentSessionId, callId, toolName, reason,
//   从 capture/execution 侧查 actionHash（缺省时按 domain hash），signal 透传

export function createStorageAdapters(ctx, options): {
  executions: ExecutionFactRepository
  approvalSnapshots: ApprovalSnapshotRepository
  records: DecisionRecordStore
  cases: CaseCaptureSink
  lifecycle: ApproveForMeStorageLifecycle
}
// Storage Domain：domain=approve_for_me，format=1
// 通过 ctx.storage.domain.open(...)/ctx.storageDomain.open(...) 打开；禁止私有 JSON
```

capture 与 machine policy 的时序：

```text
tools/pre-execute(capture, prepend)
  → classifier 分类并缓存 execution 视图
  → body-escalation 且需要前置裁决时调用 gate.preReview（后续按阶段接入）
  → 透传/修改 PreToolDecision

approval/request 到达时：机器策略由 patched 服务先于所有 listener 调用，
本体 listener 仅用于 'delegate' 之后的观测，不再是授权边界。
```

## 9. 配置与组合根

```ts
export interface ApproveForMeConfigV2 {
  readonly mode?: 'auto' | 'auto-then-user'
  readonly timeoutMs?: number
  readonly reviewer: {
    readonly generation: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly policyVersion: string
    readonly toolsetVersion: 1
  }
  readonly trustEnvelope?: TrustEnvelopeConfigV1
  readonly maxReviewsPerChild?: number
  readonly caseCapture?: GuardianCaseCaptureConfigV1
}

export interface NormalizedApproveForMeConfigV2 { ... }   // 全部缺省展开 + freeze

export interface InstalledApproveForMeV2 {
  readonly state: 'starting' | 'ready' | 'draining' | 'disposed' | 'failed'
  start(): Promise<void>
  dispose(): Promise<void>
}

export function installApproveForMeV2(ctx, config, options): InstalledApproveForMeV2
```

`apply()` 挂载顺序：

```text
validate config + patch 标记校验
→ 注册 capture hooks
→ 构造 channel/lane/directory/seals/pipeline
→ ctx.approval.registerMachinePolicy(adapter)   // 必须成功，disposer 归 effect
→ ctx.managedAgents.registerProvider(...)       // 依赖插件
→ 打开 Storage Domain
→ state = ready
```

卸载顺序：

```text
state = draining
→ 停止新 review；in-flight auto settle unavailable；active signal 时 auto-then-user delegate
→ tombstone pending channel
→ interrupt/drain Reviewer；drain 安全关键写入
→ 撤销 capture/provider/storage handle
→ 最后撤销 machine policy 注册
→ state = disposed
```

`failed` 状态下两种 mode 都不 delegate；`draining` 只在 request signal 活跃时允许 delegate。

## 10. 状态机与错误分类

状态机与 [宿主契约](host-contract.md) 第 8 节一致：

```text
starting → ready | failed
starting | ready | failed → draining → disposed
draining → failed 非法
```

错误分类闭集（应用层出口）：

```ts
type GateFailureCodeV2 =
  | 'missing-request-id' | 'missing-call-id' | 'unclassified-tool'
  | 'authority-mismatch' | 'action-hash-mismatch' | 'reviewer-identity-mismatch'
  | 'generation-mismatch' | 'source-integrity-conflict' | 'protocol-invalid'
  | 'policy-version-mismatch' | 'late-result'
  | 'provider-unavailable' | 'network' | 'rate-limited' | 'model-error'
  | 'no-tool-call' | 'schema-invalid-repairable'
  | 'deadline' | 'request-aborted' | 'host-not-ready' | 'host-disposed'
  | 'decision-record-unavailable' | 'decision-record-conflict'
```

映射表（实现必须逐分支测试，未知值 fail-closed）：

| 条件 | auto | auto-then-user |
|---|---|---|
| allow + record confirmed | allowed-once | allowed-once |
| deny | rejected | rejected |
| human_review | rejected | delegate |
| 非冲突性能力不足/瞬时 record unavailable | unavailable | delegate |
| 身份/完整性/冲突/late/unknown | unavailable | unavailable |
| abort | cancelled | cancelled |

## 11. 持久化

四表与 key/GC/TTL 规则见 [卷宗规范](guardian-dossier.md) 第 12、13.4 节。蓝图只固化实现依赖：

- `executions`/`approval_snapshots`：dossier fact source；自动 allow 前置；
- `review_records`：`createConfirmed` 返回三态 `'confirmed' | 'conflict' | 'unavailable'`；
- `case_artifacts`：best-effort，不阻塞裁决；
- fork/parent 删除 cascade；GC 只依据权威 SessionStore 删除确认，读取错误不视为删除。

## 12. 测试与验收分层

```text
unit        domain/approval-gate/application 纯逻辑（hash、catalog、envelope、breaker、
            channel、lanes、run identity）
adapter     patched 类型 + machine policy 适配 + managed controller 映射
patch       在 fork tarball 上跑 approval-machine-policy.spec.ts
security    抢答 allowed-once 的 prepend listener 无法越过机器策略；
            never 优先；异常/非法值 fail-closed；无效 payload 不能跨 child 终结 pending
integration 真实 0.1.2 Profile + fork + dsh-managed-agent：物化/复用/cold resume/
            Web 人工/卸载/污染轮换
soak        长程：trustEnvelope 内 100 次动作 0 人工、0 误放行；包络外命中 Guardian
```

每个模块完成定义：接口冻结、正常/失败/对抗测试、`npm run check` 通过、文档同步。

## 13. 实施顺序（蓝图级）

1. **P0** 0.1.2 迁移 + fork 构建进入 CI；
2. **P1** `src/dsh/machine-policy-adapter.ts` + 组合根注册 + patch 测试通过；
3. **P2** classifier、trustEnvelope、breaker、allow-cache、sealed registry、preReview coordinator、记录三态；
4. **D1** fact source + dossier compiler（requestId 精确绑定）；
5. **H4** 记录/案例/GC/TTL；
6. **I1** 真实验收与 soak。

详细阶段与退出条件以 [construction-plan.md](construction-plan.md) 为准。

## 14. 术语

| 术语 | 含义 |
|---|---|
| machine policy | patched `registerMachinePolicy()` 注册的服务级裁决器 |
| gate | `src/approval-gate` 中的裁决执行器 |
| seal | 前置裁决的不可变重放凭证 |
| trustEnvelope | 确定性自动批准的闭集包络 |
| breaker | 精确 actionHash 拒绝熔断 |
| Guardian | 隔离的 Reviewer child |
| delegate | 机器策略显式下沉到交互瀑布的决策值 |
