# dsh-approve-for-me

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 的受管自动审批插件。

> 当前状态：领域协议、应用层和真实 DSH/Managed 契约接入（施工计划 Phase 0–4）已实现并通过 70 项测试。运行仍依赖 `dsh-managed-agent` 的上游补丁；本仓库尚未安装或挂载到任何 DSH 实例（Phase 5 运行时集成待执行）。

## 项目目标

`dsh-approve-for-me` 为每个主 Session 管理一个持久的 Approval Reviewer child。Reviewer 使用独立 Session 和受控模型配置，接收有界、不可变的动作快照，并通过插件自有的结构化结果工具返回审批决定。

这里的“持久”指 Reviewer Session 和 transcript 可以在 Activation 释放后继续保留，并在后续审批时 cold-resume；不要求 Reviewer Agent 永久在线。

本项目是 [`dsh-managed-agent`](../dsh-managed-agent) 的首个业务应用。基础插件为官方 `ctx.subagents` 增加第三种 `managed` mode，并提供 provider 私有的 Controller capability：

```text
registerManagedProvider()
└── controller
    ├── create(parent, options)
    ├── list(parentSessionId)
    ├── deliver(parent, childId, content)
    └── interrupt(parent, childId)
```

基础层只负责受控创建、发现、投递、恢复和停止；审批 schema、singleton、串行、deadline、结果关联和失败关闭全部由本仓库负责。

## 已实现内容

### 真实契约消费（Phase 0）

- 直接消费 `@deepseek-ai/dsh-*@0.1.1-rc.2`、`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/schemastery@3.18.1` 和 `dsh-managed-agent@0.1.0-dev.0`（精确版本）。
- `dsh-managed-agent` 提供对 patched `SubagentRuntime` 的**模块增强**：`ctx.subagents.registerManagedProvider()` 在未打补丁的 npm 类型上也可见，运行时实现仍来自上游补丁。
- 全部本地 `Dsh*` facsimile 已删除；`tests/adapters/real-contract.test.ts` 证明 Provider／Controller／`AgentSetup`／`ToolDefinition`／`approval/request` listener 以真实类型组合，无 `as unknown as` 贯穿 seam。

### 分层（Phase 1–4）

```text
src/
├── index.ts                    # 公共导出（已收窄）
├── plugin.ts                   # Cordis composition root（name/inject/apply）
├── config.ts                   # 可序列化 Config（Schemastery）+ normalizeConfig
├── domain/
│   ├── json.ts                 # lossless JSON／freeze／canonical
│   └── protocol.ts             # providerData／ActionSnapshot／Request／Decision／hash
├── application/
│   ├── decision-channel.ts     # 一次性结果关联、deadline、tombstone
│   ├── reviewer-directory.ts   # find-or-create、代际/指纹选择
│   ├── serial-lanes.ts         # per-parent 串行
│   └── review-coordinator.ts   # 一次审批的完整编排
├── ports/
│   ├── managed-reviewer.ts     # 最窄 managed port + ParentAuthority
│   └── action-projector.ts     # ActionProjector / ActionCapture
├── reviewer/
│   ├── policy.ts               # v1 prompt、decision schema、policy registry
│   ├── provider.ts             # 真实 ManagedSubagentProvider + AgentSetup
│   └── decision-tool.ts        # 真实 ToolDefinition 的两阶段结果工具
└── dsh/
    ├── managed-controller.ts   # ManagedSubagentController → 应用 port
    ├── action-capture.ts       # 真实 ToolExecution 的 capture/release bridge
    └── approval-answerer.ts    # 真实 approval/request waterfall answerer
```

### Reviewer composition

`materialize()` 每次 startup／cold resume 都走同一个 composition factory：

- 严格解析 `providerData`，从 policy registry 解析版本（未知版本失败关闭）；
- `agentOptions` 固定 provider/model；`installModelSelection()` 同时应用 reasoningEffort；
- `systemPrompt.section({ complete: true })` + `suppressRuntimeContext()`；
- `tools.restrict({ allow: [] })` + 注册唯一 `submit_approval_decision`；
- child 会话 approval policy 固定为 `never`、sandbox 固定为 `read-only`；
- setup 只依赖 `childSessionId` 与 `DecisionSink`，不保留 child Agent。

### 决策工具的两阶段输出

```text
ToolDefinition.execute()         校验真实调用者 → 暂存 candidate → concludeTurn()
        ↓  child-scoped tools/result
成功终态才 authorized submit；失败/身份不符/无调用者 -> 丢弃，不产生副作用
```

### 审批模式

- `auto`：只有完整验证的 `allow` 自动映射为 `allowed-once`；其他决定或故障均不放行。
- `auto-then-user`：有效 `human_review` 或无法取得完整动作快照时调用 `next()` 转交人工 answerer。

## 依赖边界

- 领域层（`domain/`）不 import Cordis／DSH 类型。
- 应用层（`application/`、`ports/`）只依赖领域协议与自己的 port。
- `dsh-managed-agent` 仅作为编译期契约（type-only import + 模块增强），运行时零引用。

## 部署前提

1. 目标 DSH 必须应用 `dsh-managed-agent` 锁定基线（`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`）的上游补丁 `patches/0001-managed-subagent-mode.patch`；
2. 配置 `reviewer.generation/provider/model/policyVersion/toolsetVersion`（可选 `mode`、`timeoutMs`、`reasoningEffort`）；
3. 按需通过 `installApproveForMe(ctx, config, { projectPermissions })` 注入权限投影 port（不进入序列化 Config）。

## 开发

```bash
npm install
npm run check
```

`npm run check` 依次执行 typecheck、70 项测试和构建。

## 文档

- [项目共识与设计边界](docs/consensus.md)
- [实现状态与后续接入](docs/implementation.md)
- [Patched-DSH 集成验证清单](docs/integration.md)
- [施工计划](docs/construction-plan.md)

## 许可证与上游归属

项目自身许可证尚未确定，当前包标记为 `private`／`UNLICENSED`。DSH 使用 MIT 许可证，计划参考的 Codex Guardian 使用 Apache-2.0。直接复制或改编 Guardian 的提示词与代码时，必须记录上游 commit，保留 Apache-2.0 许可证及第三方归属，并将原样上游 policy 与 DSH adapter 分层存放。
