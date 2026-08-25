# Approval Reviewer 独立实现路线

> 状态：2026-08-25 确立。本文是协议与 Guarded Continuable 接入完成后，逐步填充审批 Reviewer 产品能力的权威路线图。

## 1. 实现原则

`dsh-approve-for-me` 采用 DSH 原生、独立编写的 Reviewer 实现。OpenAI Codex Guardian 只作为外部设计参照，用于检查能力覆盖和安全问题，不作为源码、提示词或测试素材来源。

本仓库不得复制、翻译或近似改写 Codex Guardian 的：

- 源代码、函数结构、控制流和注释；
- policy／prompt 文本；
- schema、测试、fixture 和 snapshot；
- 文档表达或按外部项目文件逐项对应的实现切片。

允许参考的是通用目标和可观察的工程模式，例如：隔离 Reviewer、证据信任分级、有界上下文、结构化结果、固定 deadline、有限重试、失败关闭和拒绝熔断。所有类型、策略文本、算法、默认参数和测试必须从 DSH 的需求与威胁模型独立推导。

项目原创内容统一使用 MIT 许可证。若未来确需引入任何第三方内容，必须先单独评审并明确标注；当前路线不引入 Codex 派生内容。

## 2. 当前基线

当前代码已经具备安全审批的执行骨架，但 `policy-v1` 仍是最小保守占位策略，不代表 Reviewer 产品能力已经完成。

| 组成部分 | 当前状态 | 下一步 |
|---|---|---|
| Managed Reviewer 生命周期 | 已实现 | 真实 profile 验收 |
| ActionSnapshot／hash | 已实现通用 v1 | 增加工具族语义投影 |
| request／decision identity | 已实现 | 保持协议兼容并扩充 assessment |
| DecisionChannel／deadline | 已实现 | 增加审查尝试层和持久审计边界 |
| per-parent 串行 | 已实现 | 保持不变 |
| 污染隔离／rotate | 已实现 | 真实恢复与重载验收 |
| Reviewer system prompt | 最小占位 | 独立设计完整策略 |
| 父会话上下文 | 未实现 | 建立证据模型与 ContextBuilder |
| 风险与授权判断 | 只有输出字段 | 建立明确分类和判定规则 |
| token budget／截断 | 未实现 | 建立 DSH 原生预算算法 |
| full／delta 上下文 | 未实现 | 建立 message-id cursor |
| 模型／解析重试 | 未实现 | 在单一 deadline 内有限重试 |
| 拒绝熔断 | 未实现 | 建立 per-parent-turn 熔断状态 |
| Reviewer 调查工具 | 未实现 | 先定义必要性与最小只读能力 |
| 业务审计／指标 | 未实现 | 先定义脱敏事件和保留策略 |

## 3. Reviewer 组成部分

### 3.1 Evidence Model

建立 DSH 消息和事件来源到证据信任级别的确定性映射。信任级别由宿主事实产生，模型不能通过文本自报可信。

建议的领域概念：

```ts
type EvidenceTrust =
  | 'user-authoritative'
  | 'developer-authoritative'
  | 'system-fact'
  | 'untrusted-agent'
  | 'untrusted-tool'
```

需要明确：

- 哪些 DSH `MessageSource` 可以证明用户授权；
- assistant、tool result、技能说明和外部内容只能作为事实证据，不能自行扩大授权；
- root session、子代理和恢复后的消息如何关联；
- 编辑、回滚、压缩或历史版本变化如何使旧证据失效。

退出条件：存在纯领域测试，证明伪造文本不能提升 trust，且所有未知来源保守归类。

### 3.2 Parent Transcript Source

在应用层定义最窄 `TranscriptSource` port，由 DSH adapter 读取父 Session 历史并输出稳定的领域 entry。Policy 和 ContextBuilder 不直接依赖 DSH event 类型。

entry 至少携带：稳定消息标识、顺序、来源、角色、文本或结构化工具摘要、工具调用关联和历史版本。

退出条件：同一持久 Session 在 live、cold resume 和 history reload 后产生相同的规范化 entry 序列。

### 3.3 Context Selection and Budget

独立设计上下文选择算法，优先保留：

1. 当前用户目标和最近的明确授权／冲突授权；
2. 与待审动作目标、路径、主机、权限和副作用相关的消息；
3. 成对的工具调用与结果；
4. 最近的必要 assistant 推理摘要；
5. 省略和截断的结构化元数据。

消息、工具证据、动作和审批 reason 使用独立、可测试的预算。默认值必须由 DSH 模型窗口、实际消息分布和安全评测确定，不照搬外部项目常量。

退出条件：算法确定性、预算不超限、首尾 UTF-8 安全、截断可见，且工具输出不能挤掉全部用户授权证据。

### 3.4 Full／Delta Cursor

Reviewer 首次看到完整的有界上下文；后续请求在历史版本连续时只发送新增证据。Cursor 使用 DSH 稳定消息标识和授权版本，不使用外部实现的 entry-count 约定。

建议概念：

```ts
interface ReviewContextCursor {
  readonly parentSessionId: string
  readonly lastIncludedMessageId?: string
  readonly historyRevision: string
  readonly authorizationRevision: number
  readonly policyVersion: string
}
```

历史重写、cursor 缺失、policy 变化或授权版本倒退时必须回退到 full。

退出条件：full、delta、重写回退和 cold-resume 都有确定性测试。

### 3.5 Tool-family Action Semantics

保留当前通用 `ActionSnapshot` 作为防重放事实边界，在其上建立工具族 projector registry。优先覆盖：

- shell／process：命令、argv、cwd、环境差异、权限扩张；
- filesystem：目标、操作类型、递归范围和可恢复性；
- patch／write：文件集合、变更范围和工作区边界；
- network：目标、协议、端口、触发动作和可能发送的数据；
- MCP／外部工具：server、tool、参数、账户／目标元数据和能力提示；
- permission request：请求的文件、网络、进程或 sandbox 权限集合。

无法形成完整语义快照的工具不得自动放行；`auto-then-user` 可以下沉人工。

退出条件：每个工具族有正常、缺字段、混淆目标、超大 payload 和不可序列化输入测试。

### 3.6 Risk Taxonomy

建立项目自己的风险类别和规则，至少评估：

- 数据外发与敏感信息暴露；
- 凭据访问和身份冒用；
- 不可逆或高代价破坏；
- 持久安全弱化；
- 权限和 sandbox 扩张；
- 网络暴露与外部副作用；
- 供应链和未验证执行；
- 绕过审批或规避既有拒绝。

每个类别需要定义触发事实、反证、影响范围、授权需求、人工确认条件和绝对拒绝条件。规则文本必须由本项目独立撰写。

退出条件：建立攻击／良性对照用例，风险判断不能只依赖命令名称或路径是否位于 workspace 外。

### 3.7 User Authorization Assessment

沿用项目自有的授权语义，并补充作用域判断：

```ts
interface AuthorizationAssessment {
  readonly level: 'explicit' | 'implicit' | 'absent' | 'conflicting' | 'unknown'
  readonly targetCovered: boolean
  readonly sideEffectsCovered: boolean
  readonly evidenceIds: readonly string[]
  readonly rationale: string
}
```

需要区分“用户要求达到某个目标”与“用户明确授权某个高风险手段”。紧急程度、assistant 自述和外部内容都不能单独提升授权。

退出条件：授权 assessment 可追溯到保留的可信 evidence id，缺失或冲突时不会生成自动 allow。

### 3.8 Policy and Decision Contract

完整 policy 由本项目从空白文本独立撰写，至少包含：角色边界、证据信任、风险规则、授权规则、不确定性处理、调查限制和唯一结构化输出要求。

现有外层 decision identity 继续负责 `reviewId`、parent／Reviewer、generation、action hash 和 deadline。业务 assessment 与防重放 envelope 分离，避免模型字段变化破坏关联协议。

退出条件：policy 版本化；unknown policy 失败关闭；自由文本、缺字段、矛盾字段和身份不匹配均不能产生 allow。

### 3.9 Review Attempts

在一次业务 review 的固定 deadline 内增加有限尝试层。只有明确分类的瞬时 transport／provider 错误和可修复的结构化输出错误可以重试；deny、abort、身份不匹配、策略错误和 deadline 到期不得重试。

污染 child 的 rotate 重试属于基础设施恢复，与模型审查尝试分开计数和审计。

退出条件：尝试次数有上限、共享单一 deadline、支持 abort，且任何 retry exhaustion 都失败关闭。

### 3.10 Rejection Circuit Breaker

建立 per-parent-turn 状态，阻止代理在同一目标上反复请求、改写或绕过被拒动作。计数规则和阈值由 DSH 场景评测确定，不照搬外部默认值。

熔断至少区分：明确 deny、人工下沉、基础设施 unavailable 和 materially safer alternative。只有明确的新用户授权或新 turn／目标版本才能解除相应拒绝状态。

退出条件：重复、轻微改写、间接工具和跨工具族绕过都有测试；熔断本身不能误映射为 allow。

### 3.11 Read-only Investigation

首个完整 policy 可以在没有调查工具的情况下保守运行。若评测证明本地事实会实质改变 allow／deny，才增加目的受限的只读工具，而不是开放通用工具继承。

任何调查工具必须：无写入、默认无网络、有输入／输出上限、结果标记为 untrusted evidence，并遵守 Reviewer deadline。

退出条件：逐个工具完成 capability、数据暴露和旁路审计。

### 3.12 Audit and Metrics

审计应记录协议结果和安全原因，不默认保存完整敏感 payload。先定义事件 schema、脱敏 projection、保留期限和导出边界，再接入持久化或 telemetry。

退出条件：可以解释一次 allow／deny／fallback 的依据和失败阶段，同时不会把凭据、完整文件或内部 Controller capability 写入日志。

## 4. 实施顺序

```text
R0 独立实现原则、MIT 许可和路线图
 └── R1 Evidence Model + TranscriptSource
      └── R2 Context Selection/Budget + Full/Delta Cursor
           ├── R3 Tool-family Action Projectors ───────────┐
           └── R4 Risk Taxonomy + Authorization Assessment ┤
                                                           └── R5 Complete Policy + Decision Assessment
                                                                ├── R6 Finite Attempts ───────────────┐
                                                                ├── R7 Rejection Circuit Breaker ─────┤
                                                                └── R8 Optional Read-only Investigation ┤
                                                                                                         └── R9 Audit/Metrics + Security Evaluation
```

R3 与 R4 都是 R5 的前置条件；R6、R7 与 R8 收敛后再完成 R9。R1–R5 是 Reviewer 能够进行有依据审批的主路径。R6–R9 不能用来掩盖主策略不完整；每个里程碑都必须保持当前 fail-closed 性质。

真实 stock DSH profile 验收可与 R1–R5 并行推进，但在上下文、policy 和风险评测完成前，插件仍只应视为协议与运行骨架，不应宣称具备成熟的自动审批能力。

## 5. 每个里程碑的提交纪律

每一阶段应至少包含：

1. 领域接口和不变量；
2. DSH adapter 边界；
3. 正常与对抗性测试；
4. prompt／schema／默认参数的版本变化说明；
5. fail-closed 回归；
6. 文档状态更新。

外部项目只能进入设计比较文档，不得成为复制源或 golden snapshot。若实现与外部项目出现相似行为，测试应证明这是由本项目需求和 DSH 威胁模型独立推导的结果。
