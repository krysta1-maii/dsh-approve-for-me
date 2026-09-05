# 实现状态与后续接入

> 当前代码状态（2026-09-04，rc.1 基线）：精确适配 DSH `0.1.2-rc.1`（commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，tag `dsh-v0.1.2-rc.1`），机器决策槽 v3。宿主闭包直接安装 npm 上已发布的 `0.1.2-rc.1` 包；`npm run check` 通过 59 个测试文件、740 项测试（2026-09-05 WP7 二期授权抽屉/提取器合入后）。生产 loader 直接读取 DSH `llm` provider/model catalog，注册机器策略前校验稳定 route 与 reasoning effort，并继续复用 DSH runtime model selection。三原子 demo kit、approval fork、installed target host、package smoke 与 disposable Profile artifact smoke 均可在 rc.1 上验收；Profile smoke 覆盖真实 `dsh plugin add`、Cordis compose、一次真实自动放行 side effect、人工拒绝兜底和全新进程重启后的相同 tool catalog。真实 LLM 判断质量（S1/S2）与 pending cold-resume 已由 `profile:quality-smoke`／`profile:pending-smoke` 验收；policy-v3 已在 live 实例实测 danger 升档自动放行（证据见 `acceptance-0.1.2.md`）。
>
> 尚未完成的是"产品级 E2E"的剩余部分：浏览器中官方审批面板的完整点击链、污染/容量/卸载的故障注入、长程 soak，以及 policy-v3 的自动化验收（S3 场景、S3b、v3 下 S1/S2 回归）。当前 automatic allow 必须来自 branded source-verified dossier 上 identity-valid 的 Reviewer allow，并在返回前完成 durable decision record；R4 baseline 作为 Reviewer 输入和 authorization-derived cache/replay fast-path 边界。

## 当前里程碑

### P0 patch 包（完成）

`patch/dsh-user-approval/`：

- `upstream.json` 锁定 `dsh-v0.1.2-rc.1` / `a66e470204…`，patch version 4；
- overlay 只含两处增量：`ApprovalRequestEvent.requestId`、`ApprovalService.registerMachinePolicy()`；
- `build-fork.sh` 在 throwaway clone（`.build/upstream-clone`）中检出固定 commit 后重建、测试、构建、打包并写 SHA-256 sidecar；上游 checkout 只被读取，不再注册 worktree，HEAD 位置不影响构建；
- `.build/dsh-user-approval-afm-0.1.2-rc.1.tgz` 已通过 `verify:approval-fork` 与 `verify:target-host`。

### P1 机器决策槽接入（完成）

- `src/dsh/machine-policy-adapter.ts` 把 patched `ApprovalRequestEvent` 投影为 `GateMachineRequestV1`，保持稳定 id `dsh-approve-for-me/v1`；
- fork 的 `decide()` 语义：`never` 先于机器策略；非 `'delegate'` 合法 outcome 认领；异常/非法值 fail-closed `unavailable`；`'delegate'` 才进入官方 waterfall；
- `src/plugin.ts` 在 `registerMachinePolicy` 缺失或 fork marker 不符时拒绝挂载，不再有任何 approval/request 监听器形态的自动授权路径。

### Scoped effective tool catalog（完成）

- `src/dsh/effective-tool-catalog.ts`：每个 execution 从 exact `ctx.tools.schemas(agent)` 与 canonical `request/header.tools` 双向规范化比对，冻结一个 `DurableToolCatalogCommitmentV1`；
- native call 要求 wire/callable schema 集合精确一致；`run_code` PTC call 绑定 root model call header，nested dispatch 继承 root catalog；
- `src/dsh/stock-tools.ts`：沿用已冻结的 alpha.2 stock 工具语义标识（`argumentSemanticsId: dsh-0.1.2-alpha.2-stock-v1`）并在 rc.1 上验证兼容，提供 schema 指纹闭集与 shell/filesystem/network/opaque 语义投影；未识别工具进入 opaque 语义，永不自动授权；
- 缺历史、歧义 header、late/HMR drift、schema 指纹不一致均 fail-closed；cold resume 只消费 durable commitment，不回退全局 `tools.schemas()`。

### Guardian route catalog 绑定（完成）

- `src/dsh/reviewer-model-catalog.ts` 直接消费 `ctx.llm.listProviders()` / `listModels()`，按 DSH 稳定 provider/model id 解析 route；
- provider 不存在、model 不属于 provider、model 声明固定 provider 不匹配或 reasoning effort 不受支持时失败关闭；
- `src/plugin.ts` 在异步验证前订阅 `llm/adapters-updated`，只在无竞态时注册 machine policy；任何后续 provider topology 变化立即撤销该策略，须经 loader reload 重新验证后才能恢复；成功路径仍由 `installModelSelection()` 使用 DSH adapter、凭据与 retry；
- descriptor 继续只持久化稳定 route id，不复制 provider secret 或私有配置。

### P2 裁决管线（完成）

- `DefaultGatePipeline`：身份/分类/root-requester 冲突 → exact denial breaker → trust envelope → allow cache → sealed replay → Guardian pre-review → 模式映射；
- trust envelope 默认关闭，启用时只接受闭集工具族、mode ceiling、realpath workspace 边界、justification 与严格阶梯变宽；
- allow-cache 只在既有 Guardian allow 且 configuration/generation/frontier/actionHash 全部一致时命中，每次 ask 仍需自己的 durable 确认；
- sealed disposition 按 `requestId+callId+actionHash` 单次消费；consumed/mismatch/过期一律 `unavailable`；
- 生产插件固定 `requireVerifiedDossier: true`；R4 assessment 进入 Reviewer packet并限制 authorization-derived cache/replay fast path，但不再作为第二个 Host 业务裁决器重写身份有效的 Reviewer decision。

### D1 source-backed dossier（完成，严格子集）

- `DshParentSessionFactSource` 从 exact live Agent/Session 冻结连续事件前缀与 lifecycle identity；
- `DefaultDossierCompiler` 校验唯一 execution fact/approval snapshot、ask 绑定、header 早于 pending call、direct-user surface 可见性、turn/step 闭包、catalog commitment 一致、`maxDossierBytes` 上限，产出 branded `SourceVerifiedDossierV1`；
- `DossierGateFactProjector` 只从 branded dossier 重建 classification、lifecycle、turn、direct-user frontier、cache/breaker key 与 R4；
- 已实现并接入的 storage-domain sidecar：execution facts、approval snapshots、delegation receipts、durable result join，全部按完整 lifecycle 索引、create-once、损坏/不可用时非授权。

### R4 风险/授权基线（保守基线，完成）

- `assessVerifiedActionV1` 只消费 verified action semantics、requested permissions、earlier sandbox denials 与保留的可见 direct-user 消息；
- 它只把独立且精确的 `/approve-for-me <JSON>` 识别为 deterministic structured authorization；普通自然语言由 fresh Reviewer 结合完整 dossier 解释；
- network/data-exfil、filesystem destructive、`danger-full-access` 提权、unknown semantics 有结构触发；无结构化授权的结果不进入 cache/replay fast path；
- `danger-full-access` 的基线风险标签随 Reviewer 政策走：policy-v1/v2 为 `critical`（当时是 allow 禁令），policy-v3 为 `high`（只是评审信号）；permission-expansion 在任何政策下都不进入 fast path，每次升级都由新鲜 Guardian 裁决；
- `validateDecisionAssessmentV1` 保留为诊断/评估工具，不参与 PreReview 的最终 disposition 映射；身份有效的 Reviewer decision 直接决定 allow／deny／human_review。

### R5 policy artifact / R6 review run / R7 breaker / R9 audit（完成）

- `policy-v2` 与 `policy-v3` 已注册并用于带 R4 baseline 的 `ApprovalReviewPacketV2`；`policy-v1` 仅用于历史恢复；
- v3 移除了"critical 风险永不放行"的硬编码：`danger-full-access` 升级是普通可评审请求，Reviewer 按直达用户证据覆盖裁决，且 danger 放行必须在 `assessment.sourceRefs` 引用所依据的用户消息；剩余绝对禁令只有 rejection-bypass 与证据缺失（证据事实，非判断）；demo profile 与质量冒烟默认使用 v3，v2 保留可回退；
- pre-review 生成 host-owned `reviewRunId` 与单一绝对 deadline；一个 Run 最多两个业务 attempts，污染 rotate 是基础设施恢复（不占业务 attempt、不延 deadline）；
- exact denial breaker 只由 Guardian deny 写入，key 绑定 parent lifecycle/turn/frontier/actionHash；human_review 不建立 deny 事实；
- 生产 Gate 使用 Storage Domain 最小决策行（`afm_decision_records`），自动 allow 必须 `createConfirmed`；deny/human 的审计 best-effort。

### H4 记录/案例（部分完成）

- 版本化 packet/decision/policy/case schema、hash domain、create-once 内存/文件后端与完整 case sink 已有；
- durable compact gate decision row 已接入；完整 ReviewDecisionRecord、attempt/recovery 审计与 full case capture 的 Storage Domain 后端仍未接线，因此 `caseCapture.mode: 'full'` 安装会被拒绝。

### H5 Web 当前会话信息流（完成）

- `src/client.ts` 交付独立 DSH lazy-CJS client bundle，并在 stock Chat 的 keyed node slot 注册 `approve-for-me` renderer；
- `src/client/approval-conversation.ts` 只读折叠官方持久 `approval/asked`／`approval/decided`，按 requestId 把“审批中”原位更新为权威最终 outcome，刷新后可重建；
- `src/client/approval-flow-item.ts` 使用 DSH design tokens、字体尺寸轴、暗色主题颜色和 reduced-motion 约束，提供工具名、原因与查看操作入口；
- UI 不监听／认领 `approval/request`，不写模型 surface，不新增私有 Session event，renderer 异常或缺席均不改变授权结果。

### H6 插件配置与 Reviewer 模型选择（完成）

- Host 通过可选 `ctx.settings.installSection()` 注册 `dsh-approve-for-me` namespace；无 Settings provider 时继续使用 loader 配置，不把 `settings` 变成必需服务；
- namespace 只开放 `reviewer.provider`／`reviewer.model`，generation、policy/toolset、mode、trust envelope 与目录承诺仍由部署配置拥有；
- `src/client/approval-settings-card.ts` 向 keyed root slot `settings.plugin.item` 注册同名卡片，读取 `remote.session.modelCatalog()`，用 DSH tokens、暗色兼容与 reduced-motion 自绘配置卡片；
- 编辑先进入草稿，保存通过 namespace revision fence 原子修改两个 route 路径；并发 revision 漂移保留草稿并阻止覆盖，重置恢复组合层；
- 设置提交先同步撤销旧 machine policy，再异步校验新 route；只有最新 generation 可以重新安装。慢旧 lookup、unavailable route、provider detach 与卸载 race 都不能恢复过期策略；
- 切换到其他 route 时删除部署模型专属 reasoning effort，使用新 adapter 默认值；重置为部署 route 时恢复部署 effort。provider credential、retry 与私有设置始终由 DSH 持有。

### H7 长 Session 审批饥饿与 Stop 修复（完成）

- 事故根因是 `awaitApprovalSnapshot()` 在首次冷审批中重放全部历史 result，而 native `attachResult()` 每次又执行全表 `repository.list()`，在 151k events／1323 results 的会话中形成约 175 万次完整记录校验和约 400GB 逻辑重序列化；Promise microtask 风暴阻塞 WebSocket、timer 与持久化；
- native result 现在用 durable `sourceEventSeqs[0]` 对 exact execution `repository.get()`；approval snapshot 从 ask 之前最后一条 exact canonical request 做单点 get，并与 volatile capture actionHash 复核；
- approval barrier 只等待当前进程已开始的 result writes 与 exact approval write，不再冷重放全部 Session result；随后基于一次已验证 execution snapshot 扫描 canonical history，只对明确缺少 result 的 exact row 做 bounded cold repair；无法精确修复的 crash-tail 仍失败关闭；
- `maxSourceEvents` 默认且最高为 20000（部署只能下调），在读取全量 sidecar/构建 dossier 前形成显式 work budget；超预算在 `auto-then-user` 下进入官方人工链，在 `auto` 下 unavailable；
- Storage Domain 大索引读取每 32 条让出一次 macrotask并检查 AbortSignal；`ApprovalRunLifecycle(timeoutMs)` 从 machine-policy 入口约束全链，Stop／deadline 立即结束调用方等待，同时保留底层任务的 lifecycle drain，迟到任务不能授权；
- 事故回归覆盖 10k historical result 的 O(1) exact lookup、无全表 replay、event-loop heartbeat/abort、完整 deadline、non-cooperative gate Stop、work-budget 模式映射与 cold correlation。

## 验证

```bash
npm run check                       # typecheck + 59 files / 740 tests + build
npm run verify:managed-source       # sibling clean HEAD/remote/tree = reviewed lock
npm run verify:target-host          # fork tarball + 固定 commit/tag/version
npm run verify:installed-target-host
npm run package:smoke               # 本插件 tarball 内容与泄漏检查
npm run materialize:demo-inputs     # clean source -> fork + managed inputs
npm run build:demo-kit              # 三个预封存 artifact + manifest/source identity
npm run profile:artifact-smoke      # 已发布 CLI + 封存 kit 的一次性 Profile
DSH_DEMO_PROVIDER=<provider-id> DSH_DEMO_MODEL=<model-id> npm run demo:prepare
```

- 宿主闭包由 `pnpm-lock.yaml` integrity 锁定；三原子 release set 另由 demo-kit manifest 锁定文件名、SHA-256 与 source identity；
- `build:demo-kit` 仅接受 clean AFM checkout、与 `managed-agent-source.lock.json` 完全一致的 clean managed checkout，以及已验证 fork；
- `profile:artifact-smoke` 只消费预封存 kit，使用临时 `DSH_HOME` 与临时 CLI prefix，不触碰本机正在运行的 Profile，也不需要宿主 checkout；
- `demo:prepare` 把同一 kit 安装到用户指定的新 `DSH_HOME`，打印真实 Web/模型测试启动步骤但不会自行启动第二个 server。

## 当前未执行/仍待人工（2026-09-04 对账）

已完成并记录于 `acceptance-0.1.2.md`：真实 LLM Guardian 的 allow/human_review 全链（S1/S2）、pending approval 与 Reviewer child 在 SIGKILL 后的 cold-resume、以及 policy-v3 下 danger 升档授权内场景的 live 实测。仍欠：

1. policy-v3 提示词下的 S1/S2 自动化回归、探针版 S3 场景实现（规格已备）与 S3b（无授权 danger 必须 human/deny）；
2. `auto-then-user` 下沉后官方 Web approval panel 的完整点击链证据（live 已观察到状态项与人工兜底，无自动化记录）；
3. deadline、污染、renew、卸载/重载的真实并发与故障注入；
4. 长程 soak：包络内 0 人工、0 误放行。

发布输入还要求 `dsh-managed-agent` 处于已审查的干净 commit，并让 `managed-agent-source.lock.json` 与该 commit 的 source tree digest 一致（`artifact.json.dirty` 必须为 `false`）。

## 下一阶段

按 [施工计划](construction-plan.md) 与 [集成验证清单](integration.md)：补齐上述 policy-v3 验收欠账与故障注入；R4 的完整规则矩阵与 target/side-effect matcher、未实现工具族的 exact adapter、full case capture durable 后端仍保持显式未完成，不得误报为产品能力。
