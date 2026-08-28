# 实现状态与后续接入

> 当前代码状态（2026-08-28，宿主 v2）：应用层仍运行在 `dsh-managed-agent` 的 `ctx.managedAgents` Guarded Continuable 服务上，typecheck 与 82 项测试通过（0.1.1-rc.2 基线）。本阶段新增了 patch 包结构与 `src/approval-gate/` 端口骨架；0.1.2-alpha.1 迁移、本体 `registerMachinePolicy` 适配、trustEnvelope/breaker/allow-cache、卷宗 compiler 和真实 Profile/Web 验收尚未实现。当前 `policy-v1` 仍是最小保守占位策略。
>
> 当前事实、候选契约和施工路线的职责划分见 [文档地图](README.md)。目标部署是 patched `dsh-user-approval` + stock DSH 0.1.2-alpha.1 + `dsh-managed-agent`（独立仓库依赖插件）+ 本插件。

## 当前里程碑

### patch 包（新增，结构就绪）

`patch/dsh-user-approval/` 已具备：

- `upstream.json`：锁定 `dsh-v0.1.2-alpha.1` / `cd5ef81481`；
- `overlay/src/{index,types,invariant}.ts`：只含两处增量——`ApprovalRequestEvent.requestId`、`ApprovalService.registerMachinePolicy()`；
- `overlay/tests/approval-machine-policy.spec.ts`：机器策略优先于 prepend answerer、`never` 优先、delegate 链、disposer、异常 fail-closed、requestId 审计绑定；
- `scripts/build-fork.sh`：worktree 重建 + 打标记 + pack + 校验；`mark-package.mjs`、`verify-fork.mjs`。

### approval-gate 端口骨架（新增，类型就绪）

| 文件 | 状态 |
|---|---|
| `catalog.ts` | 类型/端口：ordinary / gate-ask / body-escalation 闭集分类 |
| `trust-envelope.ts` | 类型/端口：确定性信任包络评估结果 |
| `breaker.ts` | 类型/端口：精确拒绝熔断与 allow-cache |
| `sealed-decision.ts` | 类型/端口：前置裁决密封与重放身份 |
| `machine-policy.ts` | 类型/端口：DSH-neutral `GateMachinePolicyV1` |

### 既有骨架（0.1.1-rc.2 基线）

| 文件 | 职责 |
|---|---|
| `src/config.ts` | `name`／`inject`（含 `managedAgents`）／Schemastery `Config`／`normalizeConfig` |
| `src/domain/json.ts` | lossless JSON snapshot、递归冻结、canonical JSON |
| `src/domain/protocol.ts` | providerData、ActionSnapshot、ReviewRequest、Decision、hash、结果映射 |
| `src/application/decision-channel.ts` | 一次性 pending 结果、身份校验、timeout／abort、tombstone |
| `src/application/reviewer-directory.ts` | find-or-create、role／generation／fingerprint 选择、污染跳过 |
| `src/application/serial-lanes.ts` | per-parent 串行、跨 parent 并行 |
| `src/application/review-coordinator.ts` | 审批编排（ParentAuthority 入口、污染 rotate + 单次 fresh-child 重试） |
| `src/ports/*` | 最窄 managed port、ActionProjector／ActionCapture |
| `src/reviewer/*` | v1 policy、真实 ManagedAgentProvider、两阶段决策工具 |
| `src/dsh/*` | managed-controller、action-capture、approval-answerer（待迁移为机器策略 adapter） |
| `src/plugin.ts` | Cordis composition root |

### 验证

```bash
npm run check   # 0.1.1-rc.2 基线：typecheck + 82 项测试 + build
bash -n patch/dsh-user-approval/scripts/build-fork.sh
node --check patch/dsh-user-approval/scripts/*.mjs
```

## 真实契约消费方式（0.1.1-rc.2 基线）

依赖边界（均为精确版本 peer）：

```text
@deepseek-ai/cordis 4.0.1             @deepseek-ai/dsh-sandbox-policy  0.1.1-rc.2
@deepseek-ai/schemastery 3.18.1       @deepseek-ai/dsh-session         0.1.1-rc.2
@deepseek-ai/dsh-agent    0.1.1-rc.2  @deepseek-ai/dsh-subagent        0.1.1-rc.2
@deepseek-ai/dsh-llm      0.1.1-rc.2  @deepseek-ai/dsh-system-prompt  0.1.1-rc.2
@deepseek-ai/dsh-sandbox  0.1.1-rc.2  @deepseek-ai/dsh-tools          0.1.1-rc.2
@deepseek-ai/dsh-user-approval   0.1.1-rc.2
dsh-managed-agent         0.1.0-dev.0
```

v2 目标改为 0.1.2-alpha.1 + fork tarball；迁移在 P0 完成。

## 下一阶段

按 [当前施工计划](construction-plan.md)：P0 0.1.2 迁移 → P1 机器决策槽接入 → P2 裁决管线 → D1 卷宗 → H4 记录/案例 → I1 真实验收；Reviewer 产品化沿用 [Reviewer 路线图](reviewer-roadmap.md) R1–R9。

宿主目标语义已确定：机器决策槽确定性优先、trustEnvelope 快路径、deny breaker/allow-cache、单 deadline 最多两个 attempts、决策 facts 强持久化／telemetry 尽力写入、Reviewer route 显式固定。文档描述的是下一阶段验收契约，不得误报为已完成能力。

## 当前未执行的操作

本项目尚未安装或挂载到真实 0.1.2 DSH profile，也未执行 patch fork 的实际构建、profile／GUI 验收；同时当前 Reviewer 尚不具备父会话证据、完整风险策略和上下文工程。在 P0–I1 与 R1–R5 完成前，不应把当前版本描述为成熟的自动审批产品。
