# 实现状态与后续接入

> 当前代码状态（2026-08-31，alpha.2 基线）：精确适配 DSH `0.1.2-alpha.2`（commit `0a53fb55bea101816fa226bb964ae2bed71c343b`，tag `dsh-v0.1.2-alpha.2`），机器决策槽 v2。宿主闭包直接安装 npm 上已发布的 `0.1.2-alpha.2` 包；`npm run check` 通过 42 个测试文件、329 项测试。生产 loader 直接读取 DSH `llm` provider/model catalog，注册机器策略前校验稳定 route 与 reasoning effort，并继续复用 DSH runtime model selection。三原子 demo kit、approval fork、installed target host、package smoke 与 disposable Profile artifact smoke 均可在 alpha.2 上验收；Profile smoke 覆盖真实 `dsh plugin add`、Cordis compose、一次真实自动放行 side effect、人工拒绝兜底和全新进程重启后的相同 tool catalog。
>
> 尚未完成的是“产品级 E2E”：真实 LLM Reviewer 的 allow/deny/human_review、浏览器中官方审批面板、带 pending approval/child 状态的真实跨进程冷恢复、污染/容量/卸载的故障注入与长程 soak。当前任何 automatic allow 仍被 branded source-verified dossier、R4 基线和 durable decision record 约束。

## 当前里程碑

### P0 patch 包（完成）

`patch/dsh-user-approval/`：

- `upstream.json` 锁定 `dsh-v0.1.2-alpha.2` / `0a53fb55be…`，patch version 2；
- overlay 只含两处增量：`ApprovalRequestEvent.requestId`、`ApprovalService.registerMachinePolicy()`；alpha.2 上游在该包内的唯一改动（`order: 115` → `getContextOrder('APPROVAL_POLICY')`）已并入 overlay；
- `build-fork.sh` 在 throwaway clone（`.build/upstream-clone`）中检出固定 commit 后重建、测试、构建、打包并写 SHA-256 sidecar；上游 checkout 只被读取，不再注册 worktree，HEAD 位置不影响构建；
- `.build/dsh-user-approval-afm-0.1.2-alpha.2.tgz` 已通过 `verify:approval-fork` 与 `verify:target-host`。

### P1 机器决策槽接入（完成）

- `src/dsh/machine-policy-adapter.ts` 把 patched `ApprovalRequestEvent` 投影为 `GateMachineRequestV1`，保持稳定 id `dsh-approve-for-me/v1`；
- fork 的 `decide()` 语义：`never` 先于机器策略；非 `'delegate'` 合法 outcome 认领；异常/非法值 fail-closed `unavailable`；`'delegate'` 才进入官方 waterfall；
- `src/plugin.ts` 在 `registerMachinePolicy` 缺失或 fork marker 不符时拒绝挂载，不再有任何 approval/request 监听器形态的自动授权路径。

### Scoped effective tool catalog（完成）

- `src/dsh/effective-tool-catalog.ts`：每个 execution 从 exact `ctx.tools.schemas(agent)` 与 canonical `request/header.tools` 双向规范化比对，冻结一个 `DurableToolCatalogCommitmentV1`；
- native call 要求 wire/callable schema 集合精确一致；`run_code` PTC call 绑定 root model call header，nested dispatch 继承 root catalog；
- `src/dsh/stock-tools.ts`：alpha.2 stock 工具名与 schema 指纹的闭集审批目录（`argumentSemanticsId: dsh-0.1.2-alpha.2-stock-v1`）+ shell/filesystem/network/opaque 语义投影；未识别工具进入 opaque 语义，永不自动授权；
- 缺历史、歧义 header、late/HMR drift、schema 指纹不一致均 fail-closed；cold resume 只消费 durable commitment，不回退全局 `tools.schemas()`。

### Guardian route catalog 绑定（完成）

- `src/dsh/reviewer-model-catalog.ts` 直接消费 `ctx.llm.listProviders()` / `listModels()`，按 DSH 稳定 provider/model id 解析 route；
- provider 不存在、model 不属于 provider、model 声明固定 provider 不匹配或 reasoning effort 不受支持时失败关闭；
- `src/plugin.ts` 等待异步 catalog 验证完成后才注册 machine policy，成功路径仍由 `installModelSelection()` 使用 DSH adapter、凭据与 retry；
- descriptor 继续只持久化稳定 route id，不复制 provider secret 或私有配置。

### P2 裁决管线（完成）

- `DefaultGatePipeline`：身份/分类/root-requester 冲突 → exact denial breaker → trust envelope → allow cache → sealed replay → Guardian pre-review → 模式映射；
- trust envelope 默认关闭，启用时只接受闭集工具族、mode ceiling、realpath workspace 边界、justification 与严格阶梯变宽；
- allow-cache 只在既有 Guardian allow 且 configuration/generation/frontier/actionHash 全部一致时命中，每次 ask 仍需自己的 durable 确认；
- sealed disposition 按 `requestId+callId+actionHash` 单次消费；consumed/mismatch/过期一律 `unavailable`；
- 生产插件固定 `requireVerifiedDossier: true` 并强制 R4 assessment，无 source-verified dossier 的路径不可能自动放行。

### D1 source-backed dossier（完成，严格子集）

- `DshParentSessionFactSource` 从 exact live Agent/Session 冻结连续事件前缀与 lifecycle identity；
- `DefaultDossierCompiler` 校验唯一 execution fact/approval snapshot、ask 绑定、header 早于 pending call、direct-user surface 可见性、turn/step 闭包、catalog commitment 一致、`maxDossierBytes` 上限，产出 branded `SourceVerifiedDossierV1`；
- `DossierGateFactProjector` 只从 branded dossier 重建 classification、lifecycle、turn、direct-user frontier、cache/breaker key 与 R4；
- 已实现并接入的 storage-domain sidecar：execution facts、approval snapshots、delegation receipts、durable result join，全部按完整 lifecycle 索引、create-once、损坏/不可用时非授权。

### R4 风险/授权基线（保守基线，完成）

- `assessVerifiedActionV1` 只消费 verified action semantics、requested permissions、earlier sandbox denials 与保留的可见 direct-user 消息；
- 授权只接受最新可见消息中独立且精确的 `/approve-for-me <JSON>` next-action 指令，toolName/arguments/requestedPermissions 与 action 逐字节匹配；
- network/data-exfil、filesystem destructive、`danger-full-access` 提权、unknown semantics 有结构触发；unknown/critical、权限扩张、审批规避不进入自动 allow fast path；
- `validateDecisionAssessmentV1` 禁止 Guardian 降低来源风险、遗漏类别、引用卷宗外 source 或夸大 coverage。

### R5 policy artifact / R6 review run / R7 breaker / R9 audit（完成）

- `policy-v2` 已注册并用于带 R4 baseline 的 `ApprovalReviewPacketV2`；`policy-v1` 仅用于历史恢复；
- pre-review 生成 host-owned `reviewRunId` 与单一绝对 deadline；一个 Run 最多两个业务 attempts，污染 rotate 是基础设施恢复（不占业务 attempt、不延 deadline）；
- exact denial breaker 只由 Guardian deny 写入，key 绑定 parent lifecycle/turn/frontier/actionHash；human_review 不建立 deny 事实；
- 生产 Gate 使用 Storage Domain 最小决策行（`afm_decision_records`），自动 allow 必须 `createConfirmed`；deny/human 的审计 best-effort。

### H4 记录/案例（部分完成）

- 版本化 packet/decision/policy/case schema、hash domain、create-once 内存/文件后端与完整 case sink 已有；
- durable compact gate decision row 已接入；完整 ReviewDecisionRecord、attempt/recovery 审计与 full case capture 的 Storage Domain 后端仍未接线，因此 `caseCapture.mode: 'full'` 安装会被拒绝。

## 验证

```bash
npm run check                       # typecheck + 42 files / 329 tests + build
npm run verify:managed-source       # sibling clean HEAD/remote/tree = reviewed lock
npm run verify:target-host          # fork tarball + 固定 commit/tag/version
npm run verify:installed-target-host
npm run package:smoke               # 本插件 tarball 内容与泄漏检查
npm run build:demo-kit              # 三个预封存 artifact + manifest/source identity
npm run profile:artifact-smoke      # 已发布 CLI + 封存 kit 的一次性 Profile
DSH_DEMO_PROVIDER=<provider-id> DSH_DEMO_MODEL=<model-id> npm run demo:prepare
```

- 宿主闭包由 `pnpm-lock.yaml` integrity 锁定；三原子 release set 另由 demo-kit manifest 锁定文件名、SHA-256 与 source identity；
- `build:demo-kit` 仅接受 clean AFM checkout、与 `managed-agent-source.lock.json` 完全一致的 clean managed checkout，以及已验证 fork；
- `profile:artifact-smoke` 只消费预封存 kit，使用临时 `DSH_HOME` 与临时 CLI prefix，不触碰本机正在运行的 Profile，也不需要宿主 checkout；
- `demo:prepare` 把同一 kit 安装到用户指定的新 `DSH_HOME`，打印真实 Web/模型测试启动步骤但不会自行启动第二个 server。

## 当前未执行/仍待人工

1. 真实 LLM Guardian 的 allow/deny/human_review 全链；
2. `auto-then-user` 下沉后官方 Web approval panel 可见且可操作；
3. pending approval、Reviewer child、storage 状态在“彻底杀掉进程再重启”后的 cold-resume；
4. deadline、污染、renew、卸载/重载的真实并发与故障注入；
5. 长程 soak：包络内 0 人工、0 误放行。

发布输入还要求 `dsh-managed-agent` 处于已审查的干净 commit，并让 `managed-agent-source.lock.json` 与该 commit 的 source tree digest 一致（`artifact.json.dirty` 必须为 `false`）。

## 下一阶段

按 [施工计划](construction-plan.md) 与 [集成验证清单](integration.md)：先完成 managed-agent 干净提交与 lock 刷新，再执行真实 LLM/Web/cold-process E2E 与故障注入；R4 的完整规则矩阵与 target/side-effect matcher、未实现工具族的 exact adapter、full case capture durable 后端仍保持显式未完成，不得误报为产品能力。
