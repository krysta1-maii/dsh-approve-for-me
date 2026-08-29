# dsh-approve-for-me 当前施工计划

> 状态：2026-08-28，宿主方案 v2（机器决策槽）。本文从“插件本体 + 官方 patch”的仓库形态出发安排后续实现；不再保留 companion Host Profile／thin composer adapter 方案。旧计划与旧宿主契约已归档/被替代，文档职责和权威顺序见 [文档地图](README.md)。

## 1. 施工目标

将当前“协议与运行骨架”建设为可在 patched `dsh-user-approval` + stock DSH 0.1.2-alpha.1 中验收的自动审批产品：

- 官方只 patch `@deepseek-ai/dsh-user-approval`：`requestId` + `registerMachinePolicy()`；
- 本体插件注册唯一机器决策槽，机器裁决拥有与 listener 顺序无关的确定性优先级；
- `trustEnvelope` 快路径 + deny breaker/allow-cache 让长程任务尽量无人值守；
- 只有 source-verified 卷宗、合法 Guardian 结果和 durable 决策事实可以产生 `allowed-once`；
- 身份、hash、generation、事实完整性和协议冲突始终失败关闭；
- `dsh-managed-agent` 保持独立仓库，作为依赖插件提供 Guarded Continuable reviewer child。

完整语义以 [宿主契约](host-contract.md) 与 [卷宗规范](guardian-dossier.md) 为准，本文不重复接口。

## 2. 当前基线

### 已完成

- companion `dsh-managed-agent` 的 `ctx.managedAgents.registerProvider()` 接入；
- providerData、ActionSnapshot、`actionHash` 与 ApprovalDecision 协议；
- 一次性 decision channel、deadline、abort、tombstone；
- per-parent lane 与 Managed Reviewer create／reuse／污染轮换；
- Reviewer composition、唯一 scoped decision tool、`approval=never`、`sandbox=read-only`；
- `tools/pre-execute` 动作捕获骨架与标准 DSH bundle 包装；
- **patch 包结构**：`patch/dsh-user-approval/` 的 overlay、upstream.json、build/verify 脚本、机器决策槽测试；
- **`src/approval-gate/` 端口骨架**：catalog、trust-envelope、breaker、sealed-decision、machine-policy。

### 尚未完成

- 0.1.2-alpha.1 迁移（本体与依赖插件的 peer/类型面）；
- 本体 `registerMachinePolicy` 适配器与决策管线实现；
- trustEnvelope、deny breaker、allow-cache；
- source-backed dossier compiler 和 Storage Domain fact adapters；
- 最小决策记录与 opt-in full case capture；
- 完整风险／授权 policy；
- 真实 Profile、Web、cold resume、HMR 和卸载验收。

当前代码事实的逐文件清单见 [implementation.md](implementation.md)。

## 3. v2 部署组成

```text
stock DSH 0.1.2-alpha.1（不修改）
+ dsh-user-approval fork tarball（本仓库 patch/ 产出）
+ dsh-managed-agent（独立仓库，依赖插件）
+ dsh-approve-for-me（本仓库，插件本体）
```

官方 patch 只有两处新增，未注册机器策略时行为与上游一致；fork tarball 保留原名/版本并用 `dshApprovalPatch` 标记第三方身份。构建与校验见 `patch/dsh-user-approval/README.md`。

## 4. 实施阶段

### P0：0.1.2 基线迁移

- 本体与 `dsh-managed-agent` 的 peer deps/类型面迁到 0.1.2-alpha.1（`CallId→ToolCallId`、`tools/ptc-dispatch-log`、scoped `this` 等）；
- `upstream.json` 固定完整 40 位 SHA；fork 构建拒绝短 SHA 和 `SKIP_BUILD=1`，并在打包前运行 `approval-machine-policy.spec.ts`；
- `verify-target-host.mjs` 校验目标 host 的版本、精确 commit/tag、fork marker/API 与 SHA-256；
- CI 从 `deepseek-harness@cd5ef8148158c3a752a658978873241fdf8e2bbc` 构建、校验并上传 tarball 和 checksum。根目录的 rc.2 lockfile 绿测仅是遗留回归基线，不能替代该 lane。

退出条件：两仓库在 0.1.2 上 typecheck/tests 全绿；patch 的 CI 版本门禁生效；目标 Profile 的已安装包也通过 marker 校验。

### P1：机器决策槽接入

- `src/approval-gate/machine-policy.ts` 的 DSH adapter：把 patched `MachineApprovalPolicy` 映射到应用端口；
- `apply()` 只注册 `registerMachinePolicy()`，disposer 归 Cordis effect；删除 AFM 的 `approval/request` answerer 和 transitional delegating gate；
- fork 把 machine policy 实现为全局独占槽，任意第二个注册失败；`delegate` 只进入官方人工 waterfall；
- 缺 requestId/callId、缺捕获、身份/完整性冲突均 `unavailable`；只有显式 retryable capability failure 可在 `auto-then-user` 中 `delegate`。

退出条件：唯一机器决策先于 interactive waterfall；`never` 优先；任意第二 policy 拒绝；异常及完整性缺失 fail-closed。

### P2：裁决管线产品化

- classifier（闭集 catalog）→ trustEnvelope 快路径 → deny breaker/allow-cache → Guardian 裁决 → 模式映射；
- 自动 allow 前 durable 最小记录；attempt/deadline/串行沿用现有骨架。

退出条件：包络内动作 0 人工；包络外走 Guardian；身份/完整性冲突永不进入 delegate。

> 施工状态（2026-08-29）：Reviewer 交付物已切换为 `ApprovalReviewPacketV1`，由 source-verified dossier hash 绑定，不再向 Reviewer 发送 action-only JSON。生产 gate 在完整 dossier 接入前先返回 `unavailable`，因此 trust-envelope、缓存或 Guardian 均不能绕过证据门槛。Gate 的 session/action facts 现从精确 `approval/asked` 与 Session event log 推导 turn、direct-user frontier 和 root 状态；尚未有目标宿主 Storage Domain durable record 前，自动 allow 继续关闭。

### D1：事实源与卷宗 compiler

- parent Session fact source + Storage Domain sidecar（`requestId` 精确绑定 asked）；
- root-principal／delegation-envelope 归因与 direct child-origin 排除；
- 五段式 immutable dossier + source-verified brand + 硬预算。

退出条件：卷宗规范第 16 节测试成立；缺失、漂移或损坏事实不能产生 ready dossier。

> 施工状态（2026-08-29）：已建立 exact-Agent/Session 的 `ParentSessionFactSource`、按 `approval/asked.data.id` 绑定的快照和 create-once execution/result 事实仓储；Session 身份、事件连续性、ask/call 对应关系和投影冲突均 fail-closed。当前 compiler 对 `completeness.ready !== true` 一律返回 `incomplete`，故尚未完成五段卷宗前不存在 Reviewer 或自动 allow 入口。

### H4：决策事实与案例留存

- `review_records` 最小记录、durability gate；
- 使用目标宿主 `ctx.storageDomain` 的私有 `afm_decision_records` domain；由插件内部 per-key lane 串行 `get → put`，保证本进程唯一 machine-policy writer 的 create-once 语义，domain close 前停止入场并 drain。
- `caseCapture.mode: full` 的 canonical artifact、quota／TTL／GC；
- host-private 访问、parent deletion cascade、脱敏导出。

退出条件：默认不保存完整 packet；案例或 telemetry 失败不改变 deny／fallback，且不能绕过 allow 的最小记录门槛。

### RP：Reviewer 产品能力主线

沿用 [Reviewer 独立实现路线](reviewer-roadmap.md) 的 R1–R9：tool-family action semantics → risk taxonomy → user authorization assessment → 完整 policy → 审计指标。

### I1：真实集成验收

按 [integration.md](integration.md) 在 patched `dsh-user-approval` + stock DSH 0.1.2 + `dsh-managed-agent` 上验证：首次物化、复用、cold resume、自动/人工映射、Abort 竞速、输入守卫、HMR、卸载、Storage Domain durability、Web 审批与 Stop、长程 soak（包络内 0 人工、0 误放行）。

## 5. 依赖关系

```text
P0 0.1.2 迁移 ──→ P1 机器决策槽 ──→ P2 裁决管线 ──┐
                                                 ├─→ H4 记录/案例 ──→ I1
D1 事实源/卷宗 compiler ──────────────────────────┘
        └─→ RP Reviewer 产品主线 ────────────────────┘
```

P1 与 D1 可以并行；P2 需要可用的机器决策槽与事实源；I1 的最终产品结论还要求 R1–R5 完成，不能用宿主运行正确掩盖 Reviewer 语义尚未成熟。

## 6. 每阶段完成纪律

每个阶段至少需要：

1. 版本化接口与不变量；
2. 对 patched DSH API 的真实类型适配；
3. 正常、失败和对抗性测试；
4. `npm run check` 与文档代码块／链接检查；
5. 更新 `implementation.md` 的已实现事实；
6. 若契约变化，先更新对应权威文档，再更新共识摘要；
7. 一次边界清楚的 Git 提交。

## 7. 当前施工入口

下一步从 **P0 0.1.2 基线迁移** 开始：先在依赖插件仓库和本仓库把 peer/类型面迁到 0.1.2-alpha.1，并让 `patch/dsh-user-approval` 的 fork 构建与测试进入 CI；随后进入 P1。`dsh plugin --profile web add` 当前只用于骨架开发，不构成产品级部署。
