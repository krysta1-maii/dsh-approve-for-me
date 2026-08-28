# Approve-for-me 宿主接口与生命周期契约

> 状态：2026-08-28，**宿主设计 v1 初步定稿／候选实现契约**。
>
> 本文定义 `dsh-approve-for-me` 在 DSH Host 中的组合接口、审批映射、Review Run、生命周期、持久化和失败关闭边界。当前仓库尚未实现本文全部接口；已实现骨架与待迁移项见 [implementation.md](implementation.md)。Guardian 材料本身由 [Guardian 案件卷宗接口与编译规范](guardian-dossier.md) 定义，文档权威顺序见 [文档地图](README.md)。

## 1. 定稿范围与未决前置条件

宿主 v1 已固定以下技术取向：

1. 插件是 DSH 工具副作用发生前的内联审批 policy，不是事后审计器；
2. profile 只组合一个 terminal approval composer，不依赖普通 sibling listener 顺序；
3. `auto-then-user` 只对能力不足／暂时不可用提供有限人工恢复；身份、事实完整性和协议矛盾硬停止；
4. pending approval 不跨 unload／reload 恢复；
5. 同一 parent lifecycle 串行，不同 parent 可并行；
6. 一个 Review Run 使用一个总 deadline，最多两个业务 Reviewer attempts；
7. 首期拒绝熔断只匹配完全相同的 `actionHash`；
8. 自动 allow 所依赖的最小事实强持久化，telemetry 尽力写入；
9. 默认只保存最小决策记录，完整 Guardian 案例必须显式 opt-in；
10. Reviewer route、generation、policy 和 toolset 显式固定，不继承主 Agent，也不静默切换。

v1 的部署结论是：**不修改官方 `@deepseek-ai/dsh-*` 插件族，但必须配套一个受控 Host Profile 和 profile-owned thin approval-composer adapter。** Agent Preset 虽然是可包含特权插件的 agent-scoped Cordis composition，却不能拥有这里要求的 Host-plane、进程稳定、exclusive 审批拓扑和人工桥；因此不能替代 Host Profile。Preset 插件仍可能注册 agent-scoped `approval/request` listener 并在 composer 前截断或在其 continuation 下游插入，所以受支持 Profile 还必须禁用可变／用户 preset roots，并对全部启用 preset 做版本锁定与 listener allowlist 审计，保证没有 preset approval listener。DSH `0.1.1-rc.2` 的 Web 人工审批位于 `dsh-host-apiproxy` private sibling listener 中，没有公开可调用的 `HumanApprovalPort`；配套 adapter 在锁定且验收过的 listener 拓扑内，于每次 dispatch 内把当前请求的 continuation 包装为 request-scoped human port。核心插件不得读取 private pending registry、复制 Web wire protocol，或假设自己安装到任意 profile 后都能依靠 sibling 顺序获得相同语义。

## 2. DSH 执行位置

一次需要审批的调用按以下顺序运行：

```text
模型产生 tool call
→ DSH 持久化 assistant/message + tool/call
→ tools/pre-execute（捕获精确动作）
→ sandbox／工具 policy 调用 ctx.approval.request()
→ DSH 持久化 approval/asked
→ profile terminal approval composer
   → ApproveForMeHostPolicy
   → 必要时 HumanApprovalPort
→ DSH 持久化 approval/decided
→ 只有 allowed-once 才执行工具副作用
→ tools/post-execute + tools/result
→ DSH 持久化 tool/result
→ Agent 继续下一 step
```

因此：

- 插件只裁决当前借入的 live `ApprovalRequest`；
- 不创建第二个“补票”审批；
- 不在工具执行后反向授权；
- `allow` 只映射为本次调用的 `allowed-once`；
- 任一失败路径都不得执行敏感动作。

## 3. 类型命名与权威来源

本文 TypeScript 是候选 public/application contract。实现时应直接复用 DSH 和本项目已有类型，不复制 facsimile：

```ts
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import type {
  ActionSnapshot,
  ApprovalDecision,
  ApprovalReviewRequest,
  ReviewerProviderDataV1,
} from '../src/domain/protocol.js'
import type { ParentAuthority } from '../src/ports/managed-reviewer.js'
```

以下类型由卷宗规范提供，本文仅引用其语义：

```ts
interface ApprovalReviewPacketV1 { readonly version: 1 }
/** SourceVerifiedDossierV1 直接从卷宗 compiler module type-only import；本文件不重声明其 private brand。 */
interface ReviewDecisionRecordV1 { readonly version: 1 }
interface GuardianCaseArtifactV1 { readonly version: 1 }
interface GuardianCaseCaptureConfigV1 {
  readonly mode: 'off' | 'full'
  readonly maxCases: number
  readonly maxArtifactBytes: number
  readonly maxTotalBytes: number
  readonly retentionDays: number
}
```

## 4. Loader 配置

v1 不把策略代码、权限 projector、时钟、存储实例或人工 port 放入 YAML／JSON 配置。

```ts
interface ApproveForMeHostConfigV1 {
  readonly mode?: 'auto' | 'auto-then-user'
  /** 整个 Review Run 的总 deadline；不是每 attempt 独立 deadline。 */
  readonly timeoutMs?: number
  readonly reviewer: {
    readonly generation: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly policyVersion: string
    readonly toolsetVersion: 1
  }
  readonly caseCapture?: GuardianCaseCaptureConfigV1
}

interface NormalizedApproveForMeHostConfigV1 {
  readonly mode: 'auto' | 'auto-then-user'
  readonly timeoutMs: number
  readonly reviewer: ReviewerProviderDataV1
  /** v1 固定最多两个业务 attempt，不开放无界重试配置。 */
  readonly maxReviewAttempts: 2
  readonly caseCapture: GuardianCaseCaptureConfigV1
}
```

挂载前必须验证：

- `timeoutMs` 为正 safe integer；
- provider／model／generation／policyVersion 非空且格式合法；
- toolset version 已知；
- configuration fingerprint 可复算；
- case quota／TTL 满足卷宗规范；
- 已取得 profile-owned terminal composer，并验证 `ApprovalTopologyAttestationV1` 的 DSH 版本、fingerprint、禁用可变 preset roots 及 `presetApprovalListeners: 'none'`；`auto-then-user` 还要求 composer 静态声明 `supportsHumanDelegation: true`；request-scoped `HumanApprovalPort` 只能在未来每次 listener dispatch 内创建，挂载时不存在；
- policy／decision schema／tool classification catalog 可解析且版本兼容。

DSH model selection 当前不验证 provider/model catalog 存在性。语法合法但不存在或暂不可用的 route 在 materialize／request 阶段成为 Reviewer 能力故障；不得静默改用其他模型。

## 5. Profile-owned terminal approval composer

### 5.1 外部组合端口

composer 是 profile 中唯一拥有自动审批策略的入口。插件只占用一个全局自动 policy slot；人工能力由 composer 注入的 `HumanApprovalPort` 表示，DSH 竞速后记录的 `approval/decided` 才是权威 outcome。若使用第 5.3 节的兼容 adapter，stock Web human listener 仍是下游传输实现，但不拥有第二个自动 policy。

```ts
type AsyncDisposer = () => void | Promise<void>

type ApprovalPluginDispositionV1 =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: HostDecisionCodeV1 }
  | { readonly kind: 'delegate-human'; readonly reason: HumanRecoveryReasonV1 }
  | { readonly kind: 'unavailable'; readonly reason: HostDecisionCodeV1 }
  | { readonly kind: 'cancelled'; readonly reason: 'request-aborted' | 'host-disposed' }

interface ApprovalPolicyContributionV1 {
  readonly id: 'dsh-approve-for-me/v1'
  /** v1 接收挂载期间的每个 ApprovalRequest；unsupported 也必须显式映射。 */
  decide(request: ApprovalRequest): Promise<ApprovalPluginDispositionV1>
}

interface ApprovalTopologyAttestationV1 {
  readonly version: 1
  readonly dshVersion: '0.1.1-rc.2'
  /** 绑定 Profile manifest、listener graph、preset catalog 与相关 package resolution。 */
  readonly topologyFingerprint: string
  readonly mutablePresetRootsDisabled: true
  readonly presetApprovalListeners: 'none'
}

type TopologyInvalidationReasonV1 =
  | 'profile-manifest-changed'
  | 'preset-catalog-changed'
  | 'listener-registration-attempted'
  | 'package-resolution-changed'
  | 'attestation-drift'

interface ApprovalTopologyLifecycleHooksV1 {
  /**
   * 调用时必须在返回 Promise 前同步把 runtime gate 从 ready/starting 切到 failed；
   * Promise 驱动完整 dispose，并只在 policy contribution 已撤销后 resolve。
   */
  onTopologyInvalidated(reason: TopologyInvalidationReasonV1): Promise<void>
}

interface TerminalApprovalComposerPortV1 {
  /** Profile 对固定 Host 与 Agent Preset listener 拓扑的版本化证明。 */
  readonly topologyAttestation: ApprovalTopologyAttestationV1
  /** Profile 对其固定下游拓扑的静态能力声明；不是 mount-time human port。 */
  readonly supportsHumanDelegation: boolean
  /** v1 只有一个全局自动 policy slot；重复注册必须失败且与加载顺序无关。 */
  registerExclusivePolicy(
    policy: ApprovalPolicyContributionV1,
    lifecycle: ApprovalTopologyLifecycleHooksV1,
  ): AsyncDisposer
}

interface HumanApprovalPortV1 {
  /** 接收同一个 borrowed request；不得二次调用 ctx.approval.request()。 */
  answer(request: ApprovalRequest): Promise<ApprovalOutcome>
}
```

`registerExclusivePolicy()` 必须在同一个 Profile mutation gate 临界区内重新验证 attestation 并原子安装 policy + lifecycle hook：验证失败时不产生 registration；成功返回 disposer 之前不得触发 invalidation callback。之后的受控拓扑变更才能按第 5.3 节撤销该运行期 capability。

v1 不定义 request ownership router，也不试图从 DSH `ApprovalRequest` 不存在的 kind/provider 字段推断范围。自动 policy 挂载期间，每个 request 都进入该 contribution；缺失 callId／capture／能力／存储时按第 8 节显式映射，不能临时“放弃 ownership”落入另一个自动 policy。第二个自动 contribution 在注册期无条件失败。插件卸载并撤销 slot 后，composer 才恢复 profile 的显式 deployment default。未来若需要多个自动 policy，必须新增基于真实 request 字段的闭集声明式 routing contract，不能引入任意 predicate。

### 5.2 composer 的固定映射

```ts
interface HostApprovalResolutionV1 {
  readonly pluginDisposition:
    | 'allow'
    | 'deny'
    | 'delegate-human'
    | 'unavailable'
    | 'cancelled'
  /** 仅当 human port 确实返回合法值时存在。 */
  readonly downstreamOutcome?: ApprovalOutcome
  /** terminal composer 向 ApprovalService 提议返回的值，不冒充权威 decided event。 */
  readonly composerOutcome: ApprovalOutcome
}
```

| Policy disposition | Composer 行为 | `composerOutcome` |
|---|---|---|
| `allow` | 不调用人工 port | `allowed-once` |
| `deny` | 不调用人工 port | `rejected` |
| `unavailable` | 不调用人工 port | `unavailable` |
| `cancelled` | 不调用人工 port | `cancelled` |
| `delegate-human` | 再次检查 signal，调用一次 `HumanApprovalPort.answer(request)` | 人工 port 的合法 outcome |

人工 port 缺失、抛错、返回非法值或调用前 signal 已 aborted 时，分别提议 `unavailable` 或 `cancelled`。`downstreamOutcome` 只在人工 port 实际返回合法值时存在，即使 disposition 已是 `delegate-human`，pre-call abort 也不伪造该字段。

DSH `ApprovalService.decide()` 会把 terminal answerer promise 与 request abort signal 竞速；因此 composer 提议 `allowed-once` 的同时，权威 `approval/decided` 仍可能是 `cancelled`。插件最小记录只保存其在返回前已知的 `pluginDisposition`，不把 `composerOutcome` 或人工结果复制成“最终 DSH outcome”；最终值必须在事后从匹配的 `approval/decided` Session event 读取。

### 5.3 Companion Host Profile 兼容层

`dsh-host-apiproxy` 的 Web answerer 当前不是可注入 service。为了不修改官方插件族，v1 将 **companion Host Profile + thin composer adapter** 作为正式配套设施：

1. Profile 锁定已核验的 DSH 版本和全局 approval listener 图；
2. Profile 禁用运行期可变／用户 preset roots 及 preset HMR，按 fingerprint allowlist 固定全部启用的 Agent Preset composition，并审计其插件不得注册 `approval/request` listener；所有受支持的 Profile／preset／listener mutation API 必须经过 Profile-owned 原子 gate，非法注册在进入 Cordis listener graph 前被拒绝；
3. adapter 由 Profile 持有，生命周期独立于可 HMR 的 Guardian policy；
4. adapter 注册受控的前置 approval listener，并独占 `registerExclusivePolicy()` slot；
5. 在一次 listener 调用内，adapter 把 DSH 借出的 `next` continuation 包装成 request-scoped `HumanApprovalPort.answer(request)`；只有 policy 返回 `delegate-human` 才调用它；
6. 下游只能是该 Profile 已知的 stock Web human listener，不允许 Host sibling 或 preset-scoped listener 插入；
7. policy 未挂载时，adapter 采用 Profile 明确声明的 deployment default，不猜测默认行为。

Topology attestation 必须覆盖 mount 与运行期。Profile mutation gate 在发布任何 preset／listener 变更前重新验证：非法变更直接拒绝且不可见；会使现有 attestation 失效的受控变更必须调用 registration 提供的 `onTopologyInvalidated(reason)`；callback 在返回 Promise 前同步使 policy runtime 原子进入 `failed` 并停止自动 review，其 Promise 驱动完整 dispose，只有在 policy contribution 已撤销后 resolve。mutation gate 必须等待该 Promise，之后才可发布变更。实现不得在等待 dispose 时持有会被 contribution withdrawal 再次获取的非重入 mutex；应先暂存 mutation／预留 topology epoch，以内部 withdrawal 路径完成撤销，同时维持“未发布”屏障。gate 之外任意恶意同进程代码直接操作 Cordis listener graph 不在 v1 受支持安全边界内；若部署不能封闭这类旁路，就不能生成有效 attestation 或宣称支持本产品。

这是**受控 Profile 的版本化兼容桥**，不是对 DSH 普通 sibling listener 顺序的通用保证。核心插件既不接触 `next()`，也不持有 mount-time／global human port；`HumanApprovalPortV1` 是 adapter 在单次 dispatch 内部使用的临时对象。任意第三方 Profile 只有提供等价的 `TerminalApprovalComposerPortV1`、如实声明人工下沉能力并通过本契约验收后才受支持。运行时 continuation 缺失、抛错或返回非法值一律映射为 `unavailable`，不能回退到另一次审批调用。

明确禁止：

- 抓取 host-apiproxy 内部 pending map；
- 复制其 RPC framing；
- 仅凭插件安装顺序宣称任意 Profile 具备 policy priority；
- 允许未锁定的 Agent Preset，或让任一 preset composition 注册普通／prepended `approval/request` listener；
- 让 thin adapter 与 Guardian policy 同时卸载，从而使人工 pending 或新请求落入未定义间隙。

在 companion Profile／adapter 实现并通过真实 Web 验收前，`auto-then-user` 仍必须拒绝挂载，两种 mode 都不能标记为产品验收完成。未来 DSH 若正式公开 callable human port，只替换 Profile adapter，不改变本插件应用层契约。

## 6. 宿主应用端口

```ts
interface CapturedApprovalActionV1 {
  readonly authority: ParentAuthority<unknown, string>
  readonly action: ActionSnapshot
  readonly actionHash: string
  readonly callId: string
  readonly projectorId: string
  readonly argumentSemanticsId: string
}

interface ApprovalActionSourceV1 {
  /** 只能消费与 live request 精确关联、已冻结的 capture。 */
  resolve(request: ApprovalRequest): Promise<CapturedApprovalActionV1 | undefined>
}

interface GuardianDossierCompilerPortV1 {
  compile(input: {
    readonly request: ApprovalRequest
    readonly captured: CapturedApprovalActionV1
    readonly deadlineAt: number
  }): Promise<
    | {
        readonly kind: 'ready'
        readonly verified: SourceVerifiedDossierV1
        readonly metrics: DossierMetricsV1
      }
    | { readonly kind: 'incomplete'; readonly reason: DossierIncompleteReasonV1 }
  >
}

interface ApprovalReviewPacketCodecPortV1 {
  /** attempt identity 确定后才可调用；serialized packet 本身不携带 source brand。 */
  create(input: {
    readonly request: ApprovalReviewRequest
    readonly verified: SourceVerifiedDossierV1
  }): ApprovalReviewPacketV1
}

interface GuardianReviewerPortV1 {
  /** 每次调用必须使用 input.reviewId 对 broker 独立 arm。 */
  review(input: ReviewAttemptInputV1): Promise<ReviewAttemptResultV1>
  rotateContaminated(input: {
    readonly authority: ParentAuthority<unknown, string>
    readonly reviewerSessionId: string
    readonly signal?: AbortSignal
  }): Promise<void>
  interruptParent(parentSessionId: string): void
  drain(): Promise<void>
}

interface DecisionRecordStoreV1 {
  /**
   * create-once；相同字节幂等，冲突 quarantine。
   * 成功只在 durable read-back 确认后返回；不允许“可能已提交”的模糊错误。
   */
  createConfirmed(record: ReviewDecisionRecordV1): Promise<void>
  drain(): Promise<void>
}

interface GuardianCaseCaptureSinkV1 {
  /** best-effort enqueue；不得成为审批完成前置条件。 */
  enqueue(artifact: GuardianCaseArtifactV1): void
  drain(): Promise<void>
}

interface ApproveForMeStorageLifecyclePortV1 {
  /** 只等待已经入队的安全关键 writes，不等待未来事件。 */
  drainSafetyCritical(): Promise<void>
  /** 关闭 adapter 持有的 Storage Domain handle；必须幂等。 */
  close(): Promise<void>
}

interface HostTelemetryPortV1 {
  emit(event: HostTelemetryEventV1): void
}
```

`DossierMetricsV1` 与 verified dossier 同次返回，供宿主基线测量和脱敏 telemetry 使用；它不进入 packet、不能成为 source fact，也不能改变已由编译结果确定的 ready／incomplete 语义。

DSH adapter 必须用 `defineDomain(...)`／`domainTable(...)` 定义 versioned `approve_for_me` spec，再一致地通过 `await ctx.storage.domain.open(spec)`（Storage hub projection）或等价注入别名 `await ctx.storageDomain.open(spec)` 取得 owned Domain handle，并向应用层投影上述窄 repositories／lifecycle port。`ctx.storage.domain` 是 `DomainFacility` 属性，禁止把它误调用成 `ctx.storage.domain(...)`；也不得维护私有 JSON 文件，或向 parent／Reviewer Session 追加本项目未注册的外部 event。打开者负责在安全关键队列 drain 后幂等 `close()` handle。

## 7. Review Run 与 attempt identity

### 7.1 不可变 run

```ts
interface ReviewRunIdentityV1 {
  readonly reviewRunId: string
  readonly parentSessionId: string
  readonly parentLifecycleFingerprint: string
  readonly callId: string
  readonly actionHash: string
  readonly dossierHash: string
  readonly generation: string
  readonly configurationFingerprint: string
  readonly issuedAt: number
  readonly deadlineAt: number
}

interface ReviewAttemptIdentityV1 {
  /** 业务 attempt，v1 只能是 1 或 2。 */
  readonly ordinal: 1 | 2
  /** 每 attempt 唯一，不能复用外层 reviewRunId。 */
  readonly reviewId: string
  readonly reviewerSessionId: string
  readonly generation: string
}

interface ReviewAttemptInputV1 {
  readonly run: ReviewRunIdentityV1
  readonly attempt: ReviewAttemptIdentityV1
  readonly request: ApprovalReviewRequest
  /** 用 attempt request + 同一 verified dossier 经 codec 当次构造。 */
  readonly packet: ApprovalReviewPacketV1
  readonly signal?: AbortSignal
}
```

同一 run 内以下值必须不变：

- exact parent Session lifecycle；
- approval ask／callId；
- action／`actionHash`；
- source-verified dossier／`dossierHash`；
- generation／configuration／route／policy／toolset；
- 总 deadline。

每个业务 attempt 必须使用新的协议 `reviewId`，并绑定实际 Reviewer Session。协调器先复用同一个 `SourceVerifiedDossierV1`，再为已选定的 attempt 构造 `ApprovalReviewRequest`，最后调用 packet codec 生成该 attempt 的普通 `ApprovalReviewPacketV1`；不得复用前一 attempt 的 packet，也不得把 packet-only parse 结果重新标记为 source-verified。旧 attempt 的迟到结果不能满足新 attempt。

### 7.2 污染恢复

污染 child 的恢复属于有界基础设施恢复：

- 最多一次；
- 不延长总 deadline；
- 不改变 generation／configuration／policy／dossier；
- 可以更换 Reviewer Session id；
- 若在 broker arm 前发现，不创建 attempt；
- 若在 arm／deliver 后发现，旧 `reviewId` 必须 tombstone，并记录一次 recovery；选定新 child 后必须生成新的 `reviewId`、`ApprovalReviewRequest` 和 packet，只有成功交付到干净 child 后才计入业务 attempt ordinal。

```ts
interface ReviewerRecoveryRecordV1 {
  readonly ordinal: number
  readonly kind: 'contaminated-child'
  readonly reviewerSessionId: string
  readonly discardedReviewId?: string
  readonly generation: string
  readonly occurredAt: number
}
```

这些记录按发生顺序进入默认 `ReviewDecisionRecordV1.recoveries`，full capture 时还必须与 `GuardianCaseArtifactV1.recoveries` canonical 相等；best-effort telemetry 不能替代持久审计。

### 7.3 允许重试的结果

```ts
type ReviewAttemptResultV1 =
  | { readonly kind: 'decision'; readonly decision: ApprovalDecision }
  | {
      readonly kind: 'retryable-failure'
      readonly code:
        | 'provider-unavailable'
        | 'network'
        | 'rate-limited'
        | 'model-error'
        | 'no-tool-call'
        | 'schema-invalid-repairable'
    }
  | {
      readonly kind: 'terminal-failure'
      readonly code: HostDecisionCodeV1
    }
```

仅 retryable failure 且仍有 attempt budget／deadline 时可进入下一 attempt。以下情况不得重试：

- 明确 `deny` 或 `human_review`；
- request／Reviewer／generation／hash identity mismatch；
- sidecar／approval snapshot／source integrity conflict；
- policy／schema／catalog version conflict；
- deadline 到期；
- parent signal abort；
- host draining／disposed。

原则是：**只重试传输和表达失败，不重试已经形成的安全判断。**

## 8. 审批错误分类与模式映射

```ts
type DossierIncompleteReasonV1 =
  | 'unsupported-tool'
  | 'projection-unavailable'
  | 'budget-overflow'
  | 'source-fact-missing'
  | 'unsupported-delegated-requester'
  | 'unclassified-tool'
  | 'version-mismatch'
  | 'source-integrity-conflict'

type HumanRecoveryReasonV1 =
  | 'guardian-human-review'
  | 'unsupported-capability'
  | 'reviewer-unavailable'
  | 'attempts-exhausted'
  | 'deadline'
  | 'decision-record-unavailable'
  | 'host-draining'

type HostDecisionCodeV1 =
  | 'guardian-deny'
  | 'guardian-human-review'
  | 'request-aborted'
  | 'host-not-ready'
  | 'host-disposed'
  | 'unsupported-capability'
  | 'reviewer-unavailable'
  | 'attempts-exhausted'
  | 'deadline'
  | 'decision-record-unavailable'
  | 'authority-mismatch'
  | 'unsupported-delegated-requester'
  | 'action-hash-mismatch'
  | 'reviewer-identity-mismatch'
  | 'generation-mismatch'
  | 'source-integrity-conflict'
  | 'protocol-invalid'
  | 'policy-version-mismatch'
  | 'late-result'
```

权威映射：

| 条件 | `auto` | `auto-then-user` |
|---|---|---|
| Guardian `allow` + 最小记录 durable | `allow` | `allow` |
| Guardian `deny` | `deny` | `deny` |
| Guardian `human_review` | `deny` | `delegate-human` |
| unsupported tool／projection／budget／非冲突性 fact 缺失 | `unavailable` | `delegate-human` |
| provider／model／transport 暂时故障或 attempts 耗尽 | `unavailable` | `delegate-human` |
| deadline 到期且 request 仍活跃 | `unavailable` | `delegate-human` |
| 自动 allow 的最小记录写入失败 | `unavailable` | `delegate-human` |
| starting／draining／正常 unload，request 仍活跃 | `unavailable` | `delegate-human` |
| parent Stop／Abort | `cancelled` | `cancelled` |
| authority／Session／Reviewer／generation／hash mismatch | `unavailable` | `unavailable` |
| sidecar／snapshot／source／policy 完整性冲突 | `unavailable` | `unavailable` |
| forged／late／duplicate／无法关联结果 | `unavailable` | `unavailable` |

`human_review` 在 `auto` 中是明确拒绝，不是 `unavailable`；身份／完整性冲突在 `auto-then-user` 中也不得交给可能放行的人工 port。

## 9. 精确拒绝熔断

首期不定义通用动作语义等价。

```ts
interface ExactDenialBreakerKeyV1 {
  readonly parentLifecycleFingerprint: string
  readonly turn: number
  readonly directUserFrontierSeq: number
  readonly actionHash: string
}

interface ExactDenialBreakerV1 {
  lookup(key: ExactDenialBreakerKeyV1): boolean
  recordGuardianDeny(key: ExactDenialBreakerKeyV1): void
  clearParent(parentLifecycleFingerprint: string): void
}
```

只有 Guardian 明确 `deny` 建立 entry。命中时：

- 跳过 Guardian；
- 仍让 DSH 为当前请求形成新的 `approval/asked → rejected → approval/decided`；
- 不复用旧 `callId`；
- 永不映射为 allow。

以下情况不建立／不命中：

- `human_review` 或人工结果；
- `unavailable`、timeout、abort、unload；
- 不同 `actionHash`；
- 新直接用户消息 frontier；
- 下一 turn；
- 新 parent lifecycle。

命令改写、目标重叠、跨工具族关系、EffectKey 和“更安全替代”全部属于未来优化，不是 v1 实现或验收目标。

## 10. Host 生命周期

```ts
type ApproveForMeHostStateV1 =
  | 'starting'
  | 'ready'
  | 'draining'
  | 'disposed'
  | 'failed'

interface ApproveForMeHostRuntimeV1 {
  readonly state: ApproveForMeHostStateV1
  start(): Promise<void>
  dispose(): Promise<void>
}
```

状态规则：

| State | 新 `auto` 请求 | 新 `auto-then-user` 请求 |
|---|---|---|
| `starting` | `unavailable` | `delegate-human` |
| `ready` | 正常自动 policy | 正常自动 policy |
| `draining` | `unavailable` | `delegate-human` |
| `failed` | `unavailable` | `delegate-human` |
| `disposed` | contribution 已撤销；composer 使用 Profile deployment default | contribution 已撤销；composer 使用 Profile deployment default |

合法转换只有：

```text
starting → ready
starting → failed
ready → failed
starting | ready | failed → draining → disposed
```

`failed` 表示 gate 注册后出现了使正确自动裁决不再可能的启动故障或运行期 fatal invariant breach。fatal 通知必须同步原子切换 state、停止接收新的自动 review 并作废 pending result channels；随后由单一异步 cleanup task best-effort 撤销已安装的 provider／capture hooks、interrupt Reviewer、drain 已入队安全关键写入及关闭已打开的 Storage Domain handle；**policy gate 保持注册**，所以新请求仍按上表明确失败或有限下沉，而不会意外落回 deployment default。Topology invalidation 路径还必须立即调用幂等 `dispose()`，依次经过 `failed → draining → disposed`；在 contribution 最终撤销前，Profile mutation gate 持续阻止拓扑变更公开。`draining → failed` 非法；dispose 期间的清理错误必须聚合报告，但不得重新开放自动裁决。

`dispose()` 可从 `starting`、`ready` 或 `failed` 调用并统一经过 `draining`；从 `failed` 调用时重复清理和 close 必须幂等。`start()` 失败后 runtime 仍由 companion Cordis effect 持有并必须 dispose，不能因启动 promise 失败遗失 gate disposer。

挂载顺序：

```text
validate config + artifacts
→ verify locked Profile/preset topology attestation
→ obtain terminal composer and validate supportsHumanDelegation when required
→ register state-aware policy gate + synchronous topology-invalidation hook as starting; immediately bind its disposer to the owning effect
→ open Storage Domain / reconcile case quota
→ register Managed Reviewer provider
→ install action/fact capture hooks
→ state = ready
```

其中不存在挂载期 `HumanApprovalPort`：adapter 只在未来某次 `approval/request` listener 调用内从该 dispatch 的 `next` 构造并消费它。

卸载／HMR顺序：

```text
state = draining（gate 仍注册）
→ 停止接受新的自动 review
→ 当前 auto run settle unavailable；auto-then-user policy 在 signal 活跃时返回 delegate-human
→ disarm/tombstone pending result channels
→ interrupt/drain Reviewer
→ drain 已入队安全关键 fact / decision-record writes
→ 撤销 provider、capture hooks、decision tool ownership
→ 等待仅由插件拥有的 policy/review/record 调用 settle
→ 最后撤销 policy contribution
→ best-effort drain case capture / telemetry
→ 幂等 close owned Storage Domain handle
→ state = disposed
```

不变量：

- `dispose()` 与 Storage Domain `close()` 幂等；
- policy 一旦返回 `delegate-human`，该插件调用和 in-flight 计数立即结束；后续 Web／ACP 人工 promise 由 profile composer 独占，可在插件卸载后继续 pending，插件 disposer 永不等待它；
- pending `reviewId`／result channel 不跨 reload 恢复；
- reload 后旧 result 永远是 late／unknown；
- 旧 Reviewer child 保持 provider guard，不因插件卸载获得新输入；
- case capture drain 不能成为 approval completion 前置条件；
- 安全关键 write queue 必须 drain，telemetry 可丢失。

## 11. 持久化与案例留存

Storage Domain 固定为 `approve_for_me`。v1 使用四类逻辑表：

| Table | 内容 | 是否影响自动 allow |
|---|---|---|
| `executions` | pre-execute action projection、durable-result join、safe receipt | 是 |
| `approval_snapshots` | 每次 ask 的 immutable environment snapshot | 是 |
| `review_records` | 默认最小决策记录 | 自动 allow 前必须 durable |
| `case_artifacts` | opt-in 完整 packet／policy／attempt 结果 | 否 |

权威 schemas、key、hash、quota、TTL、GC 和隐私规则见卷宗规范第 12、13.4 节。宿主只额外规定提交顺序：

```text
得到 terminal Guardian result／plugin disposition
→ 构造不冒充 DSH final outcome 的最小 ReviewDecisionRecordV1
→ 将 record createConfirmed 放入安全关键队列
→ 若 disposition 将自动 allow：等待 durable read-back 确认
   ├─ 成功：可向 composer 返回 allow
   └─ 明确确认未提交：不留下该 record，auto unavailable；auto-then-user 可有限人工恢复
→ deny／delegate-human／unavailable／cancelled 不因 record 故障改变
→ 若 full capture：独立 best-effort enqueue GuardianCaseArtifactV1
→ policy 返回 disposition；profile composer 后续完成人工调用和 composerOutcome
→ 权威 final DSH outcome 只从匹配的 approval/decided Session event 读取
```

完整案例：

- 默认关闭；
- 保存 Guardian 实际接受的 canonical packet、fingerprint-bound policy artifact 和闭集结构化结果；
- 不保存 provider headers、凭据、stack、raw malformed body、隐藏 reasoning 或 child transcript；
- host-private，不进入普通 Web API、Session export、telemetry、Git 或 fixture；
- exact parent 删除时 cascade，fork 不继承；
- 显式导出必须脱敏、secret scan、人工确认；
- artifact 丢失不改变历史审批或 parent Session 恢复。

## 12. 并发与顺序

```ts
interface ParentReviewLanesV1 {
  run<T>(parentLifecycleFingerprint: string, task: () => Promise<T>): Promise<T>
  drain(): Promise<void>
}
```

- 同一 parent lifecycle 的完整 run 串行；
- 不同 parent lifecycle 可以并行；
- 串行边界覆盖 action resolve、dossier freeze、Reviewer attempts、最小记录和 plugin disposition；profile-owned 人工等待不占用插件 lane；
- case capture／telemetry 不占用 approval lane；
- DSH 当前默认敏感工具通常按 exclusive 调度，但插件不能把这一实现现象当作自身互斥保证。

## 13. Telemetry

```ts
type HostTelemetryEventV1 =
  | {
      readonly kind: 'review-completed'
      readonly reviewRunId: string
      readonly dossierHash: string
      readonly actionHash: string
      readonly attempts: number
      readonly durationMs: number
      readonly pluginDisposition: ApprovalPluginDispositionV1['kind']
    }
  | {
      readonly kind: 'review-failed'
      readonly stage: string
      readonly code: HostDecisionCodeV1
    }
  | {
      readonly kind: 'case-capture-skipped'
      readonly code: 'disabled' | 'oversize' | 'quota' | 'storage' | 'parent-deleted'
    }
  | {
      readonly kind: 'reviewer-rotated'
      readonly reason: 'contaminated-child' | 'generation-change'
    }
```

Telemetry：

- 不含 packet、对话、工具参数、rationale、provider body 或 Session transcript；
- 写入失败不得改变审批；
- id／hash 是 pseudonymous audit data，仍须遵守访问控制；
- 指标不能成为 source fact 或授权依据。

## 14. Cordis composition root

该 composition root 由 companion Host Profile 提供。Host Profile 负责 Host-plane Cordis 服务和进程稳定的 listener 生命周期。Agent Preset 是 agent-scoped Cordis composition，虽然可以包含特权插件，但其 scope 与发布约束不能拥有或向 Host consumers 提供这里的 exclusive 全局审批拓扑，因此不能替代 companion Profile。

目标安装接口：

```ts
interface InstallApproveForMeOptionsV1 {
  /** 包含 topology attestation 与静态 supportsHumanDelegation；不包含 request-scoped human port。 */
  readonly terminalComposer: TerminalApprovalComposerPortV1
  readonly projectPermissions?: unknown
  readonly telemetry?: HostTelemetryPortV1
}

interface InstalledApproveForMeV1 {
  readonly runtime: ApproveForMeHostRuntimeV1
  dispose(): Promise<void>
}

function installApproveForMeV1(
  ctx: unknown,
  config: ApproveForMeHostConfigV1,
  options: InstallApproveForMeOptionsV1,
): Promise<InstalledApproveForMeV1>
```

实现可继续以 Cordis `apply()`／`ctx.effect()` 为外壳，但必须满足：

- config 先验证，非法配置不产生半挂载 provider；
- composer、topology attestation、mutation gate 与 invalidation hook 是代码级 capability，不序列化；request-scoped human port 不进入安装接口；
- effect disposer 遵循第 10 节顺序；
- 运行期 Adapter 不向 Domain 层泄漏 Cordis／DSH 类型；
- 当前 `approval-answerer.ts` 应迁移为 `ApprovalPolicyContributionV1` adapter，而不是继续注册独立 global sibling answerer。

## 15. 当前代码差距

截至本文定稿，仓库已有：

- ActionSnapshot／`actionHash`；
- pre-execute capture；
- Decision channel 身份、deadline、abort、tombstone；
- per-parent lane；
- Managed Reviewer create／reuse／pollution rotation；
- 基础 Cordis disposer；
- 82 项通过的协议／adapter／application 测试。

尚待实现：

1. companion Host Profile 与稳定 thin composer adapter（含 request-scoped `HumanApprovalPort` 兼容桥）；
2. state-aware policy gate 和严格 drain 顺序；
3. source-backed dossier compiler／Storage Domain fact adapters；
4. 两次业务 attempts 与闭集错误分类；
5. 精确 `actionHash` breaker；
6. `review_records`／`case_artifacts` repositories；
7. 指标与真实 stock profile 验收。

因此本文是施工和验收契约，不表示上述能力已经存在。

## 16. 最低验收条件

实现至少必须证明：

1. companion Host Profile 固定已核验的 DSH 版本、Host listener 图和 Agent Preset catalog，禁用可变 preset roots；普通与 prepended preset-scoped approval listener 的注册在公开前被 mutation gate 拒绝；受控拓扑失效先触发 `onTopologyInvalidated`，在其 Promise 返回前同步进入 failed，并等待该 Promise 完成 dispose／撤销 contribution 后才发布变更；通过 attestation 后只有一个自动 policy slot，第二个 contribution 无论加载顺序都注册失败；
2. thin adapter 独立于 Guardian HMR，挂载期只暴露真实的 `supportsHumanDelegation` 声明；`auto-then-user` 在每次 dispatch 内使用 exact borrowed request 调用一次 request-scoped human port；
3. 所有映射矩阵分支都得到固定 outcome，任何未知值 fail closed；
4. identity／hash／generation／source conflict 永不进入人工可放行路径；
5. 一个 run 最多两个业务 attempts、一个总 deadline、每 attempt 唯一 `reviewId`，且 packet request 与实际 Reviewer Session 精确一致；
6. 污染恢复的 discarded identity 按序进入最小记录，不能只存在于 telemetry；
7. late／duplicate／旧 generation result 不能满足当前 pending；
8. 同 parent 串行、跨 parent 并行；
9. 精确 breaker 只命中同 lifecycle／turn／user frontier／`actionHash` 的 Guardian deny；
10. 自动 allow 在安全 facts 和最小记录 durable 前不生效；
11. case capture 默认关闭，quota／TTL／GC 确定，失败不改变审批；
12. composer／abort 竞速以 `approval/decided` 为权威，record/artifact 不伪造 final outcome；
13. starting／failed／draining／dispose／abort／reload race 全部有对抗测试，包括 startup 与 runtime fatal 进入 failed、gate 保持注册，以及 `dispose(failed) → draining → disposed`；delegated 人工 pending 不阻塞插件 unload；
14. Storage Domain handle 在安全队列 drain 后幂等关闭，HMR 不泄漏 ownership；
15. 未修改的 stock DSH packages + companion Host Profile 在 cold resume、HMR、Web human bridge 和卸载流程中通过真实验收；任意未知 Profile 不自动继承该结论。

## 17. 版本演进

以下变化必须升级 host contract 或明确兼容规则：

- 增加新的自动 grant 种类；
- 改变人工恢复边界；
- 增加超过两个 attempts 或独立 attempt deadline；
- 引入语义等价熔断；
- 允许 pending 跨 reload 恢复；
- 改变 record/case retention 生命周期；
- 把 companion Profile 的受控 continuation bridge 扩大成任意 sibling ordering 的隐式 policy priority；
- 让 Reviewer route 自动 fallback。

v1 实现不得以“优化”为名静默改变这些安全语义。
