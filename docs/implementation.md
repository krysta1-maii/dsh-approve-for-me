# 实现状态与后续接入

> 当前代码状态（2026-08-28，宿主 v2）：应用层仍运行在 `dsh-managed-agent` 的 `ctx.managedAgents` Guarded Continuable 服务上，typecheck 与 160 项测试通过（本机仍为 0.1.1-rc.2 安装基线）。本阶段新增了 patch 包结构与 `src/approval-gate/` 端口骨架，同时把 `package.json` 的 DSH 依赖面迁到 0.1.2-alpha.1、补上 DSH machine-policy adapter，并实现 P2 纯逻辑组件、`DefaultGatePipeline` 与插件组合根串联；0.1.2 fork 的实机构建/挂载、持久化记录（Storage Domain）、卷宗 compiler 和真实 Profile/Web 验收尚未实现。当前 `policy-v1` 仍是最小保守占位策略。
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

### machine-policy 接入（P1 起步，新增）

| 文件 | 职责 |
|---|---|
| `src/dsh/machine-policy-adapter.ts` | 把 patched `ApprovalRequestEvent` 映射到 DSH-neutral `GateMachineRequestV1`，保持稳定的 `dsh-approve-for-me/v1` id |
| `src/application/delegating-gate.ts` | transitional gate：当前一律 `'delegate'`，在 P2 管线落地前不改变授权行为 |
| `src/plugin.ts` | 若宿主 approval 服务提供了 `registerMachinePolicy()` 则注册 adapter；disposer 归入插件 dispose |

默认（未配置 `toolCatalog`）时 machine policy 仍不认领；配置冻结工具目录后，机器策略通过 `DefaultGatePipeline` 真正产生 allow/deny/human 映射。

### P2 纯逻辑组件（新增）

| 文件 | 职责 |
|---|---|
| `src/application/breaker.ts` | `InMemoryExactDenialBreaker`（精确 deny 熔断）与 `InMemoryAllowCache`（精确 allow 缓存），均按 parent lifecycle/turn/frontier 作用域 |
| `src/application/sealed-decision.ts` | `InMemorySealedDispositionRegistry`：seal / lookup / consume / clearParent，错误 callId/actionHash 只能 mismatch |
| `src/application/tool-classifier.ts` | `createToolApprovalClassifier`：闭集分类，未知/漂移都 fail closed |
| `src/application/trust-envelope.ts` | `createTrustEnvelopeEvaluator`：工具族、mode ceiling、workspace、justification、strict widening 纯判定 |
| `src/application/pre-review-coordinator.ts` | `DefaultPreReviewCoordinator`：用现有 Guardian `ReviewCoordinator` 产出并 sealed 一条前置裁决，之后只能 replay |
| `src/application/gate-pipeline.ts` | `DefaultGatePipeline`：按 breaker → trustEnvelope → allowCache → seal replay → Guardian → 模式映射/记录三态执行 |
| `src/application/decision-record.ts` | `InMemoryGateDecisionRecordStore`：最小决策记录，冲突/幂等语义；H4 将替换为 Storage Domain 持久化 |
| `src/application/capture-gate-facts.ts` | `InMemoryGateActionFactStore`：按 actionHash 暂存 live authority/action/classification 等 gate facts |
| `src/config.ts` | 增加 `maxReviewsPerChild`、`trustEnvelope`、`toolCatalog`、`caseCapture` 的配置声明/默认值/校验 |
| `src/approval-gate/sealed-decision.ts` | 补上 `SealedDispositionRegistryV1` 端口 |
| `src/approval-gate/trust-envelope.ts` | 补上 `TrustEnvelopeInputV1` / `TrustEnvelopeEvaluatorV1` 端口 |

`plugin.ts` 已把 fact store、pre-review、records、breaker/allow-cache/sealed 串进 `DefaultGatePipeline`；配置 `toolCatalog` 时 machine policy 真正认领，未配置时保留 transitional delegating gate 以兼容旧答案器行为。

### H4 记录/案例基础（新增）

| 文件 | 职责 |
|---|---|
| `src/domain/records.ts` | `SessionLifecycleIdentityV1`、`GuardianCaseCaptureConfigV1` 校验、`r1_`/`c1_` key 编码、packet/decision/schema/policy 的版本化 hash domain、artifact 计费字节；并实现 `ReviewDecisionRecordV1` 闭集 schema 与 `parseReviewDecisionRecord()`；`ApprovalReviewPacketV1` codec、`parseGuardianPolicyArtifactV1`、`parseGuardianCaseArtifactV1`（packetHash 重算、observation 闭集）|
| `src/application/record-storage.ts` | `DecisionRecordStorageBackend` 抽象 + `InMemoryDecisionRecordStorageBackend` + `ReviewDecisionRecordStore`（create-once、identical/conflict/unavailable、drain） |
| `src/application/case-capture.ts` | `InMemoryCaseCaptureSink`：full/off、单 artifact/总量限制、按过期/插入序淘汰、drain |

当前已具备最小记录与完整案例的 schema/parser、create-once 写端口、in-memory case sink 配额/淘汰；真实 DSH Storage Domain backend、durable read-back、持久化 GC 尚未实现。

### D1 卷宗基础（新增）

| 文件 | 职责 |
|---|---|
| `src/domain/dossier.ts` | `GuardianDossierV1` 顶层结构、`DossierFreezeV1`、`EventRefV1`、`SourceVerifiedDossierV1` module-private brand、`assertDossierShape()`（内部一致性一级）与 `recomputeDossierHash()`；并增加 `InstructionSectionV1`、`ToolTrajectorySectionV1`、`PendingApprovalSectionV1`、`DelegationToolClassificationCatalogV1`、`ParentSessionFactSnapshotV1`、`PrincipalDelegationProjector`、`GuardianDossierCompiler` 等编译端口；实现 `validateDelegationToolCatalog()` 与 `validateToolTrajectorySection()` |
| `src/application/dossier-compiler.ts` | `DefaultDossierCompiler`：校验 principal/authority/execution-fact，输出 `SourceVerifiedDossierV1` + metrics；section 内容当前为保守最小化 |
| `src/application/delegation-projector.ts` | `DefaultPrincipalDelegationProjector`：把 delegation attempt + safe receipt 投影为 `PrincipalDelegationEntryV1`，校验 receipt policy / toolName / callId |

当前已有 D1 编译端口、校验、首个确定性编译器与 delegation projector；完整 instruction/tool 投影与双射验证尚未实现。

### 既有骨架（0.1.1-rc.2 基线）

| 文件 | 职责 |
|---|---|
| `src/config.ts` | `name`／`inject`（含 `managedAgents`）／Schemastery `Config`／`normalizeConfig` |
| `src/domain/json.ts` | lossless JSON snapshot、递归冻结、canonical JSON |
| `src/domain/protocol.ts` | providerData、ActionSnapshot、ReviewRequest、Decision、hash、结果映射 |
| `src/application/decision-channel.ts` | 一次性 pending 结果、身份校验、timeout／abort、tombstone；v2 修复：invalid payload 路径先校验 actual Reviewer 再终结 pending |
| `src/application/reviewer-directory.ts` | find-or-create、role／generation／fingerprint 选择、污染跳过 |
| `src/application/serial-lanes.ts` | per-parent 串行、跨 parent 并行；v2 新增 `drain()` 等待当前 lane 任务 settle |
| `src/application/review-coordinator.ts` | 审批编排（ParentAuthority 入口、污染 rotate + 单次 fresh-child 重试） |
| `src/ports/*` | 最窄 managed port、ActionProjector／ActionCapture |
| `src/reviewer/*` | v1 policy、真实 ManagedAgentProvider、两阶段决策工具 |
| `src/dsh/*` | managed-controller、action-capture、approval-answerer（待迁移为机器策略 adapter） |
| `src/plugin.ts` | Cordis composition root |

### 验证

```bash
npm run check   # 本机 0.1.1-rc.2 安装基线：typecheck + 160 项测试 + build
bash -n patch/dsh-user-approval/scripts/build-fork.sh
node --check patch/dsh-user-approval/scripts/*.mjs
```

> 说明：`package.json` 已经声明 0.1.2-alpha.1 目标版本，但本机 node_modules 与 `package-lock.json` 仍是 0.1.1-rc.2 安装基线；等 0.1.2 fork/官方包可在本地构建或取得后再重新生成 lock 并做真实类型验收。

## 真实契约消费方式（本机 0.1.1-rc.2 安装基线）

`package.json` 已声明目标依赖为 0.1.2-alpha.1（见下一段）；以下仍是本机 node_modules 实际安装的基线：

```text
@deepseek-ai/cordis 4.0.1             @deepseek-ai/dsh-sandbox-policy  0.1.1-rc.2
@deepseek-ai/schemastery 3.18.1       @deepseek-ai/dsh-session         0.1.1-rc.2
@deepseek-ai/dsh-agent    0.1.1-rc.2  @deepseek-ai/dsh-subagent        0.1.1-rc.2
@deepseek-ai/dsh-llm      0.1.1-rc.2  @deepseek-ai/dsh-system-prompt  0.1.1-rc.2
@deepseek-ai/dsh-sandbox  0.1.1-rc.2  @deepseek-ai/dsh-tools          0.1.1-rc.2
@deepseek-ai/dsh-user-approval   0.1.1-rc.2
dsh-managed-agent         0.1.0-dev.0
```

v2 目标改为 0.1.2-alpha.1 + fork tarball；本仓库 `package.json` 已完成版本声明，剩余 0.1.2 类型面/实机核验在 P0 完成（fork 构建脚本也已按 0.1.2 根聚合构建方式更新）。

## 下一阶段

按 [当前施工计划](construction-plan.md)：P0 0.1.2 迁移 → P1 机器决策槽接入 → P2 裁决管线 → D1 卷宗 → H4 记录/案例 → I1 真实验收；Reviewer 产品化沿用 [Reviewer 路线图](reviewer-roadmap.md) R1–R9。

宿主目标语义已确定：机器决策槽确定性优先、trustEnvelope 快路径、deny breaker/allow-cache、单 deadline 最多两个 attempts、决策 facts 强持久化／telemetry 尽力写入、Reviewer route 显式固定。文档描述的是下一阶段验收契约，不得误报为已完成能力。

## 当前未执行的操作

本项目尚未安装或挂载到真实 0.1.2 DSH profile，也未执行 patch fork 的实际构建、profile／GUI 验收；同时当前 Reviewer 尚不具备父会话证据、完整风险策略和上下文工程。在 P0–I1 与 R1–R5 完成前，不应把当前版本描述为成熟的自动审批产品。
