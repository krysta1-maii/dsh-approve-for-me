# Approve-for-me 宿主接口与生命周期契约

> 状态：2026-08-28，**宿主设计 v1 初步定稿／候选实现契约**。
>
> 本文定义 `dsh-approve-for-me` 在 DSH Host 中的组合接口、审批映射、Review Run、生命周期、持久化和失败关闭边界。当前仓库尚未实现本文全部接口；已实现骨架与待迁移项见 [implementation.md](implementation.md)。Guardian 材料本身由 [Guardian 案件卷宗接口与编译规范](guardian-dossier.md)定义。

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

唯一尚未落地、但接口边界已经确定的外部前置条件是 **terminal approval composer／human port**：DSH `0.1.1-rc.2` 的 Web 人工审批位于 `dsh-host-apiproxy` private sibling listener 中，没有公开可调用的 `HumanApprovalPort`。真实 Web profile 必须先由正式 Host/profile seam 提供本契约所需组合能力；本插件不得读取 private pending registry、复制 Web wire protocol 或继续用 `{ prepend: true } + next()` 冒充产品级优先级。

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
- `auto-then-user` 已取得 terminal composer 和 `HumanApprovalPort`；
- policy／decision schema／tool classification catalog 可解析且版本兼容。

DSH model selection 当前不验证 provider/model catalog 存在性。语法合法但不存在或暂不可用的 route 在 materialize／request 阶段成为 Reviewer 能力故障；不得静默改用其他模型。

## 5. Profile-owned terminal approval composer

### 5.1 外部组合端口

composer 是 profile 中唯一直接向 DSH `approval/request` 返回 answerer proposal 的 terminal answerer。插件只占用一个全局自动 policy slot；DSH 竞速后记录的 `approval/decided` 才是权威 outcome。

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

interface TerminalApprovalComposerPortV1 {
  /** v1 只有一个全局自动 policy slot；重复注册必须失败且与加载顺序无关。 */
  registerExclusivePolicy(policy: ApprovalPolicyContributionV1): AsyncDisposer
}

interface HumanApprovalPortV1 {
  /** 接收同一个 borrowed request；不得二次调用 ctx.approval.request()。 */
  answer(request: ApprovalRequest): Promise<ApprovalOutcome>
}
```

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

### 5.3 当前 DSH 前置缺口

`dsh-host-apiproxy` 的 Web answerer 当前不是可注入 service。v1 接受的实现路径只有：

1. DSH／Host 正式暴露 callable human approval port；或
2. profile-owned composer 同时拥有正式的人工作答能力。

在此之前：

- 不得抓取 host-apiproxy 内部 pending map；
- 不得复制其 RPC framing；
- 不得声称 sibling prepend 顺序等于 policy chain；
- `auto-then-user` 必须拒绝挂载；
- 两种 mode 都不能标记为已通过 stock Web profile 产品验收。

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
    | { readonly kind: 'ready'; readonly verified: SourceVerifiedDossierV1 }
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

DSH adapter 必须用 `defineDomain(...)`／`domainTable(...)` 定义 versioned `approve_for_me` spec，再通过 `await ctx.storageDomain.open(spec)` 取得 owned Domain handle，并向应用层投影上述窄 repositories／lifecycle port。不得调用不存在的 `ctx.storage.domain(...)`、维护私有 JSON 文件，或向 parent／Reviewer Session 追加本项目未注册的外部 event。打开者负责在安全关键队列 drain 后幂等 `close()` handle。

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
| `disposed` | contribution 已撤销；composer 使用部署默认 terminal | contribution 已撤销 |

挂载顺序：

```text
validate config + artifacts
→ obtain terminal composer (+ human port when required)
→ register state-aware policy gate as starting
→ open Storage Domain / reconcile case quota
→ register Managed Reviewer provider
→ install action/fact capture hooks
→ state = ready
```

卸载／HMR 顺序：

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

目标安装接口：

```ts
interface InstallApproveForMeOptionsV1 {
  readonly terminalComposer: TerminalApprovalComposerPortV1
  readonly humanApproval?: HumanApprovalPortV1
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
- composer/human port 是代码级 capability，不序列化；
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

1. profile terminal composer seam 与 callable `HumanApprovalPort`；
2. state-aware policy gate 和严格 drain 顺序；
3. source-backed dossier compiler／Storage Domain fact adapters；
4. 两次业务 attempts 与闭集错误分类；
5. 精确 `actionHash` breaker；
6. `review_records`／`case_artifacts` repositories；
7. 指标与真实 stock profile 验收。

因此本文是施工和验收契约，不表示上述能力已经存在。

## 16. 最低验收条件

实现至少必须证明：

1. profile 只有一个 terminal composer／全局自动 policy slot；第二个 contribution 无论插件加载顺序都注册失败；
2. `auto-then-user` 使用 exact borrowed request 调用一次显式 human port；
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
13. starting／draining／dispose／abort／reload race 全部有对抗测试，delegated 人工 pending 不阻塞插件 unload；
14. Storage Domain handle 在安全队列 drain 后幂等关闭，HMR 不泄漏 ownership；
15. stock DSH profile、cold resume、HMR、Web human port 和卸载流程通过真实验收。

## 17. 版本演进

以下变化必须升级 host contract 或明确兼容规则：

- 增加新的自动 grant 种类；
- 改变人工恢复边界；
- 增加超过两个 attempts 或独立 attempt deadline；
- 引入语义等价熔断；
- 允许 pending 跨 reload 恢复；
- 改变 record/case retention 生命周期；
- 从 sibling ordering 恢复隐式 policy priority；
- 让 Reviewer route 自动 fallback。

v1 实现不得以“优化”为名静默改变这些安全语义。
