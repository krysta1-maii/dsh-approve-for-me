# 实现状态与后续接入

> 状态：2026-08-25。施工计划 Phase 0–4 已完成并提交；Phase 5（patched-DSH 运行时集成验证）尚未执行。本文以当前真实代码为准。

## 当前里程碑

仓库已经改为**真实 DSH 公共契约的编译期消费者**：不再导入任何本地 `Dsh*` facsimile，也不再依赖结构 mock 作为兼容性证据。

### 模块

| 文件 | 职责 |
|---|---|
| `src/config.ts` | `name`／`inject`／Schemastery `Config`／`normalizeConfig` |
| `src/domain/json.ts` | lossless JSON snapshot、递归冻结、canonical JSON |
| `src/domain/protocol.ts` | providerData、ActionSnapshot、ReviewRequest、Decision、hash、结果映射 |
| `src/application/decision-channel.ts` | 一次性 pending 结果、身份校验、timeout／abort、tombstone |
| `src/application/reviewer-directory.ts` | find-or-create、role／generation／fingerprint 选择 |
| `src/application/serial-lanes.ts` | per-parent 串行、跨 parent 并行 |
| `src/application/review-coordinator.ts` | 一次审批的完整编排（ParentAuthority 入口） |
| `src/ports/managed-reviewer.ts` | 最窄 managed port 与 `ParentAuthority` |
| `src/ports/action-projector.ts` | `ActionProjector`／`ActionCapture` 与默认实现 |
| `src/reviewer/policy.ts` | v1 policy、decision schema、policy registry |
| `src/reviewer/provider.ts` | 真实 `ManagedSubagentProvider` 与 `AgentSetup` |
| `src/reviewer/decision-tool.ts` | 真实 `ToolDefinition` 两阶段结果工具 |
| `src/dsh/managed-controller.ts` | 官方 Controller → 应用 port 适配 |
| `src/dsh/action-capture.ts` | 真实 `ToolExecution` 的 capture／release bridge |
| `src/dsh/approval-answerer.ts` | 真实 `approval/request` waterfall answerer |
| `src/plugin.ts` | Cordis composition root |

### 验证

```bash
npm run check
```

当前 70 项测试分布在：

- `tests/domain/` — 协议与 JSON 边界（含 `reasoningEffort` 指纹）；
- `tests/application/` — decision channel、approval-answerer、review coordinator（fake ports）；
- `tests/adapters/` — 动作捕获 bridge、两阶段决策工具、provider materialize／setup、真实契约 fixture、插件组合根。

## 真实契约消费方式

依赖边界（均为精确版本 peer）：

```text
@deepseek-ai/cordis 4.0.1             @deepseek-ai/dsh-sandbox          0.1.1-rc.2
@deepseek-ai/schemastery 3.18.1       @deepseek-ai/dsh-sandbox-policy  0.1.1-rc.2
@deepseek-ai/dsh-agent    0.1.1-rc.2  @deepseek-ai/dsh-session         0.1.1-rc.2
@deepseek-ai/dsh-llm      0.1.1-rc.2  @deepseek-ai/dsh-subagent        0.1.1-rc.2
@deepseek-ai/dsh-system-prompt  0.1.1-rc.2   @deepseek-ai/dsh-tools          0.1.1-rc.2
@deepseek-ai/dsh-user-approval   0.1.1-rc.2
dsh-managed-agent         0.1.0-dev.0
```

`dsh-managed-agent` 只作为编译期契约：`import type` 全部擦除，运行时零引用。其 `src/index.ts` 提供：

1. `Managed*` 契约类型；
2. 对 `SubagentRuntime` 的模块增强（`registerManagedProvider`／`isManagedAgent`／`stopManaged`）；
3. `SubagentRuntime` 类型再导出 —— 该引用强制把 patched 运行时声明（含其 `ctx.subagents` 增强）载入消费者程序，没有它增强不会生效。

`tsc` 在本仓库可见真实 `registerManagedProvider()`，`tests/adapters/real-contract.test.ts` 是 Phase 0 退出条件的持续回归。

## Phase 5 待办（patched-DSH 运行时集成）

见 [docs/integration.md](integration.md)。关键点：runtime 的 `registerManagedProvider()` 来自应用了 `dsh-managed-agent` 上游补丁的 DSH；npm 发布的 `@deepseek-ai/dsh-subagent@0.1.1-rc.2` 不包含该运行时。

## 当前未执行的操作

本项目尚未安装或挂载到任何 DSH profile，也未修改当前运行中的 Web GUI。只有在用户后续明确要求后才进行安装、挂载和 GUI 验证。
