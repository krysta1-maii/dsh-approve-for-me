# Approve-for-me 宿主接口与生命周期契约（v2：机器决策槽）

> 状态：2026-08-28，**宿主设计 v2 候选契约**。v2 只 patch 官方 `@deepseek-ai/dsh-user-approval`，增加 `ApprovalRequestEvent.requestId` 与 `ApprovalService.registerMachinePolicy()`；机器裁决在 `never` 之后、`approval/request` waterfall 之前执行，拥有与 listener 顺序无关的确定性优先级。已废弃的 v1 companion Host Profile／thin composer adapter／mutation gate／attestation 方案见 [archive/README.md](archive/README.md) 与旧版契约。
>
> 本文定义 `dsh-approve-for-me` 的审批组合、裁决映射、Review Run、生命周期、持久化与失败关闭边界。当前仓库尚未实现本文全部接口；已实现骨架与待迁移项见 [implementation.md](implementation.md)。Guardian 材料本身由 [Guardian 案件卷宗接口与编译规范](guardian-dossier.md) 定义，文档权威顺序见 [文档地图](README.md)。

## 1. 定稿范围与固定决策

v2 已固定：

1. 官方 patch 只改 `dsh-user-approval` 一个包：`requestId` + `registerMachinePolicy()`；未注册机器策略时行为与上游完全一致；
2. 机器决策先于任何交互式 answerer，任何 `prepend` listener 都无法抢答；`never` 仍先于机器决策；
3. `'delegate'` 表示显式下沉：请求继续走官方 waterfall（`api-remotes → client/ui-approval` 为 Web 人工通道）；本体不接触 `next()` 之外的私有实现；
4. 自动 allow 只可能来自身份/事实校验通过的确定性结果或 Guardian 裁决；
5. 同一 parent lifecycle 串行，不同 parent 可并行；一个 Review Run 一个总 deadline、最多两个业务 attempts；
6. 自动 allow 依赖的最小事实强持久化，telemetry 尽力写入；
7. 默认只保存最小决策记录，完整案例显式 opt-in；
8. Reviewer route、generation、policy、toolset 显式固定，不继承主 Agent，也不静默切换；
9. pending approval 不跨 unload／reload 恢复。

## 2. DSH 执行位置（patched）

```text
模型产生 tool call / run_code 嵌套 dispatch
→ tools/pre-execute：动作快照 + 审批行为分类（ordinary/gate-ask/body-escalation）
→ DSH 持久化 assistant/message + tool/call
→ 需要审批的路径调用 ctx.approval.request()
→ patched ApprovalService.request() 持久化 approval/asked（带 id）
→ ApprovalService.decide()
   ├─ effectivePolicy === 'never' → rejected（先于机器策略）
   ├─ 逐个 machinePolicy.decide(req)：
   │     非 'delegate' 的合法 outcome → 认领；异常/非法值 → unavailable
   └─ 全部 'delegate' → approval/request waterfall → Web/ACP answerers
→ DSH 持久化 approval/decided
→ 只有 allowed-once 才执行工具副作用（bash/fs/pwsh body 内二次 ask 同样经机器策略重放）
```

因此 `approval/request` listener 顺序不再承载任何自动授权安全语义；它只承载 `'delegate'` 之后的人工/机器交互链。

## 3. 官方 patch 契约

```ts
// patch/dsh-user-approval overlay 的实际增量语义
interface ApprovalRequestEvent {
  readonly agent: Agent
  readonly toolName: string
  /** 服务派发的每个请求都存在；等于 approval/asked.id。 */
  readonly requestId?: ApprovalRequestId
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly signal?: AbortSignal
}

type MachineApprovalDecision = ApprovalOutcome | 'delegate'

interface MachineApprovalPolicy {
  readonly id: string
  decide(request: ApprovalRequestEvent): Promise<MachineApprovalDecision>
}

class ApprovalService {
  registerMachinePolicy(policy: MachineApprovalPolicy): () => void
}
```

语义表：

| 情况 | 结果 |
|---|---|
| `never` 生效 | 不调用机器策略，直接 `rejected` |
| 机器策略返回 `allowed-once/rejected/cancelled/unavailable` | 认领请求，waterfall 不执行 |
| 机器策略返回 `'delegate'` | 继续下一机器策略，之后进入 waterfall |
| 机器策略抛错或返回非法值 | 当前请求 fail-closed `unavailable` |
| 重复 `id` 注册 | 抛错 |
| disposer 调用后 | 该策略不再参与；行为恢复上游 |

## 4. 插件 Loader 配置

```ts
interface ApproveForMeHostConfigV2 {
  readonly mode?: 'auto' | 'auto-then-user'
  /** 整个 Review Run 的总 deadline。 */
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
  readonly caseCapture?: GuardianCaseCaptureConfigV1
}
```

挂载前必须验证：config 合法；policy/schema/catalog 可解析；`trustEnvelope` 闭集配置合法；`dshApprovalPatch` 标记存在且 `patchVersion` 兼容（否则拒绝挂载）；依赖插件 `ctx.managedAgents` 可用。

## 5. 裁决管线与模式映射

本体机器策略内部顺序：

```text
1. 身份校验：requestId、callId、exact live agent、actionHash、分类
   任一冲突/缺失 → unavailable（两种 mode 都不下沉）
2. deny breaker 命中 → rejected
3. trustEnvelope 命中 → 最小记录 durable 后 allowed-once
4. allow-cache 命中 → allowed-once
5. Guardian 裁决（Review Run）
6. 映射：
   allow        → allowed-once
   deny         → rejected
   human_review → auto: rejected；auto-then-user: delegate
   retryable/能力不足 → auto: unavailable；auto-then-user: delegate
   deadline/abort → cancelled/unavailable（见状态机）
```

权威映射：

| 条件 | `auto` | `auto-then-user` |
|---|---|---|
| Guardian `allow` + 最小记录 durable | `allowed-once` | `allowed-once` |
| Guardian `deny` | `rejected` | `rejected` |
| Guardian `human_review` | `rejected` | `delegate` |
| 非冲突性能力不足（工具/投影/预算/transport 暂障/attempts 耗尽） | `unavailable` | `delegate` |
| 身份、hash、generation、source、policy 冲突或伪造/迟到结果 | `unavailable` | `unavailable` |
| 记录写入冲突/quarantine | `unavailable` | `unavailable` |
| 记录写入瞬时不可用（自动 allow 前置） | `unavailable` | `delegate` |
| parent Stop/Abort | `cancelled` | `cancelled` |

身份/完整性冲突在 `auto-then-user` 中也不得交给可能放行的人工 port。

## 6. Review Run 与 attempts

沿用 v1 身份规则（已在此固化，不重复全文）：

```ts
interface ReviewRunIdentityV2 {
  readonly reviewRunId: string
  readonly requestId: string            // approval/asked.id，v2 新增精确绑定
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
```

- 一个 Run 一个总 deadline，最多两个业务 attempts；
- 污染恢复属于基础设施恢复：最多一次、不延长 deadline、不改变 dossier/route/policy/generation；discarded `reviewId` 按序进入 recoveries；
- 只重试传输/表达失败（provider-unavailable/network/rate-limited/model-error/no-tool-call/schema-invalid-repairable）；明确 deny/human_review、身份冲突、deadline、abort、draining 不重试；
- 旧 attempt 的迟到结果不能满足新 attempt；pending 不跨 reload。

## 7. trustEnvelope 与 breaker

- `trustEnvelope` 是确定性快路径：闭集工具族、`maxRequestedMode`、workspace 边界、justification、严格阶梯变宽全部满足才允许；默认关闭。
- `deny breaker`：只有同 parent lifecycle/turn/direct-user-frontier/`actionHash` 的 Guardian deny 建立 entry；命中返回 `rejected`，永不 allow。
- `allow-cache`（v1.1）：同 session + 同 `actionHash` + 同配置指纹/generation + 用户 frontier 未变的既往 Guardian allow 可复用；新直接用户消息、配置或代际变化即失效；丢失缓存最多多一次裁决。
- 语义等价、跨工具绕过、目标重叠均不属于 v2 验收目标。

## 8. Host 生命周期

```ts
type ApproveForMeHostStateV2 = 'starting' | 'ready' | 'draining' | 'disposed' | 'failed'
```

| State | 机器策略行为 |
|---|---|
| `starting` | `unavailable`；auto-then-user 且 request 活跃时 `delegate` |
| `ready` | 正常裁决 |
| `draining` | 同上（gate 保持注册直到 contribution 撤销） |
| `failed` | `unavailable`（拓扑已不可信时不 delegate） |
| `disposed` | 机器策略已注销；交互链由 Profile 显式 default 决定，且 default 不得包含机器自动 grant |

合法转换：`starting → ready | failed`；`starting|ready|failed → draining → disposed`。卸载顺序：停止新 review → settle in-flight → tombstone pending → interrupt/drain Reviewer → drain 安全关键写入 → 撤销 capture/provider → 最后撤销 machine policy 注册。

## 9. 持久化与案例留存

Storage Domain 固定 `approve_for_me`：

| Table | 内容 | 影响自动 allow |
|---|---|---|
| `executions` | pre-execute action projection、durable-result join、safe receipt | 是 |
| `approval_snapshots` | 每次 ask 的 immutable environment snapshot（含 requestId） | 是 |
| `review_records` | 默认最小决策记录 | 自动 allow 前必须 durable |
| `case_artifacts` | opt-in 完整 packet／policy／attempt 结果 | 否 |

记录不复制 `HumanApprovalPort` 返回值；权威 final outcome 从匹配的 `approval/decided` 读取。schema、key、quota、TTL、GC 与隐私规则见卷宗规范第 12、13.4 节。

## 10. 并发与 telemetry

- 同一 parent lifecycle 串行，跨 parent 并行；
- 串行边界覆盖 capture 解析、dossier freeze、attempts、最小记录与 disposition；delegate 后的人工等待不占 lane；
- telemetry 尽力写入，失败不改变裁决；不含 packet、对话、参数、rationale、provider body 或 transcript。

## 11. Cordis composition root

```ts
function apply(ctx: Context, config: ApproveForMeHostConfigV2): void {
  // ctx.effect 拥有：capture hooks → machine policy 注册 disposer →
  // managed reviewer provider → storage handle close
}
```

- 非法 config 不产生半挂载；
- 注册 `registerMachinePolicy({ id: 'dsh-approve-for-me/v1', decide })` 必须在任何 reviewer provider 之前完成；
- disposer 遵循第 8 节顺序；`dsh-managed-agent` 通过 `ctx.managedAgents` 注入，作为 peer 依赖安装；
- 运行期 adapter 不向 domain 层泄漏 Cordis/DSH 类型。

## 12. 当前代码差距

已就位：patch 包结构（overlay/构建/校验/测试）、`src/approval-gate` 端口骨架、原 0.1.1-rc.2 的 channel/lanes/directory/provider/decision-tool 骨架。

尚待：0.1.2 迁移；机器策略 adapter 与管线实现；trustEnvelope/breaker/allow-cache；dossier compiler；记录/案例；真实验收。

## 13. 最低验收条件

1. fork tarball 校验通过：原名同版本、`dshApprovalPatch` 标记、lib 含 `registerMachinePolicy`/`requestId`；
2. 机器策略先于任何 prepend `approval/request` listener；`never` 先于机器策略；异常/非法值 fail-closed；disposer 生效；
3. 身份/完整性冲突在两种 mode 都不 delegate；
4. 一个 Run 最多两个业务 attempts、一个总 deadline、requestId 精确绑定 asked/decided；
5. trustEnvelope 命中/未命中与 breaker 的边界全部有对抗测试；
6. 自动 allow 在最小记录 durable 前不生效；记录冲突不 delegate；
7. starting/draining 的 delegate 只在 request 活跃时发生；failed 不 delegate；dispose 后 Profile default 无自动 grant；
8. 卸载/重载/Abort/污染轮换/迟到结果全部 fail-closed；
9. 真实 0.1.2 Web Profile：长程 soak 包络内 0 人工、0 误放行；人工下沉到达 ui-approval；
10. patch 能对锁定 commit 可复现构建，上游版本变化时构建脚本拒绝错误 commit。

## 14. 版本演进

以下变化必须升级 host contract：

- 增加自动 grant 种类或扩大 trustEnvelope 语义；
- 改变人工恢复边界或 machine policy 优先级语义；
- 超过两个 attempts 或独立 attempt deadline；
- 引入语义等价熔断或跨工具绕过识别；
- 允许 pending 跨 reload 恢复；
- 让 Reviewer route 自动 fallback；
- 官方合并 patch 后移除 fork tarball 交付。
