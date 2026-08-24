# dsh-approve-for-me

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 的受管自动审批插件。

> 当前状态：设计共识已落盘，尚未开始实现。

## 项目目标

`dsh-approve-for-me` 为每个主 live Session 配置一个常驻的 Approval Reviewer。Reviewer 使用独立模型和隔离 Session，读取有界、不可变的动作快照，并返回结构化审批决定，用于在不放宽 DSH 原有安全边界的前提下自动处理工具审批。

本项目是 [`dsh-managed-agent`](../dsh-managed-agent) 的首个业务应用。它依赖后者提供可见但不可被自由聊天消息驱动的 Managed Agent 节点、controller capability、类型化协议、生命周期和审计投影；本仓库只负责审批领域逻辑。

历史讨论中曾使用工作名 `dsh-approval-for-me`，本仓库以 **`dsh-approve-for-me`** 为正式项目名。

## 核心原则

- **Controller 独占**：每个 Reviewer 只接受其 `ReviewerSessionManager` 提交的审批请求。
- **结构化协议**：输入为 `ApprovalRequest`／`ActionSnapshot`，输出为 `ApprovalDecision`，不以自由文本作为控制接口。
- **最小权限**：Reviewer 不继承父 Session 的 memory、skills、plugins、hooks、MCP、web、subagent 或 workflow；首期只拥有提交审批结果所需的专用工具。
- **失败关闭**：超时、取消、模型或 transport 错误、非法输出、缺失结果、迟到结果均不能产生 `allow`。
- **可见且可审计**：Reviewer 有独立 Agent／Session，可在 Agent 树中查看状态和执行记录，但不能通过 composer、`send_message` 或 follow-up 被聊天式 steer。
- **复用 DSH 模型设施**：直接复用 `llm.models`／`llm.providers` catalog、provider adapter、凭据、retry、reasoning effort 与现有模型选择机制。
- **配置安全换代**：模型、policy 或 toolset 变化后生成新配置代际；进行中的审查不中途切换模型，旧代际结果不得污染新代际。

## 审批模式

- `auto`：Reviewer 只在得到有效、确定的 `allow` 时自动放行；其余情况失败关闭。
- `auto-then-user`：Reviewer 返回不确定或要求人工复核时，转交 DSH 现有人工 answerer；没有可用人工通道时明确返回 unavailable／rejected，不静默放行。

## 仓库边界

本仓库负责：

- Approval Reviewer 的类型注册与 `ReviewerSessionManager`；
- 审批请求快照、结构化决定、风险与用户授权语义；
- Reviewer 的提示词、上下文预算、deadline、有限重试与拒绝熔断；
- Reviewer 模型配置界面和配置代际管理；
- 审批链路与 DSH approval／answerer 的集成；
- Codex Guardian 可复用策略的移植、适配和第三方归属。

本仓库不负责：

- 实现通用 Managed Agent 基础设施；
- 复制 DSH provider 私有配置或凭据；
- 将普通 continuable subagent 当作 Reviewer 实现本体；
- 允许任意聊天消息或未授权插件绕过 controller 输入通道；
- 在无法验证 Reviewer 结果时默认放行。

## 文档

- [项目共识与设计边界](docs/consensus.md)

## 许可证与上游归属

项目自身许可证尚未确定。DSH 使用 MIT 许可证，计划参考的 Codex Guardian 使用 Apache-2.0。直接复制或改编 Guardian 的提示词与代码时，必须记录上游 commit，保留 Apache-2.0 许可证及第三方归属，并将原样上游 policy 与 DSH adapter 分层存放。
