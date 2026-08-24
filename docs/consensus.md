# Approve for Me 项目共识与设计边界

> 状态：截至 2026-08-24 的设计共识。本文记录已经达成的约束；具体 API 命名、schema 字段和实现细节仍需在实现阶段确定。

## 1. 项目定位与命名

`dsh-approve-for-me` 是面向 DSH 的受管自动审批插件，也是 `dsh-managed-agent` 的首个业务应用。历史讨论使用过工作名 `dsh-approval-for-me`；当前工作仓库名称 `dsh-approve-for-me` 是正式项目名。

项目目标不是绕过审批，而是引入一个隔离、可审计的 Approval Reviewer，在明确的策略、上下文和权限边界内替用户评估审批动作。只有经过完整协议校验的确定性结果才可影响审批状态。

## 2. 与 Managed Agent 基础设施的分层

通用基础设施由独立仓库 `dsh-managed-agent` 提供，计划以 Cordis 服务 `ctx.managedAgents` 暴露以下能力：

- Managed Agent 类型注册；
- controller capability 与独占输入通道；
- 按父 Session 管理实例生命周期；
- 类型化 request／result／event；
- DSH Agent／Session、模型路由和权限设施复用；
- 配置代际、状态、审计和只读 UI 投影。

本仓库在基础设施之上注册 Approval Reviewer 类型并实现审批领域逻辑。通用的 controller authority、Managed Agent 生命周期或 Agent 树投影不应在本仓库另造一套。

如果基础设施尚未提供所需扩展点，应优先补充 `dsh-managed-agent` 或 DSH 的正式 contribution／managed descriptor，而不是将 Reviewer 伪装成普通 one-shot 或 continuable subagent。

## 3. 核心角色

### 3.1 Parent Session

发起工具调用及审批的主 live Session。Reviewer 的归属、生命周期和审计链均绑定到该 Session。

### 3.2 Approval Reviewer

拥有独立 Agent／Session 的常驻受管节点。它接收结构化审批请求，评估风险与用户授权，仅通过类型化结果通道返回决定。

### 3.3 ReviewerSessionManager

每个 Parent Session 下 Reviewer 的唯一 controller。它负责创建和销毁 Reviewer、构造请求快照、串行提交审查、验证结果身份与代际，并将有效决定映射到 DSH 审批或人工 answerer。

### 3.4 Human answerer

DSH 现有的人工审批通道。它不是 Reviewer 的自由文本后备输入；仅在 `auto-then-user` 模式下通过正式审批流程接收需要人工复核的动作。

## 4. 生命周期共识

首期采用“每个主 live Session 一个常驻 Reviewer”：

1. Parent Session 进入 live 状态时创建 Reviewer，或在首次需要审查时惰性创建。
2. Reviewer 在 Parent Session 的存活期内保持独立连续上下文。
3. 首期同一 Parent Session 的审批请求串行执行，不并发复用 Reviewer。
4. Parent Session 结束时，取消活动审查并销毁 Reviewer，撤销 controller capability。
5. 冷恢复 Parent Session 时创建干净 Reviewer，不直接复活未经验证的旧运行态。
6. Reviewer 超时、transport／模型错误、协议违规或缺失结果后，当前请求失败关闭，并销毁、重建 Reviewer。
7. 不允许孤儿 Reviewer 继续接收请求或产生可生效结果。

## 5. 类型化审批协议

### 5.1 输入

审批输入是有界且提交后不可变的 `ApprovalRequest`，其中包含精确的 `ActionSnapshot`。概念上至少需要表达：

- 唯一 `reviewId`；
- Parent Session、Reviewer 实例及配置 generation 的关联身份；
- 动作类型、工具名和规范化参数；
- sandbox／network／filesystem 等相关权限请求；
- 用户对当前动作或动作类别的显式授权证据；
- 可信的对话／执行上下文及截断标记；
- 固定 deadline；
- 可复算的 `actionHash`。

快照只包含作出审批决定所需的信息，不把整个父 Session 或任意插件状态无界复制给 Reviewer。字段、上限和 schema 技术在实现阶段确定。

### 5.2 输出

Reviewer 仅通过结构化 `ApprovalDecision` 返回终结结果。概念上包含：

- `decision`: `allow`、`deny` 或 `human_review`；
- 风险等级及风险类别；
- 用户授权判断；
- 简洁、可审计的理由；
- 与请求一致的 `reviewId`、`actionHash` 和 generation。

每个请求至多接受一次有效终结结果。Manager 必须校验 schema、请求身份、动作哈希、实例和配置代际；重复、迟到、过期、跨代或已取消请求的结果必须丢弃并记录。

### 5.3 唯一结果工具

首期 Reviewer 每轮只注册专用的 `approval_review_result` 工具，并在每次审查开始前重新 arm。工具只用于提交当前请求的一次结构化结果，不能读取或改变其他状态。后续若确需增加工具，也仅考虑边界明确的纯读取能力。

## 6. 审批模式与失败语义

### 6.1 `auto`

只有完整通过协议验证、明确返回 `allow` 且符合策略的结果才能自动放行。`deny`、`human_review`、不确定、超时、取消、错误和缺失结果均不放行。

### 6.2 `auto-then-user`

有效 `allow` 可自动放行；`human_review` 或策略定义的不确定结果转交 DSH 现有人工 answerer。若没有可用人工通道，则明确返回 unavailable／rejected，不等待无限期，也不自动降级为 allow。

### 6.3 统一安全失败

以下情况不得解释为 `allow`：

- timeout 或 cancellation；
- provider、模型或 transport 错误；
- 非法 schema、自由文本替代结果或未调用结果工具；
- `reviewId`、`actionHash`、实例或 generation 不匹配；
- 重复、迟到、过期或缺失结果；
- 模型路由失效；
- Manager 或 Reviewer 异常退出。

有限重试只能针对明确定义的可恢复错误，不能改变固定 deadline，也不能无限消耗审批队列。连续拒绝或异常应触发可观察的熔断行为，具体阈值待定。

## 7. Reviewer 隔离与最小权限

Reviewer 必须使用受控、未发布的 Agent setup 创建，并明确安装最小权限：

- 不继承 Parent Session 的对话历史，仅接收 Manager 构造的有界上下文；
- 不加载普通 preset；
- 不加载 memory、skills、plugins、hooks、MCP 或 web；
- 不注册 subagent、workflow、shell 或任意写入工具；
- approval 固定为 `never`；
- sandbox 固定为 `read-only`；
- network disabled；
- 首期仅有 `approval_review_result`；
- 通用 `send_message`、follow-up、用户 composer 和主 Agent 普通消息均不能注入 Reviewer。

用户可以观察 Reviewer、取消所属工作流、启停自动审批和修改配置，但不能聊天式 steer Reviewer。UI composer 应只读或禁用，并清楚说明 controller 归属。

普通 DSH continuable subagent 不适合作为 Reviewer 实现本体：其请求不保证业务 output schema，使用父子消息通道，允许通用 follow-up，而且 delegated child 的 sandbox 不天然满足上述只读隔离。

## 8. 模型选择与配置代际

Reviewer 模型应在配置界面独立选择，但必须复用 DSH 的：

- `llm.models`／`llm.providers` catalog；
- provider adapter 与现有凭据；
- retry 与 reasoning effort；
- `installModelSelection` 等现有模型选择机制。

持久化配置只保存稳定的 provider／model／effort id，不复制 provider 私有配置或凭据。无效或失效 route 必须明确报错，不能静默 fallback 到另一个模型。

provider、model、effort、policy 或 toolset 共同形成配置指纹。指纹变化时创建新 generation：

- 活跃审查不中途更换模型或策略；
- 当前审查完成或取消后再重建 Reviewer；
- 请求与结果均绑定 generation；
- 旧 generation 的迟到结果不能在新 generation 生效。

## 9. Policy 与上下文管理

提示词和上下文管理尽量移植 Codex Guardian 已验证的设计，同时适配 DSH 语义。计划保留：

- policy template 与风险分类；
- 证据信任规则；
- 用户授权等级；
- 精确 action JSON；
- 首次 full transcript、后续 delta transcript；
- 消息与工具输出独立 token budget；
- 明确的截断标记；
- 固定 deadline；
- 有限重试；
- 失败关闭与拒绝熔断。

适配层必须使用 DSH 的 `MessageSource`、Session event sequence、工具／action 表达、`sandbox_permissions` 词汇和 Managed Agent 生命周期。上游 policy 与 DSH adapter 应分层，避免把上游假设散落在集成代码中。

任何上下文都必须区分：

- 用户明确说出的授权；
- 主 Agent 或工具输出中的非可信指令；
- 系统已知策略和环境事实；
- 因 token budget 被截断或缺失的信息。

Reviewer 不得把主 Agent 自述“用户已同意”自动视作用户授权证据。

## 10. 可见性与审计

Reviewer 应作为真实 Managed Agent 节点出现在 Agent 树或等价的官方 managed projection 中，并至少显示：

- 所属 Parent Session；
- Reviewer 状态、模型和配置 generation；
- 审查开始、完成、取消、超时、重建和错误；
- `reviewId`、动作摘要、风险和决定摘要；
- 是否自动处理或转交人工；
- 被拒绝的迟到、重复或跨代结果。

审计记录应足以解释“哪个 Reviewer 在什么配置下，依据哪个不可变动作快照，产生了什么结果，以及该结果如何影响最终审批”，但不能泄露 provider 凭据或无关敏感上下文。

## 11. 与 DSH 审批链路的集成原则

- 自动审批作为 DSH 现有审批机制上的受控决策来源，不修改工具本身的权限声明。
- Reviewer 的 `allow` 只对绑定的单次 action 生效，不扩大后续动作权限。
- `human_review` 必须走现有人工 answerer，而不是让 Reviewer直接询问用户。
- 用户取消、Parent Session 取消和工具调用取消必须传播到活动审查。
- 自动审批功能应可按配置启停，并在 UI 中明确当前模式和可用性。
- 插件未加载、模型不可用或 Reviewer 不健康时，应保持 DSH 原审批语义或明确转人工，不得形成隐式自动放行路径。

## 12. 上游移植与许可证

Codex Guardian 使用 Apache-2.0，DSH 使用 MIT。项目自身许可证尚未确定。在复制或改编 Guardian 的提示词、policy 或代码前必须：

1. 记录准确的上游仓库和 commit；
2. 识别原样复制、修改和全新适配的文件；
3. 保留 Apache-2.0 许可证和第三方归属；
4. 将原样上游 policy 与 DSH adapter 分层存放；
5. 在发布前复核整个分发物的许可证兼容与 NOTICE 要求。

在完成上述工作前，不应把来源不明的 Guardian 文本直接落入产品代码。

## 13. 首期验收标准

首期实现至少应证明：

1. 每个主 live Session 能获得一个独立、常驻且可见的 Reviewer。
2. 只有对应 `ReviewerSessionManager` 的 controller capability 能提交审批请求。
3. composer、`send_message`、follow-up 和未授权插件均不能向 Reviewer 注入消息。
4. Reviewer 只接收有界不可变快照，并只通过一次性结构化结果工具返回决定。
5. 同一 Parent Session 的审批串行执行，取消和 deadline 正确传播。
6. Reviewer 不继承父环境能力，保持 read-only、无网络和极小工具集。
7. 指定 provider／model／effort 通过 DSH 现有设施安装，失效 route 明确失败。
8. 配置变更安全换代，跨代和迟到结果不能生效。
9. 所有错误、非法结果和缺失结果均不能产生 `allow`。
10. `auto-then-user` 能使用现有人工 answerer；无人工通道时明确失败。
11. Parent Session 结束后不存在仍可接收请求的孤儿 Reviewer。
12. UI 与审计记录能解释 Reviewer 的状态、输入身份、决定和最终处理路径。

## 14. 尚待实现阶段决定

以下内容尚未形成最终共识，不应被本文误读为稳定 API：

- npm 包名、导出路径和 DSH 版本兼容范围；
- TypeScript 接口、schema 库及字段命名；
- Reviewer 的创建时机采用 eager 还是 lazy；
- policy 配置格式和可定制边界；
- transcript delta 的精确算法与 token 上限；
- deadline、重试、熔断和队列上限；
- 风险等级与用户授权等级枚举；
- human answerer 的集成 API；
- UI 配置面板与审计存储格式；
- Codex Guardian 上游基线 commit；
- 项目许可证。

这些实现决策必须继续服从本文的 controller 独占、最小权限、类型化协议、可审计和失败关闭约束。
