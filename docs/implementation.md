# 实现状态与后续接入

> 当前代码状态（2026-08-28，宿主 v2）：应用层仍运行在 `dsh-managed-agent` 的 `ctx.managedAgents` Guarded Continuable 服务上，typecheck 与 170 项测试通过（本机仍为 0.1.1-rc.2 安装基线）。本阶段新增了 patch 包结构与 `src/approval-gate/` 端口骨架，同时把 `package.json` 的 DSH 依赖面迁到 0.1.2-alpha.1、补上 DSH machine-policy adapter，并实现 P2 纯逻辑组件、`DefaultGatePipeline` 与插件组合根串联；按独立审查加固了 GatePipeline breaker/allow/sealed 语义、D1 确定性/完整性、approval snapshot create-once 冲突、trust-envelope symlink 校验、file record 损坏读取，并在配置 `toolCatalog` 但缺少 patch fork 时启动 fail-loud。0.1.2 fork 的实机构建/挂载、持久化记录（Storage Domain）、卷宗完整投影和真实 Profile/Web 验收尚未实现。当前 `policy-v1` 仍是最小保守占位策略。
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
| `src/application/decision-record.ts` | `InMemoryGateDecisionRecordStore`：最小决策记录，按完整 parent lifecycle fingerprint 处理冲突/幂等；H4 将替换为 Storage Domain 持久化 |
| `src/application/capture-gate-facts.ts` | `InMemoryGateActionFactStore`：按 actionHash 暂存 live authority/action/classification 等 gate facts |
| `src/config.ts` | 增加 `maxReviewsPerChild`、`maxDossierBytes`、`trustEnvelope`、`toolCatalog`、`caseCapture` 的配置声明/默认值/校验；`maxDossierBytes` 默认 256,000 UTF-8 bytes，完整卷宗超限失败关闭 |
| `src/approval-gate/sealed-decision.ts` | 补上 `SealedDispositionRegistryV1` 端口 |
| `src/approval-gate/trust-envelope.ts` | 补上 `TrustEnvelopeInputV1` / `TrustEnvelopeEvaluatorV1` 端口 |

`plugin.ts` 已把 fact store、pre-review、records、breaker/allow-cache/sealed 串进 `DefaultGatePipeline`；配置 `toolCatalog` 时 machine policy 真正认领，未配置时保留 transitional delegating gate 以兼容旧答案器行为。

### H4 记录/案例基础（新增）

| 文件 | 职责 |
|---|---|
| `src/domain/records.ts` | `SessionLifecycleIdentityV1`、`GuardianCaseCaptureConfigV1` 校验、`r1_`/`c1_` key 编码、packet/decision/schema/policy 的版本化 hash domain、artifact 计费字节；并实现 `ReviewDecisionRecordV1` 闭集 schema 与 `parseReviewDecisionRecord()`；`ApprovalReviewPacketV1` codec、`parseGuardianPolicyArtifactV1`、`parseGuardianCaseArtifactV1`（packetHash 重算、observation 闭集）|
| `src/application/record-storage.ts` | `DecisionRecordStorageBackend` 抽象 + `InMemoryDecisionRecordStorageBackend` + `ReviewDecisionRecordStore`（create-once、identical/conflict/unavailable、drain） |
| `src/application/case-capture.ts` | `InMemoryCaseCaptureSink`：full/off、单 artifact/总量限制、按过期/插入序淘汰、drain |
| `src/application/file-record-storage.ts` | `FileDecisionRecordStorageBackend`：磁盘 create-once 后端（`wx` 独占写、canonical 比对、read/drain）；非 DSH Storage Domain 正式 adapter |

当前已具备最小记录与完整案例的 schema/parser、create-once 写端口、in-memory case sink 配额/淘汰与磁盘本地后端；真实 DSH Storage Domain backend、durable read-back、持久化 GC 尚未实现。

### D1 卷宗基础（新增）

| 文件 | 职责 |
|---|---|
| `src/domain/dossier.ts` | `GuardianDossierV1` 顶层结构、`DossierFreezeV1`、`EventRefV1`、`SourceVerifiedDossierV1` module-private brand、`assertDossierShape()`（内部一致性一级）与 `recomputeDossierHash()`；并增加 `InteractionSectionV1`、`InstructionSectionV1`、`ToolTrajectorySectionV1`、`PendingApprovalSectionV1`、`DelegationToolClassificationCatalogV1`、`ParentSessionFactSnapshotV1`、`PrincipalDelegationProjector`、`GuardianDossierCompiler` 等编译端口；实现 `validateDelegationToolCatalog()` 与 `validateToolTrajectorySection()` |
| `src/application/dossier-compiler.ts` | `DefaultDossierCompiler`：校验 principal/authority/execution-fact，要求唯一 execution fact 与 approval snapshot 具有父 session 的完整 lifecycle identity，freeze parent 也保留可选 cwd，且 binding event 必须就是 frozen `approval/asked` seq/type、snapshot 精确绑定该 ask seq；execution actionHash 必须由动作重算，classification descriptor 与 catalog fingerprint 也须精确一致；source snapshot catalog 必须与 compiler 的 delegation projector catalog 逐字节 canonical 一致；严格最小完整前缀要求连续 seq 与非递减 canonical event time，并以 `{ complete: true, sourceThroughSeq, omissions: [] }` 输出 `SourceVerifiedDossierV1` + metrics（canonical 全卷宗与五个 section 的 UTF-8 bytes/characters、catalog fingerprint，不复制 payload），并仅在 DSH `{ header, reason }` 事件含完整 `header.config`、合法 reason，及可选 `header.tools`/字符串 `header.system` 时保留其 canonical header；header 与 `request/context` 均必须早于 pending `tool/call`，同样投影并验证最新 canonical `request/context`（provider/model/contextWindow）；`freeze.frozenAt` 严格绑定 canonical `approval/asked` 的事件时间。direct-user 还必须由 canonical surface placement 标记为可见，且其事件必须早于 canonical pending `tool/call`，防止审批 ask 后的输入倒灌为既有授权。当前严格子集只接受 canonical `tool/call` 作为 execution request；`currentTurnTools.excludedPendingRequest.requestEventSeq` 严格引用该 event 而非审批 ask 序号。可见的 `user/message` 且 `source.form === 'instructions'` 会按原始 event 顺序投影为完整 instruction section；来源字段或内容不合法、或晚于 pending `tool/call` 时失败关闭，且该消息绝不冒充 direct-user evidence。raw `assistant/chunk` 仅作为发生于 pending `tool/call` 之前、由 canonical assistant message 组装的传输事实；若有 assistant/message，则必须是与唯一 canonical pending tool/call 完全一致的单一 tool-call wrapper，避免复制模型文本。pending call 还要求唯一且匹配的开放 `turn/start`/`step/start`，canonical `tool/call`、raw chunks 与 assembled assistant wrapper 的 turn/step 必须精确一致；同 turn/step 的 end 事件会失败关闭。instruction、既有工具、delegation、未知或 surface 状态不确定历史仍拒绝而不静默省略 |
| `src/application/delegation-projector.ts` | `DefaultPrincipalDelegationProjector`：把 delegation attempt + safe receipt 投影为 `PrincipalDelegationEntryV1`，校验 receipt policy / toolName / callId |
| `src/application/fact-repositories.ts` | `InMemoryExecutionFactRepository` / `InMemoryApprovalSnapshotRepository`：以完整 canonical Session lifecycle identity 隔离 sidecar 事实与审批快照的 get/create |

当前已有 D1 编译端口、校验、首个确定性编译器、delegation projector 与 in-memory fact repos。插件已从 canonical `tools/pre-execute`/`session/event` 投影 execution facts 与 immutable approval snapshots，并在事实源处以完整 lifecycle identity（含 cwd）筛除不一致 sidecar；机器决策会等待同一 durable `approval/asked` 事件的 snapshot write，消除 fire-and-forget observer 与 resolver 的竞速。已接入 `DossierGateFactProjector`，它仅从 branded dossier 重建 classification、parent lifecycle、turn、direct-user frontier 与 cache keys；缺少 direct-user evidence 时不产生 facts。完整 instruction/tool 投影、Storage Domain sidecar 与双射验证尚未实现。

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

### R3 工具族语义投影（进行中）

`ToolFamilyActionProjectorRegistry` 是唯一自动审批动作捕获入口：每一个 catalog descriptor 都承诺 `actionSemanticsFamily` 与 `actionProjectorId`，安装器在注册 provider 前验证 descriptor 与 registry 的双向精确覆盖。没有完整且身份匹配的语义快照时，capture 被跳过，自动裁决保持 unavailable。

当前代码级 projector 仅接受明确绑定的工具名与固定参数契约：

- `shell-process-v1`：命令、argv、环境与 Session cwd；
- `filesystem-v1`：显式 read/list/glob/write/edit/delete/move/mkdir 绑定、workspace-relative 目标与递归范围；
- `network-v1`：无默认工具名的 HTTP adapter，绑定规范化目标、方法、header/body 摘要与禁止 follow redirect 的策略。

未实现的 patch/MCP/permission adapter 不得以名称猜测或通用 raw arguments projector 替代；它们在得到 exact adapter schema 与独立正常/缺字段/混淆/超大/不可序列化测试前，均不能进入自动审批 catalog。该阶段尚未完成 R3，不应视为完整风险评估或自动审批能力。

### R4 风险与授权 assessment（保守基线）

`src/domain/risk-assessment.ts` 只从 branded、source-verified dossier 的 action 与 direct-user event refs 生成可审计 assessment；不解析用户文本、不信任模型声明，也不从命令名或 workspace 路径推断授权。现有 structural trigger 覆盖 network/data-exfiltration、filesystem destructive change、`danger-full-access` permission expansion 和 unknown semantics。缺少已证明的 target/side-effect 覆盖时授权保持 `unknown`。

`DossierGateFactProjector` 将该 assessment 加入 source-backed facts。生产 verified-dossier 模式中缺失 assessment 会失败关闭；未知或不完整 assessment 只会跳过 trust/cache/sealed replay 的自动 allow，仍进入 Guardian pre-review。详见 [R4 风险 assessment](risk-assessment.md)。R4 的完整规则、攻击/良性评测与 target-matching verifier 尚未完成。

### R5 policy artifact（进行中）

`policy-v2` 已作为可持久化、显式选择的 Reviewer policy artifact 注册，保留 `policy-v1` 以便历史 descriptor 恢复。它要求基于 source-verified dossier 的精确 action/semantics 审查、分离风险与授权，未知 target、side effect、authorization 或 semantics 均不得 allow。

有 R4 evidence 的 review 现使用不可变 `ApprovalReviewPacketV2`，绑定 request、dossier hash、policy identity 与 R4 baseline；其严格 parser 重算 dossier hash。`policy-v2` 的 scoped decision tool 要求模型提交版本化 target/side-effect coverage 与唯一 source refs。source-backed facts 将 selected policy、verified dossier 与 baseline 贯穿 Gate、ReviewCoordinator 和 pre-seal 边界；模型不得降低已证实风险、遗漏类别、引用卷宗之外的 source，或声称超过 baseline 的 coverage。证据不足的 allow 会变为 human，禁止性 allow 会变为 deny，已有 deny/human 不会被弱化。

R5 仍不构成成熟自动审批能力：R4 尚未具备已证明的 target/side-effect matcher，故其 baseline 默认不授权；未实现工具族也不能进入自动 catalog。

### R6 review runs（进行中）

Pre-review 现生成 host-owned `reviewRunId` 并将单一绝对 deadline 交给 Reviewer coordinator；sealed disposition 保存 run ID 而非某个 protocol attempt ID。污染 child 的一次 rotate recovery 不消耗业务 attempt，也不能延长 deadline。Coordinator 当前只会对经 owning child 路由的 `invalid-result` 进行一次业务重试；未知 delivery/provider 错误、身份不匹配、abort 与 timeout 均保持 fail-closed。

### R7 exact denial breaker（进行中）

Exact breaker 的 key 限定 parent lifecycle、turn、direct-user frontier 与完整 `actionHash`；它只在 Guardian 明确 `deny` 后写入。`human_review` 即使在 `auto` mode 映射为 rejected 也不建立熔断，避免把人工下沉误变成跨 ask 的拒绝事实。不同 hash、turn、frontier 或 lifecycle 只能重新审查，绝不命中 allow。

### R9 default-minimal audit（进行中）

生产 Gate 的 Storage Domain 决策行现在是闭集、版本化的最小审计记录：完整 parent lifecycle／ask／call／action hash、configuration 和 generation 之外，还保存实际 route（trust envelope、allow cache、sealed replay 或 Guardian）、规范化 Guardian decision、最终插件 disposition，以及仅在真实 Guardian/重放路径可得的 `reviewRunId`。该行明确拒绝 rationale、decision payload、packet、dossier、tool arguments 和任何未定义字段。

自动 allow 仍必须在其 compact row durable-confirmed 后才返回；Guardian deny 与 human 的记录是 best-effort，记录失败不能改变拒绝或人工下沉。facts 已解析后却未取得 Guardian decision 的 terminal failure 另写为闭集 `post-facts-failure` 行：它仅保留 identity、固定 failure stage 与 `unavailable`/`delegate` 结果，零 attempts/rotations，不含 reviewRunId 或内容；已失效、已消费或身份不匹配的 sealed replay 同样只留 `sealed-replay` failure stage，绝不保存其原因。取消不写入，且 allow 确认后的 abort/deadline 不覆盖 authorization-point 行。Reviewer telemetry 已接入 coordinator 与最终 Gate fallback：仅聚合结果、时长、attempt、污染轮换和固定失败类别，不保存身份或内容，观察器异常也不影响裁决。每个 Guardian/sealed 路径还会保存内容无关的 protocol attempt 数及污染 child recovery 尝试／成功数；fast path 固定为零，parser 强制 route 与该摘要一致。完整 ReviewDecisionRecord、逐次 attempt/recovery 的 durable audit，以及 full case capture durable backend 仍未接线，不能由此最小行推断。为避免将内存测试 double 误报为生产留存，插件在该 durable adapter 就绪前会拒绝 `caseCapture.mode: full` 安装。

### 验证

```bash
npm run check   # 本机 0.1.1-rc.2 安装基线：typecheck + 275 项测试 + build
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
