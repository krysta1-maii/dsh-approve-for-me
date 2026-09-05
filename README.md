# dsh-approve-for-me

面向 DeepSeek Harness（DSH）的受管自动审批插件：工具副作用发生前，由隔离的 Guardian Reviewer 裁决；只有来源可验证、作用域精确且满足证据规则的动作才可能自动放行，其余请求失败关闭或下沉官方人工审批链。

> 当前实现基线：精确适配 DSH `0.1.2-rc.1`（commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，tag `dsh-v0.1.2-rc.1`），采用机器决策槽 v3。宿主闭包直接消费 npm 上已发布的 `0.1.2-rc.1` 包，由 `pnpm-lock.yaml` 的 integrity 固定；本仓库另外交付插件本体与 `@deepseek-ai/dsh-user-approval` 的最小 fork，`dsh-managed-agent` 由独立仓库构建为受摘要约束的安装 artifact。rc.1 实现检查点（含 WP7 二期授权抽屉与 WP8 三期可见性）通过 65 个测试文件、835 项测试。生产 loader 会从 `ctx.llm.listProviders()` / `listModels()` 绑定并校验 Guardian route，再复用 DSH 的 adapter、凭据、retry 与 model selection；stale provider/model/effort 在注册机器策略前失败关闭。真实 artifact 已具备 disposable Profile 自动冒烟；真实 LLM Guardian 判断质量（S1/S2）与 pending 状态跨进程 cold-resume 已验收，policy-v3 的 danger 升档自动放行已在 live 实例实测通过（证据见 [验收记录](docs/acceptance-0.1.2.md)）；官方 Web 人工面板点击链、故障注入与长程 soak 仍须单独执行端到端验收。

## 部署组成

```text
npm 已发布的 @deepseek-ai/*@0.1.2-rc.1 宿主闭包
+ @deepseek-ai/dsh-user-approval fork tarball
+ dsh-managed-agent tarball（Host/Client bundle）
+ dsh-approve-for-me tarball
```

- 宿主基线固定为 tag `dsh-v0.1.2-rc.1` / commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`；该版本已发布到 npm（dist-tag `alpha`）。
- 除 approval fork 外的宿主包全部按精确版本从 registry 安装，可复现性由 `pnpm-lock.yaml` 的 integrity 摘要保证；本仓库不再自建、也不再锁定本地宿主 tarball 闭包。
- approval fork 仍从固定 commit 的宿主**源码**构建，保留官方 `name`/`version`，以 `dshApprovalPatch` 和独立 tarball 名标识；运行时会拒绝没有该标记或 `registerMachinePolicy()` 的同版本官方包。构建在一次性 clone 中进行，只读取上游 checkout，绝不写入。
- managed artifact 由 sibling `dsh-managed-agent` 打包；`managed-agent-source.lock.json` 先约束完整 reviewed source tree 摘要，`artifact.json` 再记录 source commit/tree digest、dirty 状态、文件名和 tarball SHA-256。任何 source 漂移都在打包前失败；发布输入仍应使用 `dirty: false` 的已审查 commit。
- 插件包不内嵌 approval fork；部署时必须把 fork、managed-agent 和本插件三个 artifact 一起安装到目标 Profile。

## 裁决入口

patched `dsh-user-approval` 提供唯一的 `registerMachinePolicy()` 槽：

```text
模型 tool call
→ tools/pre-execute 捕获 exact ToolExecution
→ 按 exact Agent 解析当前 scoped tools.schemas(agent)
→ 与产生该 call 的 canonical request/header tools 逐字节规范化比对并冻结 catalog
→ ctx.approval.request()
→ ApprovalService.decide()
   ├─ never → rejected
   └─ machine policy
      ├─ 从 exact Agent/Session sealed facts + 有界近期摘录编译 branded hot dossier
      ├─ 从 verified action + direct-user evidence 计算 R4
      ├─ trust envelope / deny breaker / allow cache
      └─ Guardian Reviewer（dsh-managed-agent child）
         ├─ allow / deny
         └─ human_review → auto: rejected；auto-then-user: delegate
→ delegate → 官方 approval/request waterfall → Web 人工审批
```

机器策略位于 `never` 之后、官方 `approval/request` waterfall 之前；机器策略异常、身份冲突、catalog 漂移、卷宗不完整、存储失败或 deadline 到期均不能自动放行。

## Web 当前会话信息流

插件同时交付静态 `dsh.client` 浏览器入口，把父会话中已经存在的官方持久审计对投影为一条紧凑的 Chat 信息流状态项：

```text
approval/asked   → Approve for me · 审批中
approval/decided → 同一状态项原位更新为 已允许 / 已拒绝 / 已取消 / 审批不可用
```

状态项按 requestId 精确配对，显示工具名、审批原因和“查看操作”入口；颜色、字号、间距、暗色模式及 reduced-motion 均复用 DSH design tokens。它保持为独立信息流项，不会被 compact transcript 折叠进“工具调用”摘要；刷新或重载后由持久事件重建，孤立的 `approval/asked` 保持未决而不会伪造结果。

该 UI 是只读、非授权的 client projection：不拦截 `approval/request`，不注册第二条审批链，不向 `user/message`／`assistant/message`／`tool/result` 等模型 surface 写入状态，也不新增可能破坏旧版持久化或后续 dossier 编译的私有 Session event。最终展示始终以权威 `approval/decided` 为准；发生人工下沉时，它表示整条审批请求的最终结果，而不冒充 Reviewer 的中间提议。

## 设置中的 Reviewer 模型

Host 在可选的 DSH Settings 服务上注册 `dsh-approve-for-me` namespace；浏览器半侧以同名 key 向“设置 → 插件 → 插件配置”贡献原生风格卡片。卡片从 `remote.session.modelCatalog()` 读取实时 provider/model 目录，展示名称但只持久化稳定的 provider/model id；未出现在当前目录中的已配置 route 会明确标为不可用，不会被静默替换为默认模型。

选择先保留为本地草稿，点击保存后以 namespace revision 为 fence，原子修改 `reviewer.provider` 与 `reviewer.model` 两个路径。并发变更会阻止旧草稿覆盖新配置；重置会删除用户层 route，重新继承 Profile 的组合配置。配置提交后旧 machine policy 立即撤销，只有新 route 通过 DSH catalog 精确校验后才重新挂载；不可用 route 保持失败关闭。切换到非部署默认模型时不携带旧模型的 `reasoningEffort`，而是使用新 adapter 的默认值。

该设置只开放 Reviewer route。generation、policy/toolset 版本、审批模式、trust envelope、tool catalog 等授权边界仍由部署配置拥有；provider 私有配置、凭据与 retry 继续完全复用 DSH。

## Scoped effective tool catalog

工具目录不是安装期全局快照，而是每次执行绑定的授权事实：

1. 从 exact `ToolExecution.agent` 读取 `ctx.tools.schemas(agent)`；
2. 从该 call 的 canonical `request/header` 重建持久工具集合；nested code dispatch 绑定其 root model call 的 header；
3. 两份 JSON 规范化结果必须相同，随后冻结为同一个 approval/dossier catalog commitment；
4. action projector、durable sidecar、卷宗分类与冷恢复都消费该 commitment；
5. restricted scope、缺失/歧义历史、late/HMR drift 或 schema 指纹不一致均失败关闭。

因此不同 Agent 可以拥有不同有效工具集合，冷恢复也不会退回无作用域的全局 schema 快照。

## Source-backed dossier 与 R4

生产 gate 不信任注册时缓存的分类或模型声明。每个 ask 只保存相关性句柄；裁决时重新从 exact Agent/Session、requestId、callId、actionHash 和持久事件序列构建事实，只有编译为 branded、`ready` 的 source-verified dossier 才能进入授权路径。

R4 是提供给 Reviewer 并约束 authorization-derived cache/replay fast path 的结构化基线，只使用 verified action semantics、requested permissions、保留且可见的 direct-user 消息和精确 `/approve-for-me <JSON>` 指令；它不替代 Reviewer 对完整 source-backed dossier 的业务判断。

首次 fresh review 中，Reviewer 拥有最终的 allow／deny／human_review 裁决权：清晰、无歧义的普通自然语言请求可以构成授权，`/approve-for-me` 是高置信结构化信号而不是自动 allow 的必需前置。Host 只校验 parent/action/generation/deadline 等客观绑定，不以 R4 标签重写身份有效的 Reviewer 决策。sandbox-denied 候选仍不直接进入预审 fast path；当前 turn 的同动作严格扩权重试由 Host 绑定候选事实，再交 Reviewer 判断必要性与风险。

`policy-v3`（demo profile 与质量冒烟的默认）进一步移除了“critical 风险永不放行”的硬编码：一次 `danger-full-access` 升级是普通可评审请求，R4 基线将其标为 `high` 评审信号而非禁令，Reviewer 按直达用户证据覆盖裁决，且 danger 放行必须在 `assessment.sourceRefs` 引用所依据的用户消息。剩余绝对禁令只有 rejection-bypass 与证据缺失（证据事实而非判断）；permission-expansion 在任何政策下都不进入 fast path，每次升级都由新鲜 Guardian 评审。`policy-v2` 保留注册，配置 `reviewer.policyVersion` 即可回退。

## 历史预算、取消与事件循环公平性

第一版 approval barrier 会在进程重启后的首次审批中重放全部历史 `tool/result`，而每条 native result 又全表读取 execution sidecar，形成 O(R×E) 放大；长 Session 会耗尽事件循环，使 Web Stop、审批持久化和 timer 都得不到调度。当前实现改为利用 `sourceEventSeqs` 和 approval 前最后一条 exact request 做 `repository.get()`，只等待本进程已经在写的结果，不再全历史重放。

sealed-facts 一期把 `maxSourceEvents` 移除：含该旧字段的配置拒绝启动并给出升级错误（热路径改由 sealed-tail／ledger 预算保护）。审批热路径从不调用全量 `snapshotEvents`，事实输入 = 当前冻结动作 + 有界 sealed tail（`maxSealedTailEvents` 与台账 `maxLedgerEntries` 共享同一默认 `256`，WP6-b1 实测发现默认 512/256 不一致已对齐）+ 有界近期摘录（`maxRecentExcerptBytes` 默认 `24000`），并预构建 branded hot packet（`maxHotPacketBytes` 默认 `96000 ≤ 256000`）。超预算以显式原因码分流：`tail-budget-overflow`／`ledger-budget-overflow`／hot-packet `budget-overflow`（路由 `retryable-capability`）在 `auto-then-user` 下 delegate 人工、`auto` 下保持 unavailable；篡改／存储／投影失败与 `seal-chain-invalid` 类为 unavailable 且不 delegate。`timeoutMs` 仍覆盖从 machine-policy 入口开始的事实读取、dossier、Reviewer 与确认全链；用户 Stop 或 deadline 会立即结束当前审批等待，底层协作任务仍由 lifecycle 持有并排空，迟到工作不能产生授权。

## Reviewer 容量与 deadline

- `deliveryAttempts` 是 managed-agent 持久目录中对 child 的实际 transport delivery 尝试计数，不是“已接受结果”计数。
- `maxDeliveryAttemptsPerChild` 达到后，目录通过 durable `renew()` 取得 successor；污染 child 也永久退出复用集合。
- 一次业务 review 最多两个业务 attempts；污染恢复是基础设施轮换，不额外增加业务 attempt。
- `timeoutMs` 从 machine-policy 入口开始形成完整外层 deadline；Reviewer 内部同一个绝对 `deadlineAt` 覆盖目录发现、renew、delivery、污染恢复、重试和结果等待，任何内层恢复都不得越过外层预算。
- deadline/abort 后的迟到、重复或旧 generation 结果没有审批副作用。

## 可复现 bootstrap 与验证

只有 approval fork 与 managed artifact 需要 sibling checkout：

```text
../deepseek-harness   # 需包含 a66e4702576...（HEAD 可以在别处；仅被读取）
../dsh-managed-agent  # 已审查的 managed-agent source commit
../dsh-approve-for-me # 本仓库
```

```bash
# 构建 immutable approval fork 与 managed artifact，再按 frozen pnpm lock
# 安装已发布的 rc.1 宿主闭包
DSH_REPO=../deepseek-harness \
MANAGED_AGENT_SOURCE=../dsh-managed-agent \
npm run bootstrap:dependencies

# rc.1 类型、测试与构建
npm run check

# 校验本插件发布包内容
npm run package:smoke

# 从 clean、锁定来源构造输入，再封存三原子 demo kit
npm run materialize:demo-inputs
npm run build:demo-kit

# 只消费封存 kit，在临时 DSH_HOME 安装并启动脚本化验收 Profile
npm run profile:artifact-smoke

# 把三件套安装到仓库内新的隔离 DSH_HOME；ID 直接取自目标 DSH provider/model 列表
DSH_DEMO_PROVIDER=<provider-id> DSH_DEMO_MODEL=<model-id> npm run demo:prepare
```

`build:approval-fork` 在 `.build/upstream-clone` 中检出固定 commit 并构建，上游 checkout 只被 `git clone` 读取；`verify:target-host` 再校验该 commit、tag、版本与 fork 标记。`build:demo-kit` 只接受 clean、锁定的两个源码仓库，生成 `.build/demo-kit/demo-kit.json`；已验收 release set 同步冻结在 tracked `deployment-artifacts.lock.json`。两者逐一记录三个 tarball 的 SHA-256、source identity 与输入 lock 摘要。`demo:prepare` 不启动 server，不接触当前实例；它把稳定 route ID 写入隔离 Profile，并输出启动命令。provider credential 与 adapter 配置仍由该 DSH Profile 管理。

## 自动 Profile smoke 证明什么

`profile:artifact-smoke` 在 disposable `DSH_HOME` 中（CLI 也来自已发布的 `@deepseek-ai/dsh@0.1.2-rc.1`，无需宿主 checkout）：

- 完整校验 demo kit manifest、artifact digest 与 source identity，只消费三份预封存部署 tarball；
- 安装 approval fork、managed-agent、本插件三个部署 tarball，并加入独立 probe tarball；
- 通过真实 `dsh plugin --profile ... add --save-exact` 生成 Profile package/lock；
- 用 `--dump-config` 确认 managed host、本插件和 probe 已 compose；
- 真正启动目标 Profile，并在其中跑完两条 gate 路径：一次 `/approve-for-me` 授权动作被自动放行并真实执行了 `bash` 副作用，一次 `auto-then-user` 下沉被人工通道拒绝且命令没有执行；
- 杀掉进程后再从同一个已安装 Profile 冷启动一次，要求 effective tool catalog 完全一致；
- 从 Profile 自身解析依赖，验证 fork marker/API 与精确 rc.1 安装闭包；
- 验证 `ctx.managedAgents` 的 create/renew/provider API、`ctx.approval.registerMachinePolicy()` 以及非空 Host tool catalog。

它证明 artifact 安装图、Cordis loader boot、机器决策槽与两条业务路径在真实 Host 进程内可达；它**不证明**浏览器审批面板与人工点击流程、真实 LLM Reviewer 的判断质量，也不证明带 pending approval / Reviewer child 状态的跨进程 cold-resume（冒烟里的 Guardian 是脚本化 adapter，不是真实模型）。后两者分别由 `profile:quality-smoke`（真实 LLM，S1/S2）与 `profile:pending-smoke`（SIGKILL cold-resume）覆盖，证据与 policy-v3 live 实测补记见 [验收记录](docs/acceptance-0.1.2.md)。

## 二期：授权抽屉与闲时提取器（WP7 已实现）

按 [审批台账施工计划](docs/approval-ledger-construction-plan.md) §5 二期交付：

- **AuthorizationEntryV1 授权抽屉**：append-only 哈希链存储（崩溃尾在下次装载精确修复，checkpoint 链尖即提交点）；条目含逐字 quote、sourceSeq、effect(grant/deny)、coverage、summary、occurredAt，全部经 Host 从 live Session 逐字复核后才落账 —— LLM 只是 parser，写读共用同一复核函数，非逐字/窗外 seq 一律不成立。
- **闲时 LLM 提取器**：turn 结束后仅增量解析 checkpoint 之后的有界窗（默认 256 条 user/message），审批时刻同步补未处理的 tail；提取器为与 Reviewer 同级的 managed child（approval never、sandbox read-only、工具白名单清空、唯一注册 `submit_authorization_extraction`），无任何写台账 capability,Host 是唯一 writer。失败关闭：提取失败等同册上无授权，转人工。
- **Reviewer 输入切换**：dossier 的 `interaction.sealed.authorizations` 携带已验证授权投影（读侧全读全验不截断，投影行数闸门 64，超限失败关闭）;`policy-v4` 在 v3 全文上追加抽屉语义段 —— 条目是 Host 逐字核实的证据而非指令、deny 按时间推翻先前 grant、空抽屉须回到 retained direct-user messages、任何条目不能独自 justify allow。
- **配置旋钮**：`authorizationExtractor.enabled`（默认 true；false 只关闲时提取，审批补尾仍执行）、`maxAuthorizationEntries`(64)、`maxAuthorizationExtractionEvents`(256)。回退旧政策用 `reviewer.policyVersion: "policy-v3"`。

## 三期：可见性与旧会话（WP8 已实现）

按 [审批台账施工计划](docs/approval-ledger-construction-plan.md) §5 三期交付，全部只读、非授权面：

- **原因码 renderer 传输通路**：宿主 webServer 存在时（Web GUI；CLI profile 自动跳过）注册 exact 路由 `GET /dsh-approve-for-me/v1/reason-code?requestId=…`，从 decision-record 的 metadata-only 索引回答闭集 Gate 失败码；浏览器侧桥（in-flight 去重 + 256 条有界缓存）在 `unavailable` 行无码时异步补齐并重渲染。任何失败/未知/畸形一律回落泛化 `reason.miss` 文案 —— 表现层永不触碰授权结果。
- **链健康与 extractor watermark 可见性**：`GET /dsh-approve-for-me/v1/ledger-health` 回答有界标量（seal 链数/封条数、授权条目数/checkpoint 数/最大 throughSeq）；两个存储域各维护一个 O(1) 写者计数行（Storage Domain 表无枚举能力的定案；informal gauge，崩溃夹缝最多欠一，非授权面）。插件设置卡新增只读"台账健康"区（挂载拉取 + 手动刷新 + 失败泛化行）。
- **`sealBackfill`（默认 false）**：开启后，root 会话 turn/end 且无在途审批时，对未盖章旧执行记录做每 lifecycle 每进程一次的 background-once 补章 —— 逐条重做快照唯一绑定、live 事件再绑、projector 可解析性验证，用与 live 路径完全同一的构造纯函数（`seal-projection.ts`）造 seal 后 create-once 追加；任一失败整体停止，该 lifecycle 保持无章（永不自动放行）；新审批 run 或新 user/message 立即 abort。
- 无章旧会话即使不迁移也永久走人工；backfill 只是给"证据齐全的旧会话"一条补账通路，绝不为兼容退化。

## 四期：fact 记录格式 v2 瘦身（WP9-a 已实现）

OOM 根治第一步：执行记录从 v1（全量 arguments + 每记录内嵌 catalog commitment + canonical 全文自校验的 2 倍冗余）瘦身为 v2 —— arguments/语义投影改内容寻址 `PayloadRefV1`（inline 有界预览或 sha256 digest）、catalog commitment 缩为 `DurableCatalogEvidenceV2`（分类/审批 catalog 指纹 + wireSchemasDigest）、行壳由 `{version, canonical, record}` 改为 `{version:2, digest, record}`（digest 取代 canonical 全文）。实测行体积（10 工具 catalog）：小参数 24.2KB→6.4KB（3.8x）；RCA 均值 150KB 参数 331KB→8.5KB（38.8x）；5MB 参数 10.5MB→8.5KB（1231x）。语义投影值仍内联但有界（>256KB 写入时 fail-closed），动作真实性在消费时由 live 事件参数经 payload-ref 校验重派生并与 actionHash 比对 —— 与 v1 逐字节比较在 sha256 碰撞 resistance 意义下等价。存储域中遗留的 v1 行**有意读作缺席**（fail-closed，行版本不符即整行拒读/拒写覆盖），不做迁移；旧数据已由 WP8 前的归档处置（`approve_for_me.retired-20260906`）。

## 一期已知限制（sealed-facts 阶段，选型说明）

sealed-facts 一期（`feat/approval-ledger` 的 WP4/WP5）已落地，但以下是有意的阶段边界与可用性权衡，供读代码／做验收时对照：

**a. B2 键域权衡：turn 内用户 follow-up 不再重置已熔断 denial。** 精确 denial 断路器按键 `lifecycle + turn + actionHash`（不再含 `frontierSeq`）。同一 turn 内用户追加 follow-up 消息也不会重置已熔断的同一 `actionHash` 拒绝 —— 方向为 fail-closed（不因同 turn 重试放松），代价是用户需进入新 turn 才能重新请求刚被熔断的动作；authorization-derived allow cache 的键仍保留 `frontierSeq`。

**b. `dossierMetricsSink` 一期惰性。** 插件保留 `dossierMetricsSink` 选项但一期无生产调用点，`getDossierCompilationMetrics` 恒返回空基线。WP6 验收的“完整卷宗 vs 热路径体积对比”需要真实可达的全量编译入口 —— 该入口已不作为生产热路径调用（plugin 闭包内的 `compile()` 已移除），验收 harness 须用导出的 `DefaultDossierCompiler`／`InstrumentedDossierCompiler` 类自建。

**c.（已于 WP8-a 解除）原因码 renderer 一期恒泛化 miss。** 三期落地了独立 webServer 路由 + 浏览器桥（见上"三期"节），生产 renderer 在 Web GUI 下可解析真实原因码；CLI/无 webServer 宿主仍走泛化 `reason.miss`（有意的安全降级）。render-miss 分层：client 侧 = `miss` 标志 + `data-reason-miss` DOM 属性（表现层）；数值 `reason-code-render-miss` 遥测计数属服务端／Gate 侧（WP5-a）。

**d. split-duplicate 设计边界（窗外历史归 sealed 锚定）。** 旧全历史校验对任一 request id 的重复 approval/asked 失败关闭，包括跨窗口的一对重复；新实现只监测有界 sealed 窗口 —— “1 条窗内 + 1 条窗外古重复”现在通过（窗外历史归 sealed 锚定，不作为 live 重复判据）。这与 WP4-a2 冷启动边界同构（cold-repair／asked 定位只在 `maxSealedTailEvents` 窗内回扫）；两者都把“窗外”视为 sealed-anchored 健壮性边界，窗内重复仍严格 fail-closed。

**e. catalog 不变式校验的扫描跨度随"距上一个 request/header 的事件数"线性增长（容量，非安全）。** 宿主仅在 catalog 变化时写 request/header，长会话单 catalog 场景下该跨度≈会话长度；每步是 O(1) 精确 eventAt 读（无负载拷贝），受 run deadline 约束且失败关闭，远优于旧 20k 硬顶（超限直接抛错）。独立终审已记录此点；后续可用 volatile last-header-seq 索引降为 O(1)。

## 仍需人工/真实环境 E2E（2026-09-04 对账）

已完成：真实 LLM Guardian 授权内放行/授权外下沉（S1/S2）、SIGKILL 后 pending 状态 cold-resume、policy-v3 danger 升档授权内场景的 live 实测。发布前仍需验证：

1. policy-v3 提示词下的 S1/S2 自动化回归、探针版 S3（规格已备）与 S3b（无授权 danger 必须 human/deny）；
2. `auto-then-user` delegate 后官方 Web approval panel 的完整点击链（live 已观察到状态项与人工兜底，无自动化证据）;
3. Reviewer 子代理树、只读 composer、Stop 与 pending approval 的 UI 优先级；
4. deadline、污染、renew、卸载/重载期间的真实并发与失败注入；
5. 长程 soak。

## 文档

从 [文档地图与维护规则](docs/README.md) 开始：

- [宿主接口与生命周期契约](docs/host-contract.md)
- [施工蓝图](docs/construction-spec.md)
- [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)
- [R4 风险与授权评估](docs/risk-assessment.md)
- [集成验证清单](docs/integration.md)
- [实现状态](docs/implementation.md)
- [0.1.2 验收记录](docs/acceptance-0.1.2.md)

## 许可证与外部参照

本项目原创代码与文档使用 MIT License。官方包 fork 仅修改 `dsh-user-approval`，保留其 MIT LICENSE 与版权声明；`dshApprovalPatch` 明确标识第三方修改版本。Codex Guardian 仅作为能力覆盖参照，不复制或翻译其代码、提示词、测试与文档表达。
