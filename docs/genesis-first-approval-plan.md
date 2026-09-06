# 首审机器评审施工计划（genesis first-approval review）

> **状态**：2026-09-06，WP10-a/b/d/e 已施工（3461d44 / 8150cc2 / ec40db9 / 本次改动），待独立审查终审；WP10-c（配置层，另案）未施工。
> **分支／基点**：建议 feat/genesis-first-approval；基点 main@d28d9a5（feat/approval-ledger 已并入）。
> **权威关系**：本文对 genesis 首审语义（空密封台账合法化、chain-initialized 判定、首审抽屉降级）为最高权威；本文显式演化 [审批台账施工计划](approval-ledger-construction-plan.md) 的 empty-ledger 条款（WP4-b4 §4.4 路由）与 [0.1.2 验收记录](acceptance-0.1.2.md) 的冷启动委托预期，其余既有契约保持有效。总顺序见 [文档地图](README.md)，代码事实优先于本文行号。

## 1. 问题定义与证据摘要

**现状**：每个会话的第一次审批必然直达人工，Reviewer 不拉起。根因是取证层的保守缺省：`readSealedParentSessionFacts` 对 `rows.length === 0` 返回 `empty-ledger`（src/dsh/parent-session-fact-source.ts:435），gate 解析器抛 `sealed-current-missing`（src/application/source-backed-gate-facts.ts:446-447），早于 preReview；auto-then-user 下映射为 delegate（src/application/gate-failure.ts:109）。

**设计意图（2026-09-06 用户澄清）**：首个审批也应走机器评审，由 Reviewer 按证据裁决；人工只在 Reviewer 判 human_review 或基础设施失败时介入。冷启动 delegate 是实现保守缺省，不是安全模型的内在要求。

**live 证据（.scratch 会话 session-887b6d36，2026-09-06 08:30-08:31，安装 Tavily MCP）**：

| 时刻 | 事件 |
|---|---|
| 08:30:48.817 | 审批 #1 asked（edit ~/.dsh/.agent-presets/standard-instant，escalate danger-full-access） |
| ~08:30:49 | gate 取证遇空台账 → sealed-current-missing → delegate，人工弹窗；Extractor 08:30:50 才由捕获管线拉起（台账维护通道，不在决策路径） |
| 08:31:17.354 | 人工 allowed-once；#1 的密封行 08:31:17.423 才落盘（密封在动作完成后写，天然滞后于审批） |
| 08:31:26.703 | 审批 #2 asked（ptc-instant 同样改法）；链上已有 #1 行 → read ok → live rebind → verified dossier |
| 08:31:27.860 | Reviewer 拉起；packet：authorization=unknown、destructive-change + permission-expansion、risk=high |
| 08:31:51.265 | Reviewer 提交 human_review（无任何用户授权证据），gate → delegate → 人工 08:31:54.371 allowed-once |

**关键观察**："空台账"等价于"本会话还没有任何已完成的审批类动作"（拒绝/取消的审批不产生密封；普通工具调用不进台账）。这是一个**常见合法状态**，不是异常——只跑过 workspace-write 内操作的会话首次提权时必然遇到。

**附带缺陷（同场发现，本文 §8 一并立项）**：#2 走 guardian→human_review→delegate 路径，按 gate-pipeline 应写 best-effort GateDecisionRecord，但 afm_decision_records 当日零落盘；该 store 历史上只落过 allow 记录，delegate 类记录疑似从未成功写入。

## 2. 为什么不动安全模型

既有契约（approval-ledger-construction-plan.md §2）钉死了信任根：

> 磁盘 seal 链单独不被信任，信任根是 live Session 再绑定。

逐条核对 genesis（空链）下每项防线：

| 防线 | 空链下的表现 | 结论 |
|---|---|---|
| 当前动作冻结承诺 vs 持久 header 事件（wireSchemasDigest / header.type 复核） | 数据来自捕获侧 execution fact + `eventAt` 读原始日志，**不经过台账** | 不受影响 |
| intervening-header 游标扫描防 catalog shopping（source-backed-gate-facts.ts:320-323） | 纯原始事件回扫 | 不受影响 |
| catalog epoch 交叉校验（sealedCurrentCatalogEpochMatch） | 空 epochs 时 `find` 返回 undefined → vacuous-ok（:342-348）；当前动作承诺仍由上一行防线验证 | 不弱化 |
| 当前/历史行 live rebind（eventAt 逐字段复核） | 零行即零次循环，平凡通过 | 不受影响 |
| currentFacts / carrier（捕获冻结侧车 + approval 快照互验） | 全部来自 snapshotInput，**不经台账** | 不受影响 |
| 授权抽屉逐条 live 复核（verifyAuthorizationEntryLiveV1） | 空抽屉=零条目；有条目仍逐条复核 | 不受影响 |
| 链完整性（genesis→tip hash 连续） | 无 tip=未初始化（合法 genesis）；有 tip 但任一环节破损 → `validated()` 返回 undefined → 硬 unavailable（**既有行为，保持**） | 部分擦除仍失败关闭 |
| R4 永不把 unknown 授权升级为自动放行 | genesis 下授权=unknown，Reviewer 失败关闭倾向不变 | 不受影响 |

结论：genesis 路径的每项证据仍是 source-verified；失去的唯一信息是**历史活动上下文**（Reviewer 看不到本会话此前的审批类动作记录）。该信息的缺失向 Reviewer 显式可见（空 seals/activities/catalogEpochs），由 Reviewer rubric 权衡，不是隐藏降级。

### 2.1 全量擦除的残余风险与立场

唯一新增暴露面：把 afm_approval_ledger 某生命周期**整体擦除**（tip+全部行）后与从未初始化不可区分，Reviewer 将看不到该会话的历史活动。立场：

1. 威胁模型边界：能删除 ~/.dsh/storages 的行为体已具备宿主级文件能力，可直接禁用插件或篡改会话日志本身；台账链的设计目标是**完整性索引**（检测不一致/腐败/部分篡改），不是宿主取证。
2. 跨域交叉检查**不可用**：授权检查点存在但密封为空 ≠ 篡改——"此前审批全被拒绝/取消"的会话合法地处于该状态（拒绝不产生密封）。误报会把正常会话打成不可用。
3. 因此本文接受该残余风险，不引入 chain-initialized 独立标记——**chain_tips 行本身即是初始化标记**：无 tip=genesis（合法），有 tip 但链破=unavailable（既有）。若未来威胁模型扩展到宿主级篡改，再立项跨域/跨进程锚点。

## 3. 目标行为

| 场景 | 现状 | 目标 |
|---|---|---|
| 首审（无任何已完成审批类动作），证据完整 | sealed-current-missing → delegate → 人工 | 正常编译 genesis dossier → Reviewer 裁决（allow/deny/human_review）→ 按裁决路由 |
| 首审 + Reviewer allow（低风险） | 人工 | **自动 allowed-once**（createConfirmed 落盘） |
| 首审 + Reviewer human_review（高风险/授权 unknown） | 人工（infra 兜底） | 人工（**Reviewer 证据裁决**，留 guardian/delegate-human 审计记录，GUI 可显示具体原因） |
| 有 tip 行但链破损/行缺失 | 硬 unavailable | 保持硬 unavailable |
| 台账存储不可用 | ledger-storage-unavailable 硬 unavailable | 保持 |
| 首审期间取消/超时 | cancelled/unavailable | 保持 |
| 第二审起 | 不变 | 不变（非回归门禁） |

trust-envelope 快速通道（现 live 配置 disabled）同样经 facts.resolve，genesis 修复后其在首审即可按既有语义生效；本计划不改动信封求值本身。

## 4. 变更点（WP10 工作包划分）

### WP10-a genesis 取证分支

> **完成状态：已施工（8150cc2），含钉住测试；待独立审查终审。**

- `readSealedParentSessionFacts`：删除 `rows.length === 0 → empty-ledger` 早退（parent-session-fact-source.ts:435），让零行走正常 'ok' 构造：链验证循环平凡通过、epochs 空、packetRows 空、抽屉照常读、current 缺席（正常 pending）。返回的 SealedParentSessionFactsV1 形状不变（seals/activities/catalogEpochs 为空数组），**无 packet schema 变更**。
- `source-backed-gate-facts.ts` resolve：移除 empty-ledger 分支（:446-447）；其余闭集校验原样。genesis 下 epoch 交叉校验 vacuous-ok、intervening-header 扫描与 currentFacts/carrier/compileSealed 不变。
- `compileSealed`：核对零行 packet 通过全部闭集校验（sealed-dossier-compiler.ts:265 已只要求数组）；若有隐含非空假设，按闭集原则显式放开空数组并加钉。
- gate-failure 路由表：`sealed-current-missing` 不再被抛出。码值在 GateFailureCode 闭集、client reason-code union 与 locales 中**保留**（历史 reasonCode sidecar 行的渲染兼容），删除抛点与路由项，更新 WP4-b4/WP6 钉住冷启动 delegate 的测试。

### WP10-b 提取协同（确认现状即可，零或极小改动）

> **完成状态：已确认现状（零代码改动，gate 不阻塞等待模型提取与既有降级原则一致）；待独立审查终审。**

- gate **不阻塞等待模型提取**：抽屉取最近检查点状态，空=授权 unknown，交 Reviewer 权衡——与 excerpts/抽屉既有"失败/空降级、不阻塞审批"原则一致。审批到达时的 catch-up 在无新用户消息时只同步写空 delta 检查点（实测 12ms），有模型提取时异步进行、服务后续审批。**此行为已是现架构，本 WP 仅加测试钉住。**
- 可选配置 `extractorWarmup`（默认 off）：放宽 plugin.ts:964-980 的 no-op guard，首条 root user/message 即初始化抽屉。默认保持懒惰（不为无审批会话白拉模型）；高审批密度部署可开。

### WP10-c 延迟余量

> **完成状态：未施工（配置层，另案处理）。**

- 实测：Extractor 14s、Reviewer 24s（deepseek-v4-flash-vision-exp），gate timeoutMs=30000，#2 仅剩 5.4s 余量。首审走评审后超时=retryable-capability→delegate，虽仍人工但浪费一轮评审。
- 项 1：live profile 的 timeoutMs 提升至 45000（配置层，非代码）。
- 项 2：评审/提取模型路由裁决——cordis.patch.yml（gpt-5.6-terra）与 settings.yaml GUI 卡（deepseek-v4-flash-vision-exp）当前漂移，需选定唯一预期值并钉住漂移检测行为。
- 项 3（可选，另立项）：会话级常驻 Reviewer（原始设计意图），消 spawn 延迟。

### WP10-d delegate-human 决策记录落盘修复

> **完成状态：已施工（ec40db9，debug 可观测性 + 12 项钉住测试）；待独立审查终审。**

- 症状：guardian→human_review→delegate 路径的 best-effort 记录不落盘（write 失败被 recordBestEffortSafely 静默吞掉）。
- 排查：DSH_APPROVE_FOR_ME_DEBUG=1 在 .scratch 复现一次首/次审，观察 [approve-for-me gate] sealed/failure 日志与 store write 返回值；候选根因：tails 链内 put 校验失败、live 实例 domain 打开异常、或 sealed 处置字段在 live 构建上的形状偏差。
- 修复后以 WP10-e 测试 3 钉住。

### WP10-e 测试与验收更新

> **完成状态：已施工（本次改动）；待独立审查终审。** 项 1/2/3/4/5/6 由 WP10-a（8150cc2）的钉住测试覆盖；项 7 本次增补（genesis 评审中取消→cancelled、预取消→cancelled 且 Reviewer 未被咨询、评审中超时→unavailable，均无授权无确认记录）；项 8 非回归（903 测试全绿）；项 9 两 smoke 脚本文案已同步为 genesis 语义，但可执行断言仍受 deployment-frozen 预 WP10 产物约束（详见 acceptance-0.1.2.md WP10 节「smoke 现状」）。

1. genesis ok e2e：首审（夹具 approval-e2e.ts 不加历史行）→ facts ok、dossier branded、packet 送达 Reviewer。
2. genesis + Reviewer allow → allowed-once，createConfirmed 记录落盘（guardian route）。
3. genesis + Reviewer human_review → delegate → 人工；**best-effort guardian/delegate-human 记录断言落盘**（钉 WP10-d）。
4. 有 tip + 行缺失/链断 → 硬 unavailable（既有语义重钉）。
5. genesis + intervening-header 伪造 → unavailable（原始事件游标扫描仍守）。
6. genesis + 抽屉条目 live 复核失败 → seal-live-rebind-failed → unavailable。
7. genesis + 评审中超时/取消 → cancelled/unavailable，无授权、无记录或仅失败记录。
8. 非回归：既有 609+ 测试全绿；第二审路径行为字节级不变。
9. smoke：acceptance-0.1.2.md:51 的"冷启动委托到 composed answerer"预期更新为"冷启动机器评审（allow 与 human_review 两路）"，profile:artifact-smoke 同步。

## 5. 配置变更

| 键 | 默认 | 说明 |
|---|---|---|
| `genesisReview` | `true` | genesis 取证分支开关；false 回退为现行 sealed-current-missing→delegate 行为（回滚通道）。闭集 config 校验同步加键。 |
| `extractorWarmup` | `false` | WP10-b 可选项：首条 root user/message 即初始化授权抽屉。 |

## 6. 不变量对照（演化声明）

| 既有不变量 | 保持/演化 | 说明 |
|---|---|---|
| 失败关闭全集：冲突、未知、歧义、卷宗未就绪禁止放行 | **保持** | genesis 只是合法空态，不是未知/歧义；链破、存储故障、复核失败仍硬 unavailable。 |
| 信任根是 live Session 再绑定，磁盘链仅完整性索引 | **保持** | genesis 的全部证据经 eventAt/捕获侧车验证；空链无证据可验证≠证据不可信。 |
| Gate 仅消费品牌化卷宗；闭集拒绝未知字段 | **保持** | packet schema 不变；零行走同一编译器。 |
| 无精确 projector 不授权 | **保持** | 当前动作盖章路径不经台账。 |
| R4 永不升级 unknown 授权为自动放行 | **保持** | genesis 抽屉空=unknown，Reviewer 裁决。 |
| 冷启动一律人工（WP4-b4 §4.4 路由） | **废除** | 由本文 §3 目标行为替代；smoke 预期同步更新。 |

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 全量擦除降级为 genesis，Reviewer 失去历史上下文 | 威胁模型外（§2.1）；Reviewer 可见空历史并倾向保守；抽屉/摘录仍提供近期意图 |
| 首审评审延迟贴 timeoutMs | WP10-c；超时路由不变（retryable-capability→delegate），不劣于现状 |
| genesis 分支引入编译器隐含假设 | WP10-e 测试 1/2/3 + 闭集校验审查 |
| 上线后行为意外 | `genesisReview: false` 一键回退为现行为；记录/原因码闭集保留历史渲染 |

## 8. 工作量估计

WP10-a 核心改动小（删除早退+分支，约百行内+测试）；WP10-b 测试钉住；WP10-c 配置与模型裁决；WP10-d 需一次带 debug 的 live 复现；WP10-e 测试矩阵为主体工作量。整体一个 WP 粒度，建议单分支 feat/genesis-first-approval 交付。
