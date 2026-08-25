# 实现状态与后续接入

> 当前代码状态（2026-08-25）：应用层已迁移到标准 `ctx.managedAgents` Guarded Continuable 服务，typecheck 与 82 项测试通过；标准 bundle 包装（`dsh.bundle.patch` / `cordis.patch.yml` / `npm pack`）已完成，真实 DSH profile 人工验收尚未执行。
>
> 目标部署路线是未修改官方包的 stock DSH + `dsh-managed-agent` Host/Client bundle。跨仓库施工计划见 [`dsh-managed-agent/docs/guarded-continuable-migration-plan.md`](../../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)。

## 当前里程碑

仓库已经改为**标准 `ctx.managedAgents` 的编译期与运行时契约消费者**：不再调用 patched `ctx.subagents.registerManagedProvider()`，也不再导入任何本地 `Dsh*` facsimile。

### 模块

| 文件 | 职责 |
|---|---|
| `src/config.ts` | `name`／`inject`（含 `managedAgents`）／Schemastery `Config`／`normalizeConfig` |
| `src/domain/json.ts` | lossless JSON snapshot、递归冻结、canonical JSON |
| `src/domain/protocol.ts` | providerData、ActionSnapshot、ReviewRequest、Decision、hash、结果映射 |
| `src/application/decision-channel.ts` | 一次性 pending 结果、身份校验、timeout／abort、tombstone |
| `src/application/reviewer-directory.ts` | find-or-create、role／generation／fingerprint 选择、永久跳过 contaminated child |
| `src/application/serial-lanes.ts` | per-parent 串行、跨 parent 并行 |
| `src/application/review-coordinator.ts` | 一次审批的完整编排（ParentAuthority 入口、污染后 rotate + 单次 fresh-child 重试） |
| `src/ports/managed-reviewer.ts` | 最窄 managed port、`ParentAuthority`、contaminated 只读视图 |
| `src/ports/action-projector.ts` | `ActionProjector`／`ActionCapture` 与默认实现 |
| `src/reviewer/policy.ts` | v1 policy、decision schema、policy registry |
| `src/reviewer/provider.ts` | 真实 `ManagedAgentProvider`、`AgentSetup`、`toolFilter` |
| `src/reviewer/decision-tool.ts` | 真实 `ToolDefinition` 两阶段结果工具 |
| `src/dsh/managed-controller.ts` | `ManagedAgentController` → 应用 port 适配（含 contaminated 映射） |
| `src/dsh/action-capture.ts` | 真实 `ToolExecution` 的 capture／release bridge |
| `src/dsh/approval-answerer.ts` | 真实 `approval/request` waterfall answerer |
| `src/plugin.ts` | Cordis composition root |

### 验证

```bash
npm run check
```

当前 82 项测试分布在：

- `tests/domain/` — 协议与 JSON 边界（含 `reasoningEffort` 指纹）；
- `tests/application/` — decision channel、approval-answerer、review coordinator（fake ports，含污染隔离与重试）；
- `tests/adapters/` — 动作捕获 bridge、两阶段决策工具、provider materialize／setup、真实 `ctx.managedAgents` 契约 fixture、插件组合根。

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

`dsh-managed-agent` Host 在官方 `continuable` child 上提供 `ctx.managedAgents`，不修改官方 DSH 包。本仓库只依赖该服务：

1. `ctx.managedAgents.registerProvider()` 返回 registration-scoped `ManagedAgentController`；
2. `ManagedAgentController.list()` 返回包含持久 `contaminated` 标志的 owned-child 视图；
3. `ManagedAgentController.rotate()` 可用于排空受污染 child 并预留干净替代；
4. 项目通过 `ManagedAgentProvider` 的 `materialize()` 同步返回 `ManagedAgentComposition`（`agentOptions`、`toolFilter`、`setup`）；
5. `tests/adapters/real-contract.test.ts` 是对新接口的持续类型回归。

## 下一阶段

应用迁移（Phase 3）与标准 bundle 包装（Phase 4 包侧部分）已完成。后续为：

**Phase 5**：在真实 stock DSH profile 中安装并验收（首次物化、复用、cold resume、污染轮换、unload/reload、Web 只读与 Stop）。

完整顺序见 [跨仓库改造计划](../../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)，stock DSH 验收见 [integration.md](integration.md)。

## 当前未执行的操作

本项目已迁移到 `ctx.managedAgents` 且已具备标准 bundle 元数据，但尚未安装或挂载到任何 DSH profile，也未执行 Phase 5 的真实 profile 与 GUI 验收。Phase 5 完成后才可进行 stock DSH 产品验收。
