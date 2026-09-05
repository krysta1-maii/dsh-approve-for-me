# 审批台账施工计划（approval ledger）

> **状态**：2026-09-05，一期的 sealed-facts 施工（WP4/WP5）已在 feat/approval-ledger 实现（当前 HEAD 9af7b4a，609 项测试全绿）；本文仍为新增语义的最高权威。
> **分支／基点**：feat/approval-ledger；基点 3e97af9（实施期间推进至 HEAD 9af7b4a）。
> **权威关系**：本文对新增 sealed facts、授权台账、增量预算、原因码和迁移语义为最高权威；若与 [宿主接口与生命周期契约](host-contract.md) 或 [Guardian 案件卷宗接口与编译规范](guardian-dossier.md) 冲突，新增内容以本文为准。实施时须把两文受影响条款显式标为“由 approval ledger 演化”；未涉及的既有契约保持有效。总顺序见 [文档地图](README.md)，代码事实优先于本文行号。

## 1. 问题定义与证据摘要

当前热路径在 src/plugin.ts:283-337 先调用 session.snapshotEvents()，再以 maxSourceEvents 限制整个会话；src/config.ts:89-149、253-297 把该配置硬顶为 20,000。超限时 assertApprovalSourceEventBudget 抛出 GateFailure(retryable-capability)，src/application/gate-failure.ts:21-31 在 auto-then-user 映射为 delegate，宿主进入人工 waterfall。因此 Reviewer 不创建，afm_decision_records 也不写入。

53k event 的 live 会话连续三次审批均直达人工：approval_snapshots 正常、afm_decision_records 停更、managed-agent 零活动，最后由人工延迟产生 allowed-once。这是确定性容量闸门，不是偶发超时。

603fe18 的卡死修复后成本模型仍成立：awaitApprovalSnapshot 仍全量 filter（src/dsh/execution-projection-bridge.ts:579-605），cold repair 最坏扫描 N（613-688），写 approval snapshot 反向扫描 N（721-767）；fact source 进行全历史连续性、header 收集和冻结（src/dsh/parent-session-fact-source.ts:160-310）；卷宗编译多轮扫描，且 256000-byte 预算在构建后判断（src/application/dossier-compiler.ts:420-929，尤其 902-923）。Storage sidecar list 仅 O(R+A)。N=事件数，R=execution，A=approval，H=header，S=当前 turn step，B=保留字节，D=卷宗字节。

目标是把单审批收敛为“当前动作 + 有界 sealed tail + 有界台账 + 有界近期摘录”。不改变单调用 allowed-once 的原子化、命令中心风险模型或分类目录语义；分类质量仍是最大的安全杠杆。

## 2. 设计原则与不变量对照

| 不变量／硬约束 | 保持／演化 | 落实方式 |
|---|---|---|
| 失败关闭全集：冲突、未知、歧义、卷宗未就绪禁止放行；预期故障不异常逃逸；不得粗暴委派 unavailable | **保持** | seal、台账、tail 的缺失、污染、链断、超预算、取消和 schema 错误均受控映射为 unavailable 或有原因码的合法人工兜底。seal 不等于持久成功；缓存、信封、重放同规。合法重试才可自动放行；Sandbox denial 仅本轮；code-dispatch 歧义关闭；取消先于记录、缓存、seal，返回前重查取消；任何 allow 前仍须 createConfirmed。 |
| 权威事实：仅信 exact Agent/Session、完整生命周期指纹、ask 唯一前序调用、精确 eventSeq、冷事实验证 commitment、污染 Storage 视缺失 | **保持** | **磁盘 seal 链单独不被信任，信任根是 live Session 再绑定。**seal 绑定完整 lifecycle、request eventSeq/type、callId、asked seq、catalog commitment、projector、action hash；进入 hot packet 的每条历史 seal 与轨迹条目均须以 eventAt(sourceSeq) 对 live 会话逐字段复核（有界 O(R) exact get），或锚定到本进程已完成同等再绑定的锚点。绝不以裸 sessionId 键控；Host 精确复核 ask、调用和原文指针；重复或污染行按缺失。 |
| Gate 仅消费品牌化卷宗；完整卷宗无 omissions；header 冻结有效；freeze 取 ask 时间；256000 bytes；编译器纯函数；单写者；有界 Instrumented 指标 | **演化** | 一期仍输出 branded dossier，事实输入改为 sealed facts；frozenAt 仍取 asked event.time。完整卷宗 256000 bytes 不变；新增 hot packet 预构建且有独立上限，超限 budget-overflow。Storage Domain 每 lifecycle 串行，无 CAS 不并发放行；指标只含有界标量且无 ID／内容。 |
| 无精确 projector 不授权；capture 与 durable 共解析；拒绝未知字段与隐式跳转；V1 仅 native-header-only；只信原生 header/catalog | **保持** | preExecute/project 阶段用同一冻结动作、catalog 与 wire 证据盖章。unknown schema、projector、catalog epoch 或环境均不盖章、不授权。 |
| storageDomain.open(spec)，卸载为停、中止、drain、关库；并发／重启幂等 | **保持** | 新私有 domain 参照 afm_decision_records 的 structural API（src/dsh/storage-domain-decision-record.ts:16-119），私有 admission lane、create-once、链尖校验。卸载先停 observer／extractor／policy，再 abort、drain、close。 |
| 2026-09-03 可见性审计：禁止 agent.inject、user/message 等进入模型 surface；禁止新增 afm/* Session event | **保持** | UI 仅只读消费已有 approval/asked、approval/decided 的 Chat node；原因码优先由 decided outcome 的 renderer 映射呈现，细节存 sidecar 并由 renderer 经只读 API 查询。禁止 Session.append、私有 event 和向模型注入状态。 |
| 供应链 | **保持** | registry 精确锁版、pnpm-lock integrity 校验、禁止 file:.artifacts，override 仅保留审批 fork；tracked HEAD 变化必须重跑 smoke。 |

### 防洗白骨架

| 全历史同纹时代的风险 | 增量 seal 时代的防线 |
|---|---|
| 洗白 classification | 每条 seal 固化 canonical catalog fingerprint、descriptor、projectorId、actionHash；当前 execution 必须重验，旧 epoch 只能由封存 commitment 引用。 |
| 伪造 projector | capture 与 durable bridge 共用冻结动作；Host 复验 projector、wire schema 与 action hash；无精确 projector 不授权。 |
| schema 降级重放 | seal、台账、packet 版本闭集并拒绝未知字段；版本、catalog、wire fingerprint 不完全相等即缺失。 |
| 捏造目录 | 目录仅来自原生 request/header 和 scoped catalog；epoch commitment 入 seal 链；LLM／台账不得声明或修改目录。 |
| 失败关闭失触发器 | 链断、seq 空洞、重复、取消、budget overflow、storage 异常都有显式 GateFailure 和失败测试。 |
| 篡改检测归零 | 每行含前链尖 hash 与 canonical 自身 hash；链只提供完整性索引，**不是信任根**。读取先从 genesis 连续验证至 tip，再将所有进入 hot packet 的 seal 和活动条目按 sourceSeq 对 live Session exact 再绑定（或验证本进程已再绑定锚点）；任一 hash、索引、canonical 或 live 字段不符使分区不可授权。 |

## 3. 目标架构

    原生 tool/call 或 code-dispatch-start + request/header
      → capture / scoped catalog / wire 校验（同一冻结动作）
      → execution/result 时写 sealed execution sidecar ─┐
      → 确定性轨迹投影 → 台账：轨迹抽屉             │
      → turn-end 增量 extractor → 台账：授权抽屉       │
                                                       ↓
    approval/asked → sidecar exact 读取 asked + 当前 seal/live 再绑定 + 连续 tail/live 再绑定 + 有界台账/摘录
                  → branded hot dossier / Reviewer packet → Reviewer → Gate
                  → createConfirmed → approval/decided（既有事件）→ 只读 UI

sealed execution facts 是可验证历史索引，不是授权。授权抽屉是带来源的自然语言解析结果，不是 LLM 自证。轨迹抽屉是 execution sidecar 的确定性摘要。Reviewer 是唯一危险性／意图业务裁决者；Gate 只校验、失败关闭、持久确认和宿主映射。

五动作按期执行：一期完成捕获盖章、轨迹投影、sealed-fact 裁决、预算重定位与原因码；二期完成授权抽屉和闲时提取器并切换 Reviewer 输入；三期补失败可见性和可选补盖章。分类目录语义不在任何一期改变。

## 4. 一期施工

### 4.1 模块级清单

| 模块 | 现状 → 目标 | 约束 | 测试 |
|---|---|---|---|
| src/dsh/execution-projection-bridge.ts | project 已冻结 catalog/action（179-274），但审批仍扫 log；仅当该 call 存在 approval/asked 时，捕获 execution/result 当下 create-once seal、前链尖和轨迹。 | 取消先于 seal；capture miss、wire/catalog/projector 不一致不盖章；result 不等于成功。workspace-write 内非提权副作用一期不进轨迹抽屉；一期接受，因累积外发风险主要经越墙动作。 | native、code-dispatch、重复投递、崩溃尾部、取消、链断、catalog epoch。 |
| src/dsh/storage-domain-sealed-facts.ts（新） | 现有 facts repo 与 decision record 分散；新建私有 domain 保存 sealed execution、chain tip、activity。 | open(spec)、append-only/create-once、canonical/hash 校验、单 writer lane；污染视缺失。 | parser、同键幂等／冲突、重启续写、drain/close。 |
| src/dsh/parent-session-fact-source.ts | snapshot 冻结全量连续 log；改为验证当前 seal 及从已验证锚点起的有界 seal 链，并将进入 hot packet 的 seal／轨迹逐条对 live eventAt(sourceSeq) exact 再绑定。 | 磁盘链不是信任根；exact Agent/Session、完整 lifecycle 不变；无章历史不回扫补信任。 | 裸 sessionId 复用、ask 非唯一、seq 缺口、live 重绑字段不符、header/catalog 篡改。 |
| src/application/dossier-compiler.ts | 预算在构建后；增加 sealed-input 路径；完整卷宗仅保留给人工／显式调试入口。 | 热审批路径禁止保留或调用全量编译入口；编译器仍纯函数、品牌化、ask 时间 freeze、header 冻结、无 omissions；hot packet 只含当前分类、轨迹、tail、摘录。 | 尾部／台账边界、预建预算、封装后溢出、保守一致性。 |
| src/plugin.ts、src/config.ts | 删除 snapshotInput 首步 snapshotEvents().length 和 maxSourceEvents 全历史限制；asked 定位改为按 requestId 派生键 exact 读取 approval snapshot sidecar（a1_），仅 sidecar 缺失时走既有有界 cold repair。 | 审批热路径不得调用全量 snapshotEvents；预算只约束 tail／台账／摘录。bridge 的 project() 引用拷贝（197）与 writeApprovalSnapshot 反向扫尾（721-767）残留 O(N) 属捕获路径，不是审批热路径，本期接受且单列观测。 | spy 证明热路径零全量调用；>20k／53k 审批。 |
| src/application/gate-pipeline.ts、gate-failure.ts | failure stage 无机器可分人工原因；扩展 closed reason code 与遥测。 | 不改变 delegate 的宿主语义；unavailable 不得伪装 delegate。 | 每个失败码映射、record/UI、取消优先级。 |
| src/client/* | 既有 renderer 只读 asked/decided；增加原因码 renderer 或 sidecar 只读查询。 | 无新 Session event、无模型 surface、无 request 认领。 | 刷新重建、未知码安全降级、renderer 缺席不影响 Gate。 |

### 4.2 存储 schema 与迁移

新 domain 暂定名 afm_approval_ledger，version 1；实现前以目标宿主实际 Storage Domain schema 定稿。表为 seals、chain_tips、activity 和仅供迁移诊断的 migration。键由完整 lifecycle fingerprint hash 派生，避免存储布局暴露 session/call 标识。

SealV1 至少含 schema version、完整 lifecycle、request eventSeq/type/callId/toolName、approval asked 绑定、actionHash、projectorId、catalog commitment（含 header seq）、wire schema fingerprint、result status、previousSealHash、sealHash、canonical payload。链按 lifecycle 与**链内严格单调递增**的 source seq 排列（非 source seq 等于链位置），**跨 catalog epoch 不分叉而继续链延续**；每行记录 epoch 边界和 commitment，使拓扑与 dossier catalogEpochs 对齐，genesis／tip 均域分隔 hash。ActivityV1 从 seal 确定性投影，只含时间、分类、目标摘要、结果类别和 source seal 引用，不含结果正文、ID 或 LLM 内容。

V1 只接受原子 create-once：相同 canonical 重放成功，不同 canonical 冲突；若崩溃仅留下 identical seal，重放只可在其正好是已验证链尖后的下一条时补齐 activity／tip，其他形状冲突。读取必须验证 parser、canonical、自身 hash、前链和 tip，随后对 hot packet 的每条 seal／activity sourceSeq 做 live Session exact 再绑定；磁盘自洽链永不单独授权。没有该 lifecycle 的 tip 返回空数组；Storage 不可用、未知 row/domain version 或任何污染返回缺失。幂等重放也完整重验链，发现无关持久化污染即冲突；当前有界 tail 内 O(R) 重读可接受。旧 execution sidecar 没有 seal 字段即不是 V1 seal，永久为无章；一期不回填，三期才可后台补章，且不能与自动授权并发。

### 4.3 配置旋钮

| 名称 | 默认 | 边界／语义 |
|---|---:|---|
| maxSealedTailEvents | 256 | 正安全整数；限制审批时未稳定锚定的 seal tail，超限为 tail-budget-overflow。与台账行数门共享同一默认（WP6-b1 实测发现默认 512/256 不一致，已对齐，WP6-b4）。 |
| maxLedgerEntries | 256 | 正安全整数；限制进入 Gate/Reviewer 的台账行数，超限为 ledger-budget-overflow，不能静默截断授权语义。 |
| maxRecentExcerptBytes | 24000 | 正安全整数；仅供意图理解，确定性摘录并带 seq，不能替代当前动作事实。 |
| maxHotPacketBytes | 96000 | 不得高于完整卷宗 256000；预构建预算，超限 budget-overflow。 |
| sealBackfill | off | background-once；仅 idle、无 pending approval、单 writer lane；永不令无章会话自动放行（三期 WP8-c 已实现）。 |

以上默认值均为**待 53k fixture 与 quality smoke 实测校准**的候选值：以固定动作、授权和 catalog 分布测量 tail/台账条数、packet bytes、Reviewer 延迟和人工下沉率；只在不改变失败关闭语义的前提下按 P95/P99 调整，并把最终基线和回归阈值写入 profile smoke。

移除 maxSourceEvents，不保留 alias；含旧字段的配置拒绝启动并给出升级错误，避免误以为 20k 仍保护新热路径。

### 4.4 新失败模式

| 新失败模式 | 失败关闭路径 | 可观测信号 |
|---|---|---|
| seal 冲突、action 不一致、hash 链／live 再绑定不符（篡改信号） | unavailable，不 delegate | sealed-current-conflict／seal-chain-invalid／seal-live-rebind-failed 计数和 metadata-only decision row。 |
| seal 缺失但原因可解释（Storage 暂时故障、捕获期崩溃） | auto-then-user 以 sealed-current-missing 明确 delegate；auto 为 unavailable | 原因码、捕获／Storage 健康计数；不得把未知冲突伪装成可解释缺失。 |
| seal 链断、hash/tip/seq 不连续 | unavailable | seal-chain-invalid、链验证耗时和失败类。 |
| tail、台账或 packet 超预算 | auto-then-user 仅以明确原因码 delegate；auto 为 unavailable | decided renderer 显示容量人工兜底；sidecar 仅保存原因码。 |
| Storage 不可用、污染、并发冲突 | unavailable | ledger-storage-unavailable／ledger-conflict、drain gauge。 |
| 轨迹投影失败 | unavailable | activity-projection-invalid。 |
| 原因码 renderer 读取失败 | 授权结果不变，UI 显示泛化安全文案 | reason-code-render-miss。 |

### 4.5 验收、测试与工作量

1. npm run check 全绿；新增 sealed storage、链验证、capture/result、sealed fact source、hot packet、failure mapping、client renderer 与 profile 回归测试。
2. 构造 **超过 20,000 event** 的会话触发审批，Reviewer 正常创建并裁决，approval/decided 与 durable decision record 正常出现；instrumentation/spy 证明审批热路径**不调用全量 snapshotEvents**。
3. 53k 等价 fixture 的工作量只随 tail／台账上限增长而不随 N 增长；取消、冷恢复、重复投递、污染和链断均无自动 allow。
4. demo kit 三件套重锁、profile:artifact-smoke、profile:quality-smoke、profile:pending-smoke 与 cold-resume smoke 均通过；tracked dependency HEAD 变化必须重跑。
5. 粗估 12–16 工程日：bridge/sidecar 4–5，fact/compiler/gate 3–4，UI/配置 1–2，测试/profile 4–5；二期 LLM extractor 不得混入一期。

## 5. 二期／三期：约束与接口边界

### 二期：授权抽屉与闲时提取器

授权抽屉为 append-only AuthorizationEntryV1：原文逐字引用、sourceSeq、scope、extractor version、解析 hash、链引用。LLM 仅是 parser；Host 必须从 live Session 的 exact sourceSeq 取得原文并逐字匹配引用，否则该条目不存在；与 seal／轨迹的 live 再绑定同规。提取遗漏等同册上无授权，按未知不放行／转人工；原始历史保留给人工与疑难复核。

默认在 turn 结束后，仅解析上个 extraction checkpoint 后的增量；审批时只同步补未处理的有界 tail。authorizationExtractor.enabled=false 时不废除机制，而改为审批同步补尾部，代价是有限延迟。checkpoint、entry 与输入范围都 hash 链接且幂等。

提取器隔离要求与 Reviewer 同级：不继承父历史；approval 固定 never；read-only、无网络；仅注册本轮可重新 arm 的工具；不得有直接写台账 capability。Host 是唯一 writer，写前复核 sourceSeq/原文。Reviewer 输入切换为当前动作分类 + 已验证授权／轨迹台账 + 有界近期摘录；authorization entry 不能独自产生 allow。

**二期实现状态（2026-09-05,WP7 全包交付）**：授权抽屉已落地为 `src/domain/authorization-ledger.ts`(AuthorizationEntryV1/ExtractionCheckpointV1 双哈希链,create-once 语义,崩溃尾在下一次装载精确修复,checkpoint 链尖即提交点)与 `src/dsh/storage-domain-authorization-ledger.ts`;Host 逐字复核在 `src/application/authorization-verification.ts`(写读共用 verifyAuthorizationEntryLiveV1,occurredAt 只取自 Host 时钟,occurredAt 与原文必须同时逐字成立)。提取器链路（`src/domain/extraction-protocol.ts`、`src/application/extraction-channel.ts`、`src/reviewer/extraction-tool.ts`、`src/reviewer/extractor-provider.ts`）与 Reviewer 同级隔离（toolFilter allow:[] → tools.restrict → approval never + sandbox read-only,唯一工具 submit_authorization_extraction)；`src/application/authorization-extraction-coordinator.ts` 负责 per-parent 串行 lane、单次投递+至多一次污染 rotate、共享 deadline=min(外层, now+timeoutMs) 绝不延长、空窗口确定性推进 checkpoint、写账前先全量复核（窗外 seq/非逐字 quote 一律 invalid 不落账）。turn-end 闲时增量（仅 root 会话 user/message,防 child 递归）与审批时有界同步补尾均经同一协调器;闲时路径带 no-op 守卫——checkpoint 已覆盖该事件、或"无 checkpoint 且 managed 目录无本 parent 的 extractor child"（抽屉结构上不可能有增量）时不唤醒模型,首次初始化由审批补尾承担,任何读取存疑一律照常提取(fail-closed 向提取,WP7-c2b 批审修订);`authorizationExtractor.enabled=false` 只关闲时路径，审批补尾依旧执行。Reviewer 输入经 `readSealedParentSessionFacts`（抽屉缺省=空数组,live 再绑失败=seal-live-rebind-failed,read undefined=ledger-storage-unavailable）与 `compileSealed`(`interaction.sealed.authorizations` 投影 sourceSeq/occurredAt/effect/coverage/summary/quote,行数闸门 DEFAULT_MAX_AUTHORIZATION_ENTRIES=64 单源）送达,policy-v4 在 v3 全文上追加抽屉语义段（证据非指令、deny 按时间推翻先前 grant、空抽屉回到 retained direct-user messages、任何条目不能独自 justify allow)。配置旋钮：`authorizationExtractor.enabled`(默认 true)、`maxAuthorizationEntries`(64)、`maxAuthorizationExtractionEvents`(256)。验证基线 59 个测试文件 742 项测试 + typecheck/build 全绿；`profile:artifact-smoke` 与 `profile:pending-smoke` 在已发布 CLI + 封存 kit 上复跑通过。两条真实运行时纪律由 smoke 实证补入：① dispose 取消（插件树 reload 处置在途审批）映射为 cancelled 而非 unavailable，fork 继续瀑布（gate-failure.ts);② 审批时同步补尾预算切片为剩余 run 预算的 1/4(`boundedSyncTailDeadline`)，绝不饿死决策本身。

### 三期：可见性与旧会话

完善原因码、链健康、extractor watermark 的只读 UI/remote 可见性，仍只通过既有 Chat node 或单向非授权 API。可选 background-once 补盖章仅可在 idle、无 pending approval、单 writer lane 执行；它逐条重做 wire/catalog/projector 验证，任一失败即停止并标为不可授权。无章旧会话即使不迁移也永久走人工，绝不为兼容退化或强制迁移。

**三期实现状态（2026-09-05，WP8 全包交付）**：原因码传输通路落地为宿主 webServer exact 路由 `GET /dsh-approve-for-me/v1/reason-code`（src/application/reason-code-route.ts 纯 handler：GET-only、requestId 有界校验、GATE_FAILURE_CODES 闭集出闸、内部异常恒 200 miss；src/plugin.ts probe-cast 注册，CLI 无 webServer 自动跳过，注册失败不 fail mount，dispose/rollback 对称）+ 浏览器桥 src/client/reason-code-remote.ts（in-flight 去重、256 条 keep-newest settled 缓存、一切失败 settle null=泛化文案）+ ApprovalFlowItem 拆分为纯视图 ApprovalFlowItemView 与无条件 hooks 包装器（unavailable 且无码时异步补齐重渲染）——一期"恒泛化 miss"在 Web GUI 下解除。链健康/watermark 可见性落地为 `GET /dsh-approve-for-me/v1/ledger-health`（src/application/ledger-health-route.ts，段省略式降级、normalize 闭集双闸、注入时钟）+ 两个存储域的写者维护 O(1) stats 行（Storage Domain 表无枚举能力的定案；sealed-facts 在索引新链环且全链重验后 bump、authorization 仅 committed 路径 bump，重放不重计；informal gauge 崩溃夹缝最多欠一，非授权面）+ 插件设置卡只读"台账健康"区；线形只有计数与 seq 标量，无 ID/hash/内容。sealBackfill 解冻为真 boolean（默认 false）：SealBackfillRunner（src/application/seal-backfill.ts）per-lifecycle 单写 lane + 每进程至多一次 + AbortController 注册表；构造公式抽为共享纯函数 src/application/seal-projection.ts（live bridge 与 backfill 共用，既有 bridge/sealed-facts 测试零改动通过=零漂移证据）；触发=root 会话 turn/end 且无在途审批 run，新审批 run 或新 user/message 立即 abort；任一失败（快照歧义/live 再绑不符/projector 不可解析/append conflict/存储不可用）整体停止，该 lifecycle 保持无章永不自动放行。验证基线 65 个测试文件 835 项测试 + typecheck/build 全绿。

## 6. 兼容与迁移

- 旧 execution_facts 与 approval snapshot sidecar 保留只读诊断价值，但无 seal 时不可作为自动授权来源。
- schema 版本只前进；读取旧版本只能经专门 migration reader，禁止宽松 parse。未完成迁移不影响人工 waterfall，但禁止自动 allow。
- catalogEpochs 仍是完整卷宗中已验证执行历史的 epoch 表（dossier-compiler.ts:790-869）；seal 用同一 commitment 建一条跨 epoch 连续链，并在每条边界记录旧／新 commitment，不能用 ledger 取代 epoch 证据。新 epoch 只开启新 commitment，不能覆盖旧 epoch。
- 装载先 open/校验 domain，再注册 observers/machine policy；卸载顺序为停止新输入、abort in-flight、drain bridge/extractor/storage lanes、注销 policy/provider、close domain；重启只从已验证链尖恢复。

## 7. 非目标

- 不改变 approval fork 的 delegate waterfall、allowed-once 原子语义或分类目录语义。
- 不在 Host 引入 codex 式命令规则引擎，不用台账取代 Reviewer 的危险性／意图裁决。
- 不把 parent 内容、agent.inject、user/message 或新增 afm/* event 放入模型 surface。
- 不把 tool output、文件内容、diff、LLM rationale 或可识别 ID 写入轨迹摘要／指标。
- 一期不交付 LLM 授权解析、全历史自动补章、跨 profile 并发写、CAS 假设或旧会话自动放行。

## 8. 文档同步清单

| 文档 | 同步内容 |
|---|---|
| README.md | 说明长会话审批能力、阶段状态和人工兜底，不复制接口。 |
| docs/implementation.md | 以测试／提交更新已实现与未实现、测试数量、Storage domain、UI 通路。 |
| docs/README.md | 加入本文，并列为 approval-ledger 新增语义的权威入口；既有契约演化后更新顺序。 |
| docs/guardian-dossier.md | 显式标记从全历史事实编译到 sealed facts/hot packet 的演化，保留完整卷宗不变量。 |
| docs/host-contract.md | 显式标记预算、失败码、storage lifecycle、UI 原因码通路由本文演化，保持 delegate/unavailable 边界。 |
