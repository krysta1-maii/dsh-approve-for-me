# dsh-approve-for-me 施工计划

> 制定基线：2026-08-24  
> DSH 基线：`0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`  
> Managed Runtime 基线：`dsh-managed-agent` `878bf45`（contract 包现为 `0.1.0-dev.0`）  
> 本文重点是抽象、组件关系、接口与施工顺序。具体安全加固、错误文案和穷举式 fail-closed 分支属于各阶段的工程验收，不作为架构主线。

> 状态（2026-08-25）：Phase 0–4 已施工完成并提交（真实契约消费、可序列化 Config、应用层重构、真实 Reviewer provider、真实 DSH hooks），`npm run check` 全绿（70 项测试）。Phase 5 的 patched-DSH 运行时集成与 Phase 6 的 policy 产品化尚未执行，验收清单见第 10–11 节与 [integration.md](integration.md)。

## 1. 施工目标

本项目要实现的不是一个独立 Agent Runtime，而是一个 DSH 业务插件：

1. 在 DSH 的 `approval/request` waterfall 中增加自动 Reviewer answerer；
2. 为每个父 Session 按插件策略管理一个持久 Reviewer child；
3. 通过 `dsh-managed-agent` 增加的 `ctx.subagents.registerManagedProvider()` 控制 Reviewer；
4. 通过 Reviewer scope 内的结构化工具取得审批结果；
5. 继续使用 DSH 原生 Agent、Session、模型路由、工具系统、审批审计、持久化和 Web 子代理树。

施工完成后的职责边界必须保持为：

```text
DSH / dsh-managed-agent                  dsh-approve-for-me
──────────────────────────────────────  ────────────────────────────────
Agent / Session / inbox                 审批请求与决定协议
managed descriptor                     一父 Session 一个 Reviewer 策略
provider registration capability       Reviewer 配置代际
create / list / deliver / interrupt     同父审批串行
cold resume / persistence              请求—结果关联与 deadline
官方 subagent tree / read-only Web      动作快照、policy 与结果映射
approval/request waterfall             自动 answerer 与人工 answerer 委托
```

## 2. 当前代码结论

### 2.1 可以保留的核心

当前实现已经形成正确的应用层骨架：

- `json.ts`：lossless JSON 和 canonical JSON；
- `protocol.ts`：providerData、动作快照、审批请求、审批决定和 hash；
- `broker.ts`：一次性结果关联；
- `capture.ts`：工具调用与审批请求关联；
- `manager.ts`：Reviewer 查找／创建、per-parent 串行和 deliver；
- `answerer.ts`：审批结果到 DSH outcome 的映射。

这些模块的主要问题不是业务方向，而是部分职责仍然混合，以及 DSH adapter 尚未使用真实 DSH 类型。

### 2.2 必须重做的接入层

当前未提交的 `src/plugin.ts` 是“结构模拟 adapter”，不是已经证明可接入 DSH 的 adapter：

- 本项目没有 DSH 或 `dsh-managed-agent` 依赖；
- 本地重复声明了 Controller、registration、materialize、Agent、tool 和 event 类型；
- `as ManagedReviewerController` 隐藏了类型漂移；
- materialize 信息缺少真实的 `source`、`parentSessionId` 和完整 descriptor；
- 本地工具执行接口缺少真实 `ToolExecution` 的 `signal`、`rootCallId`、`token` 等事实；
- `effort` 进入配置指纹，却没有通过 DSH model selection 应用；
- Reviewer setup 闭包保留 child Agent，违背 managed provider 的 composition 边界；
- `requestedPermissions` 函数混入 Cordis 配置，无法由 YAML／JSON loader 表达；
- 当前 `systemPrompt`、approval 和 sandbox 调用形态与 DSH 真实 API 不完全一致；
- decision tool 在 tool body 内直接兑现结果，没有等待 DSH `tools/result` 成为成功终态，也没有结束 Reviewer 当前 turn。

因此，现有 39 项测试证明领域核心和结构 mock 自洽，但不能证明真实 DSH 兼容。Stock DSH `0.1.1-rc.2` 本身也没有 `registerManagedProvider()`；真实运行目标必须是应用 sibling 补丁后的 DSH，或未来正式包含该 API 的 DSH 版本。

## 3. 总体架构

目标架构分成五层：

```text
┌──────────────────────────────────────────────────────────────┐
│ Cordis Composition Root                                      │
│ Config / apply / effect ownership / lifecycle                │
└──────────────┬───────────────────────────────────────────────┘
               │ wires
┌──────────────▼───────────────────────────────────────────────┐
│ DSH Adapters                                                 │
│ approval hook | tool capture | managed provider | result tool│
└──────────────┬──────────────────────────────┬────────────────┘
               │                              │
┌──────────────▼─────────────────┐  ┌────────▼─────────────────┐
│ Approval Application Layer    │  │ Reviewer Composition      │
│ coordinator / directory / lane│  │ model / prompt / tools    │
└──────────────┬─────────────────┘  └────────┬─────────────────┘
               │                              │ submit
┌──────────────▼──────────────────────────────▼────────────────┐
│ Decision Channel                                             │
│ arm / await / submit / correlate                             │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│ Domain Protocol                                              │
│ providerData / action / request / decision / codecs / hash   │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 依赖方向

依赖只能向下：

```text
plugin composition
    → DSH adapters
        → application services
            → ports + domain protocol
```

领域层不得 import Cordis、DSH Agent、ToolRuntime 或 SubagentRuntime。DSH adapter 可以 import 领域层；反向依赖禁止。

## 4. 组件划分

建议将代码整理为以下结构。文件名可以微调，但职责边界应保持：

```text
src/
├── index.ts
├── plugin.ts                    # Cordis composition root
├── config.ts                    # 可序列化 Config schema 与归一化
├── domain/
│   ├── json.ts
│   └── protocol.ts              # providerData/action/request/decision
├── application/
│   ├── review-coordinator.ts    # 一次审批的完整 orchestration
│   ├── reviewer-directory.ts    # find-or-create 与代际选择
│   ├── serial-lanes.ts          # per-parent 串行
│   └── decision-channel.ts      # broker 与 pending result
├── ports/
│   ├── managed-reviewer.ts      # 应用层需要的最窄 managed port
│   └── action-projector.ts      # ToolExecution → ActionSnapshot 输入
├── reviewer/
│   ├── policy.ts                # prompt、请求呈现、decision schema
│   ├── provider.ts              # ManagedSubagentProvider
│   └── decision-tool.ts         # 真实 DSH ToolDefinition
└── dsh/
    ├── managed-controller.ts    # 官方 Controller → 应用 port
    ├── action-capture.ts        # tools/pre-execute + tools/result
    └── approval-answerer.ts     # approval/request waterfall
```

不建议把每个纯函数机械拆成文件；上述划分表达的是模块边界，而不是追求文件数量。

### 4.1 `config.ts`

只包含 loader 可表达的数据：

```ts
interface Config {
  mode?: 'auto' | 'auto-then-user'
  timeoutMs?: number
  reviewer: {
    generation: string
    provider: string
    model: string
    reasoningEffort?: string
    policyVersion: string
    toolsetVersion: 1
  }
}
```

需要同时导出：

```ts
export const name = 'dsh-approve-for-me'
export const inject = ['subagents', 'tools', 'systemPrompt', 'approval']
export const Config: z<Config>
export interface Config { ... }
export function normalizeConfig(config: Config): NormalizedConfig
```

`requestedPermissions(execution) => ...` 不能放在 Config 中。它是代码级投影策略，应成为内部实现或注入的 port。

### 4.2 Domain Protocol

`protocol.ts` 只表达稳定业务协议：

- `ReviewerProviderDataV1`；
- `ActionSnapshotV1`；
- `ApprovalReviewRequestV1`；
- `ApprovalDecisionV1`；
- runtime codecs；
- canonical hash；
- decision 到应用结果的纯映射。

这里不出现：

- `Agent`；
- `Context`；
- `ManagedSubagentController`；
- `ToolDefinition`；
- `ApprovalRequest`（DSH 类型）。

建议把当前 `ReviewerModelRoute.effort` 重命名为与 DSH 一致的 `reasoningEffort`。它既然参与 configuration fingerprint，就必须真实参与 composition。

### 4.3 `DecisionChannel`

当前 broker 被 `ReviewerSessionManager` 私有持有，导致 managed provider 的 decision tool 必须等 manager 构造完毕后才能建立。应把它提升为独立组件：

```ts
interface DecisionChannel {
  arm(request: ApprovalReviewRequest, signal?: AbortSignal): Promise<ApprovalDecision>
  submit(payload: unknown, actualReviewerSessionId: ReviewerSessionId): SubmitResult
  cancel(reviewId: ReviewId, reason: ReviewFailure): void
  dispose(): void
}
```

组合顺序变成：

```text
1. 创建 DecisionChannel
2. 创建 ReviewerProvider，向它注入 DecisionSink
3. registerManagedProvider(ReviewerProvider)
4. 用 registration.controller 创建 ReviewCoordinator
5. 注册 DSH hooks
```

这样可以消除 `let manager: ... | undefined` 的初始化环，也不需要 Reviewer provider 闭包捕获 manager 或 child Agent。

### 4.4 `ReviewerDirectory`

负责插件自己的实例策略：

```ts
interface ReviewerDirectory<Parent, SessionId> {
  ensure(
    authority: ParentAuthority<Parent, SessionId>,
    preset: ReviewerProviderDataV1,
    signal?: AbortSignal,
  ): Promise<ReviewerRef<SessionId>>
}
```

职责仅包括：

- 调用 provider-owned `list()`；
- 解析每个 child 的 providerData；
- 按 role、generation 和 fingerprint 选实例；
- 不存在时 `create()`；
- 返回 `ReviewerRef`。

它不负责审批 request、deadline 或 decision。

### 4.5 `ReviewCoordinator`

负责一次审批的应用流程：

```ts
interface ReviewCoordinator<Parent, SessionId> {
  review(input: {
    authority: ParentAuthority<Parent, SessionId>
    action: ActionSnapshot
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalDecision>
}
```

其内部流程：

```text
per-parent lane
  → directory.ensure()
  → build ApprovalReviewRequest
  → decisionChannel.arm()
  → managed port deliver()
  → await decision
  → 必要时 interrupt()
  → 返回领域 Decision
```

父身份应由 DSH adapter 一次性构造：

```ts
interface ParentAuthority<Parent, SessionId> {
  readonly live: Parent
  readonly sessionId: SessionId
}
```

禁止继续让调用方分别传入 `parent Agent` 和任意 `parentSessionId` 字符串。

### 4.6 `ActionProjector`

动作捕获分成两个概念：

```ts
interface ActionProjector<Execution> {
  project(execution: Execution): ActionSnapshotInput
}

interface ActionCapture<Owner, CallId> {
  remember(owner: Owner, callId: CallId, action: ActionSnapshot): void
  lookup(owner: Owner, callId: CallId, toolName: string): ActionSnapshot | undefined
  release(owner: Owner, callId: CallId): void
}
```

首期由 DSH adapter 提供一个固定 projector：保留 tool name、完整 arguments，并从 DSH 已知事实投影 requested permissions。以后若不同工具族需要扩展，应扩展 projector／projector registry，不应向 YAML Config 塞函数。

### 4.7 `ReviewerPolicy`

Reviewer 的业务 policy 与 DSH composition 分离：

```ts
interface ReviewerPolicy {
  readonly version: string
  readonly systemPrompt: string
  readonly decisionParameters: JsonSchema
  buildRequestContent(request: ApprovalReviewRequest): ContentBlock[]
}
```

首期只有一个 `v1` 实例即可；接口的价值是明确：

- policy 版本决定如何解释已有 Reviewer transcript；
- DSH provider 只负责把 policy 安装到 child scope；
- 后续 Guardian prompt、full/delta context 或分类规则升级不会侵入 coordinator。

未知 policy version 由 providerData codec／policy registry 拒绝，不由 Managed Runtime 解释。

## 5. 与 DSH 的确切交互面

本插件只依赖以下 DSH seam，不直接操作 AgentRegistry、Session persistence 或 Web：

| 目的 | DSH seam | 本项目组件 |
|---|---|---|
| 注册 Reviewer 类型 | `ctx.subagents.registerManagedProvider()` | `reviewer/provider.ts` |
| 创建／查找／投递／中断 | registration-scoped Controller | `dsh/managed-controller.ts` |
| 构造 child world | `ManagedSubagentComposition.agentOptions/setup` | `reviewer/provider.ts` |
| 固定模型 | `AgentOptions` + `installModelSelection()` | Reviewer setup |
| 完整 prompt | `agentCtx.systemPrompt.section({ complete: true })` | Reviewer setup |
| 抑制 runtime context | `agentCtx.systemPrompt.suppressRuntimeContext()` | Reviewer setup |
| 隐藏全局工具 | `agentCtx.tools.restrict({ allow: [] })` | Reviewer setup |
| 安装结果工具 | `agentCtx.tools.register(ToolDefinition)` | `reviewer/decision-tool.ts` |
| 审批策略 | DSH approval session policy | Reviewer setup |
| sandbox 策略 | DSH sandbox session policy | Reviewer setup／部署组合 |
| 捕获动作 | `tools/pre-execute` | `dsh/action-capture.ts` |
| 释放捕获 | `tools/result` | `dsh/action-capture.ts` |
| 自动 answerer | `approval/request` waterfall | `dsh/approval-answerer.ts` |
| 生命周期 | Cordis effect disposer | `plugin.ts` |

### 5.1 Managed provider

必须直接实现真实契约：

```ts
interface ManagedSubagentProvider {
  name: string
  materialize(info: ManagedSubagentMaterializeInfo):
    ManagedSubagentComposition | Promise<ManagedSubagentComposition>
}
```

`materialize()` 每次 startup／resume：

1. runtime-parse `info.descriptor.providerData`；
2. 从 policy registry 解析对应 policy；
3. 返回明确的 `agentOptions`；
4. 返回真实 `AgentSetup`。

不得定义第二套 `DshReviewerAgentContext`。

### 5.2 Agent setup

DSH 的真实签名是：

```ts
type AgentSetup = (
  agentCtx: Context,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
```

Reviewer setup 应使用真实服务：

```text
installModelSelection(agentCtx, selection)
agentCtx.systemPrompt.section({ ..., complete: true })
agentCtx.systemPrompt.suppressRuntimeContext()
agentCtx.tools.restrict({ allow: [] })
agentCtx.tools.register(decisionTool)
用初始化 API 设置 child Session policy：
setApprovalPolicy(agentCtx.agent!.session, 'never')
setSandboxMode(agentCtx.agent!.session, 'read-only')
```

这些服务是本插件 composition 的必需依赖，不应通过可选链静默跳过。缺失服务属于插件无法挂载，而不是降级成 composition 不完整的 Reviewer。

### 5.3 Decision tool

真实工具必须实现 DSH `ToolDefinition`，接收 `ToolRunContext`：

```ts
function createDecisionTool(
  expectedChildSessionId: SessionId,
  sink: DecisionSink,
): ToolDefinition
```

关键边界：

- setup 只保存 `info.childSessionId`；
- 不保存 unpublished `agentCtx.agent`；
- execute 必须从真实 `exec.agent` 取得实际调用者；
- 实际调用者缺失或与 expected child 不一致时不提交；
- tool body 只校验并按真实 `ToolExecution` 暂存 candidate，同时调用 `exec.concludeTurn()`；
- child-scoped `tools/result` 观察同一 execution 的最终结果，只有成功终态才调用 `sink.submit()`，随后无条件清理 staged candidate；
- 结果工具不直接返回 DSH approval outcome。

这形成一个清晰的两阶段输出端口：

```text
ToolDefinition.execute()          解析／暂存领域 Decision
        ↓
DSH tools pipeline               post-execute／finalize
        ↓
child-scoped tools/result        向 DecisionSink 权威提交
```

### 5.4 Model selection

`agentOptions.provider/model` 负责创建时路由；同时使用：

```ts
installModelSelection(agentCtx, {
  current: {
    provider,
    model,
    reasoningEffort,
  },
  assembled: undefined,
})
```

这样 provider、model 和 reasoning effort 同时作用于 prompt variables 与 `agent/request`。不允许配置指纹与真实运行 composition 不一致。

### 5.5 Approval answerer

DSH adapter 接收真实 `ApprovalRequest`：

```text
req.agent      精确 live parent authority
req.toolName   与 capture 复核
req.callId     capture key
req.reason     进入业务请求
req.signal     贯穿 review
next()         仅用于 auto-then-user 委托
```

adapter 负责从 `req.agent.id` 构造唯一 `ParentAuthority`，然后调用 `ReviewCoordinator`。应用层不再接触 DSH waterfall。

两个 listener 的顺序属于接口语义：

- `tools/pre-execute` capture 使用 `{ prepend: true }`，保证其他 policy listener 发起 approval ask 前动作已进入 capture；
- `approval/request` answerer 使用 `{ prepend: true }`，保证本插件先评审，`auto-then-user` 再通过 `next()` 明确委托后续人工 answerer。

### 5.6 Web 与 Host

首期不增加项目私有 Host route 或 Web 状态源：

- Reviewer 通过 managed mode 自动进入官方 subagent tree；
- transcript、history 和 export 使用 DSH 原生能力；
- managed composer 和 Stop 由 `dsh-managed-agent` 补丁提供；
- approval 业务结果不进入 managed Runtime 的公共 projection。

如果以后要显示审批摘要，应由独立、脱敏的插件 UI projection 提供，而不是让 Managed Runtime 理解 ApprovalDecision。

## 6. 包和类型边界

### 6.1 依赖策略

本项目应把 DSH 包作为 exact peer dependencies，并在 devDependencies 中安装同版本用于编译／测试，至少包括：

- `@deepseek-ai/cordis`；
- `@deepseek-ai/schemastery`；
- `@deepseek-ai/dsh-agent`；
- `@deepseek-ai/dsh-llm`；
- `@deepseek-ai/dsh-session`；
- `@deepseek-ai/dsh-subagent`；
- `@deepseek-ai/dsh-system-prompt`；
- `@deepseek-ai/dsh-tools`；
- `@deepseek-ai/dsh-user-approval`；
- `@deepseek-ai/dsh-sandbox-policy`。

不能把这些服务包作为本插件的私有重复 Runtime 安装进 Host。

### 6.2 `dsh-managed-agent` 的前置工作

当前 sibling 包是 `private: true`、`0.0.0`，还不能作为稳定跨仓库依赖。进入真实 adapter 施工前，二选一：

1. 推荐：把 sibling 的 contract package 做成可 pack／可发布包，并锁定 commit／版本；
2. 临时：使用明确的 workspace／git dependency，同时在 CI 中应用其补丁并从 patched DSH packages 编译。

无论采用哪种方式，本项目都不得继续复制 Managed Controller 类型。若官方未打补丁的 `@deepseek-ai/dsh-subagent` 类型还没有 `registerManagedProvider()`，sibling contract package 应提供明确的 runtime extension／module augmentation，而不是由本项目自行伪造整个 Context。

### 6.3 公共导出

根包建议只公开：

```text
name
inject
Config（schema + type）
apply
稳定的领域协议类型／codec
可选的 policy 或 action projector 扩展接口
```

不再公开：

```text
DshApproveForMeContext
DshManagedController
DshManagedRegistration
DshReviewerAgentContext
DshScopedDecisionTool
DshToolExecution
```

这些本地 facsimile 应删除。

## 7. 启动、审批和恢复时序

### 7.1 插件启动

```text
Cordis loader
  → validate Config
  → normalize Reviewer preset
  → create DecisionChannel
  → create ManagedSubagentProvider(policy registry + decision sink)
  → ctx.subagents.registerManagedProvider(provider)
  → wrap registration.controller as ManagedReviewerPort
  → create ReviewerDirectory + ReviewCoordinator
  → register tool capture hooks
  → register approval answerer
```

### 7.2 一次审批

```text
tools/pre-execute
  → ActionProjector
  → ActionCapture.remember(exact Agent + callId)

approval/request
  → locate captured action
  → ParentAuthority(req.agent, req.agent.id)
  → ReviewCoordinator.review()
      → per-parent lane
      → ReviewerDirectory.ensure()
          → controller.list()
          → optional controller.create()
      → DecisionChannel.arm()
      → controller.deliver(ContentBlock[])
      → await decision tool submission
  → map Decision to DSH ApprovalOutcome / next()

tools/result
  → ActionCapture.release()
```

### 7.3 Reviewer startup／cold resume

```text
Managed Runtime
  → provider.materialize(info)
  → parse providerData + resolve policy
  → return agentOptions + AgentSetup
  → DSH creates/resumes unpublished Agent
  → AgentSetup installs model/prompt/tools/policies
  → Runtime publishes Activation
  → controller.deliver() enters official inbox
```

同一 provider 实例的 startup 和 resume 必须走同一个 composition factory，不允许 resume 使用另一套“简化 setup”。

### 7.4 插件卸载／HMR

一个 Cordis effect 拥有整套安装：

```text
stop approval answerer
→ stop capture listeners
→ dispose DecisionChannel
→ await registration.dispose()
```

重载后重新注册同名 provider，获得新 Controller；旧 Controller 不缓存、不复用。持久 Reviewer Session 由下次 `list()` 和 `deliver()` 重新发现／恢复。

## 8. 分阶段施工

## Phase 0：锁定可消费的基础契约  ✅ 已施工(2026-08-25)

**工作**

- 决定 sibling contract 的 workspace／git／publish 形式；
- 固定 managed patch commit 和 DSH baseline；
- 准备一个应用补丁后的 DSH fixture；
- 让本项目能直接 import 真实 Managed、Agent、Tool、Approval 类型。

**交付**

- 可重复安装的依赖边界；
- `tsc` 能看见真实 `registerManagedProvider()`；
- 删除“先本地声明、以后再替换”的路线。

**退出条件**

一个最小 compile fixture 可以注册 provider、取得 Controller，并实现真实 `AgentSetup` 和 `ToolDefinition`，没有 `as unknown as` 贯穿 seam。

## Phase 1：配置与包入口  ✅ 已施工(2026-08-25)

**工作**

- 新增 `Config` Schemastery schema；
- 导出 `name`、`inject`、`Config`、`apply`；
- 分离 serializable Config 与 `ActionProjector`；
- 增加 exact peer/dev dependencies；
- 收窄根包 exports。

**退出条件**

插件可由普通 DSH loader 配置加载；非法配置在注册 provider 前被拒绝。

## Phase 2：应用层重构  ✅ 已施工(2026-08-25)

**工作**

- 从 manager 中拆出 `DecisionChannel`；
- 拆出 `ReviewerDirectory`；
- 让 `ReviewCoordinator` 使用 `ParentAuthority`；
- 去除重复的 parent Agent／session id 参数；
- 将 per-parent lane 保持在应用层；
- 迁移现有 protocol、broker、manager、answerer 单测。

**退出条件**

应用层不 import DSH，且可用 fake ports 完整测试一次审批流程。

## Phase 3：真实 Reviewer provider  ✅ 已施工(2026-08-25)

**工作**

- 直接实现 `ManagedSubagentProvider`；
- providerData 和 policy registry 完成 startup／resume materialization；
- 使用真实 `AgentOptions` 和 `AgentSetup`；
- 安装 complete prompt、runtime-context suppression、tool restriction 和 decision tool；
- 使用 `installModelSelection()` 应用 reasoning effort；
- 去除 child Agent 闭包保留。

**退出条件**

provider 在 patched DSH fixture 中可以创建和 cold-resume 同一 Reviewer Session，composition 两次一致。

## Phase 4：真实 DSH hooks  ✅ 已施工(2026-08-25)

**工作**

- 使用真实 `ToolExecution` 实现 capture adapter；
- 使用真实 `ApprovalRequest`／`ApprovalOutcome` 实现 answerer；
- 通过显式 Managed Controller adapter 接入应用 port；
- 删除全部本地 `Dsh*` facsimile 和 controller cast。

**退出条件**

真实工具调用能形成 action snapshot，真实 approval ask 能驱动 Reviewer，并由真实 scoped tool 返回结果。

## Phase 5：DSH 集成验证

**最小场景**

1. plugin registration → first approval → create → deliver → decision tool；
2. 第二次审批复用同一 Reviewer；
3. idle release 后 cold resume 同一 Session；
4. 父 Session 恢复后使用新的 exact parent Agent；
5. plugin unload／reload 后新 registration 发现旧 child；
6. `auto-then-user` 正确进入下游 answerer；
7. 官方 Web 树可读、composer 只读、running Stop 可用。

**测试分层**

```text
unit            domain + application ports
adapter         real DSH types and scoped services
integration     patched DSH runtime + persistence
web smoke       existing Host/Web managed-node path
```

不再以纯结构 mock 的 plugin test 作为真实兼容性的最终证据。

## Phase 6：policy 产品化

基础接入稳定后再进行：

- Guardian policy 的来源归属与版本固定；
- prompt policy registry；
- full／delta Reviewer context；
- token budget、截断和有限 retry；
- 可选的脱敏业务审计 projection。

这一阶段不改变 Managed Controller 或 DSH 基础层接口。

## 9. 里程碑依赖关系

```text
M0 Managed contracts consumable
 └── M1 Real plugin entry + Config
      └── M2 Application boundary refactor
           ├── M3 Real Reviewer provider
           └── M4 Real approval/tool adapters
                └── M5 Patched-DSH integration
                     └── M6 Guardian policy productization
```

M3 和 M4 可以在 M2 后并行；M5 必须在两者完成后进行。

## 10. 架构验收清单

施工评审首先检查以下问题，而不是先检查零散错误分支：

- [x] 是否只有 DSH 维护 Agent／Session／inbox／persistence？
- [x] 是否只有 `dsh-managed-agent` 维护 managed lifecycle 和 Controller authority？
- [x] 是否只有本项目理解 ApprovalRequest／ApprovalDecision？
- [x] Config 是否完全可序列化并有 runtime schema？
- [x] 是否直接消费真实 DSH／Managed 类型，没有本地 facsimile？
- [x] Reviewer composition 是否由一个 materializer 同时服务 startup 和 resume？
- [x] model、reasoning effort、prompt、tools 和 policy 是否来自同一个持久 preset？
- [x] decision tool 是否只依赖 SessionId 和 DecisionSink，不保留 Agent？
- [x] decision 是否经过 tool body 暂存并在成功的 `tools/result` 才提交？
- [x] capture 与 approval answerer 是否在 waterfall 中占据预期的 prepend 顺序？
- [x] parent identity 是否从 exact live Agent 一次性派生？
- [x] `MessageId` 是否只被当作 inbox acceptance？
- [x] Reviewer singleton、串行和 decision correlation 是否仍属于应用层？
- [ ] Web 是否复用官方 managed child tree，而非建立第二套会话 UI？
- [x] plugin unload／HMR 是否由一个 effect 明确拥有全部 disposer？

## 11. 建议立即执行的下一批任务

按依赖顺序，下一批提交应当是：

1. **contracts commit**：使 `dsh-managed-agent` contract 可被本仓库真实依赖；
2. **packaging commit**：增加 DSH peers/dev dependencies、Schemastery Config 和 Cordis `inject`；
3. **application refactor commit**：拆出 DecisionChannel／ReviewerDirectory／ReviewCoordinator；
4. **provider adapter commit**：真实 Managed provider、AgentSetup、model selection 和 decision tool；
5. **hook adapter commit**：真实 ToolExecution capture 与 approval answerer；
6. **integration commit**：patched DSH fixture、persistence/cold-resume/HMR/Web smoke。

首个施工目标不是继续补强当前结构 mock，而是让 `dsh-approve-for-me` 成为 `dsh-managed-agent` 和 DSH 真实公共契约的编译期消费者。只有这一点完成，后续领域实现和工程纪律才落在正确的基础上。
