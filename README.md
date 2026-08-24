# dsh-approve-for-me

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 的受管自动审批插件。

> 当前状态：首个审批协议核心已实现并通过测试；真实 Cordis／DSH 适配等待 `dsh-managed-agent` 实现其已定稿的 `managed` subagent API。项目尚未安装或挂载到 DSH。

## 项目目标

`dsh-approve-for-me` 为每个主 Session 管理一个持久的 Approval Reviewer child。Reviewer 使用独立 Session 和受控模型配置，接收有界、不可变的动作快照，并通过插件自有的结构化结果工具返回审批决定。

这里的“持久”指 Reviewer Session 和 transcript 可以在 Activation 释放后继续保留，并在后续审批时 cold-resume；不要求 Reviewer Agent 永久在线。

本项目是 [`dsh-managed-agent`](../dsh-managed-agent) 的首个业务应用。基础插件将为官方 `ctx.subagents` 增加第三种 `managed` mode，并提供 provider 私有的 Controller capability：

```text
registerManagedProvider()
└── controller
    ├── create(parent, options)
    ├── list(parentSessionId)
    ├── deliver(parent, childId, content)
    └── interrupt(parent, childId)
```

基础层只负责受控创建、发现、投递、恢复和停止；审批 schema、singleton、串行、deadline、结果关联和失败关闭全部由本仓库负责。

历史讨论中曾使用工作名 `dsh-approval-for-me`，本仓库以 **`dsh-approve-for-me`** 为正式项目名。

## 已实现的首个里程碑

当前代码实现了与未来 Managed Controller 对齐、但不导入尚不存在 API 的纯 TypeScript 核心：

- lossless JSON snapshot、递归冻结和规范化序列化；
- versioned `ReviewerProviderData` 及可复算配置指纹；
- 不可变 `ActionSnapshot` 和带 domain separator 的 SHA-256 `actionHash`；
- 严格的 `ApprovalRequest`／`ApprovalDecision` 运行时解析；
- 绑定 parent、Reviewer child、generation、action hash 和实际 scoped-tool child 的一次性 `DecisionBroker`；
- invalid、identity mismatch、timeout、abort、duplicate、late 和 unknown 结果处理；
- 按 parent Session 串行、不同 parent 并行的 `ReviewerSessionManager`；
- 一父 Session／一配置代际 Reviewer 的懒创建和复用；
- DSH `approval/request` answerer 的纯适配逻辑；
- 用 `tools/pre-execute` 完整动作补齐窄 `approval/request` 的 capture store；
- 37 项单元测试，以及 TypeScript typecheck／build gate。

`ManagedReviewerController` 是本仓库当前的窄端口。隔壁基础插件可用后，真实 adapter 将把它直接映射到 `registerManagedProvider()` 返回的 Controller。

## 核心安全原则

- **精确父 Agent**：未来 approval hook 必须把 `ApprovalRequest.agent` 原样交给 Managed Controller，不以 session id 重新查找或替代 live authority。
- **结构化协议**：输入和输出均做运行时校验；模型自由文本不能产生审批结果。
- **实例绑定**：结果同时绑定 `reviewId`、parent Session、Reviewer Session、generation、`actionHash` 和实际调用结果工具的 child Session。
- **一次性终结**：首个完全匹配的结果生效；重复、迟到和跨实例结果不产生副作用。
- **失败关闭**：超时、取消、模型／transport 错误、非法输出、身份不匹配和缺失动作快照均不能产生 `allowed-once`。
- **最小权限**：真实 Reviewer setup 将隐藏继承工具，只注册审批结果工具，并设置 approval `never`、sandbox `read-only`、complete prompt 和 runtime-context suppression。
- **不伪装 continuable**：不会用当前 `startContinuable()`／`followup()` 模拟 Managed Agent。

## 审批模式

- `auto`：只有完整验证的 `allow` 自动映射为 `allowed-once`；其他决定或故障均不放行。
- `auto-then-user`：有效 `human_review` 或无法取得完整动作快照时调用 approval waterfall 的 `next()`，转交现有人工 answerer；没有后续 answerer 时由 DSH 失败关闭。

## 当前安全能力边界

DSH `0.1.1-rc.2` 的公开 API 可以隐藏 Reviewer 的继承工具、覆盖 prompt、抑制 runtime context，并设置 read-only sandbox／approval never；但尚不能对所有同进程插件 hook、provider 网络访问或任意 Node.js I/O 提供 OS 级隔离。因此，在基础设施提供更强 composition boundary 前，本项目不会宣称已经实现“绝对无 hooks／plugins／network”的硬沙箱。

## 开发

```bash
npm install
npm run check
```

`npm run check` 依次执行 typecheck、37 项测试和构建。

## 文档

- [项目共识与设计边界](docs/consensus.md)
- [实现状态与后续接入](docs/implementation.md)

## 许可证与上游归属

项目自身许可证尚未确定，当前包标记为 `private`／`UNLICENSED`。DSH 使用 MIT 许可证，计划参考的 Codex Guardian 使用 Apache-2.0。直接复制或改编 Guardian 的提示词与代码时，必须记录上游 commit，保留 Apache-2.0 许可证及第三方归属，并将原样上游 policy 与 DSH adapter 分层存放。
