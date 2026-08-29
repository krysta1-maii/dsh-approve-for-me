# Approval Reviewer 独立实现路线

> 状态：2026-08-25 确立；2026-08-27 将父会话材料路线收敛为 DSH Session log + Storage Domain sidecar 驱动的实验性案件卷宗，并确定 principal／delegation-envelope 子代理归因；2026-08-28 宿主行为以 [宿主接口与生命周期契约](host-contract.md) v2（机器决策槽）定稿。本文是协议与 Guarded Continuable 接入完成后，逐步填充审批 Reviewer 产品能力的权威路线图；卷宗接口以 [Guardian 案件卷宗规范](guardian-dossier.md) 为准。

## 1. 实现原则

`dsh-approve-for-me` 采用 DSH 原生、独立编写的 Reviewer 实现。OpenAI Codex Guardian 只作为外部设计参照，用于检查能力覆盖和安全问题，不作为源码、提示词或测试素材来源。

本仓库不得复制、翻译或近似改写 Codex Guardian 的：

- 源代码、函数结构、控制流和注释；
- policy／prompt 文本；
- schema、测试、fixture 和 snapshot；
- 文档表达或按外部项目文件逐项对应的实现切片。

允许参考的是通用目标和可观察的工程模式，例如：隔离 Reviewer、证据信任分级、有界上下文、结构化结果、固定 deadline、有限重试、失败关闭和拒绝熔断。所有类型、策略文本、算法、默认参数和测试必须从 DSH 的需求与威胁模型独立推导。

项目原创内容统一使用 MIT 许可证。若未来确需引入任何第三方内容，必须先单独评审并明确标注；当前路线不引入 Codex 派生内容。

## 2. 当前基线

当前代码已经具备安全审批的执行骨架，但 `policy-v1` 仍是最小保守占位策略，不代表 Reviewer 产品能力已经完成。

| 组成部分 | 当前状态 | 下一步 |
|---|---|---|
| Managed child create／reuse／rotate 骨架 | 已实现；cold-resume／Profile／HMR 尚未实证 | 真实 Profile 与重载验收；Host/plugin lifecycle 与 draining 仍未实现 |
| ActionSnapshot／hash | 已实现通用 v1 | 增加工具族语义投影 |
| request／decision identity | 已实现 | 保持协议兼容并扩充 assessment |
| DecisionChannel／deadline | 已实现 | 增加审查尝试层和持久审计边界 |
| per-parent 串行 | 已实现 | 保持不变 |
| 污染隔离／rotate | 已实现 | 真实恢复与重载验收 |
| Reviewer system prompt | 最小占位 | 独立设计完整策略 |
| 父会话案件卷宗 | Session／sidecar fact source、完整生命周期绑定与受限 v1 compiler 已接入；支持同一开放 turn/step 的 ordinary pending native calls，不支持已完成历史或 delegation | 扩展五段式历史工具与 delegation 投影，并完成真实 Storage Domain 恢复验收 |
| 风险与授权判断 | 只有输出字段 | 在卷宗实现后独立建立 policy 分类和判定规则 |
| token budget／截断 | v1 规定完整或失败关闭 | 先测量完整卷宗，再以新版本定义裁剪算法 |
| full／delta transport | 未实现、非 v1 前置 | 根据完整卷宗实验决定 cursor 方案 |
| 模型／解析重试 | 未实现 | 在单一 deadline 内有限重试 |
| 拒绝熔断 | 未实现，首期范围已收敛 | 仅实现 per-parent-turn 的精确 `actionHash` 重复熔断；语义等价留作未来优化 |
| Reviewer 调查工具 | v1 明确不提供 | 仅在卷宗评测证明必要后重新立项 |
| 业务审计／指标 | 未实现 | 先定义脱敏事件和保留策略 |

## 3. Reviewer 组成部分

### 3.1 Dossier Fact Boundary

父 DSH Session log 直接作为主体对话与执行历史的规范事实来源；编译器不再建立一套静态 trust／authorization 分类来预判消息语义。DSH 正式来源、role、event seq 和 surface 状态原样保留，是否表达授权由 Guardian policy 结合上下文判断。

子代理采用 principal／delegation-envelope 模型：v1 ready dossier 只支持无父 Session 的主／根 Agent requester；意外触发审批的 delegated／custom child 失败关闭。owned 子代理及后代只延伸主 Agent 已发出的事务意图，不创造用户授权。卷宗收录主体侧初始委托、follow-up、workflow／Ralph 和 interrupt 请求，但不遍历 child Session，也不把 report、closing output、reasoning 或工具结果正文保留／投递给 Guardian。主 Agent 后续自己产生的文本和动作仍由主 Agent 承担。

Session log 未持久化的执行期结构化事实只进入官方 Storage Domain sidecar。DSH 公共 invariant 机制能够支持已声明的插件 Session events，但本项目 v1 为保持父 Session 的卸载／独立恢复边界，不新增 `approve-for-me/*` 事件；未来变更必须单独版本化。

退出条件：根 requester、Session 生命周期身份、callId、event seq 与 action hash 关联可验证；enabled tools 有闭集、版本化的 delegation／ordinary 分类，projector 与 safe receipt 不泄漏 child output；sidecar 缺失或冲突失败关闭，同时父 Session 始终可独立恢复。

### 3.2 Parent Session Fact Source

在应用层定义最窄、DSH-neutral 的 `ParentSessionFactSource` 和 `ExecutionFactRepository` port，由 DSH adapter 冻结审批时刻的 Session revision，并从 Session log + sidecar 生成稳定 source snapshot。Policy 和 dossier compiler 不直接依赖 DSH event 类型。

source snapshot 至少携带：根 Session 生命周期身份、event seq、turn／step、纳入消息的来源与内容、excluded-content records、request header／context、闭集工具分类、主体委托请求、从 execution sidecar 冷恢复的 durable safe receipts、工具调用关联、审批审计以及最小执行状态。adapter 在 snapshot 对象形成前按 versioned source policy 丢弃 direct child-origin／tool-result 正文；底层日志 record 可以被反序列化，但正文不在 snapshot 中保留。

退出条件：同一冻结 Session 与 sidecar 在 live 和可重建读取路径上产生相同 source snapshot；错误 Session 生命周期、孤立 sidecar 和动作不匹配均不能编译 ready dossier。

### 3.3 High-recall Dossier and Budget

首期固定采用 [Guardian 案件卷宗规范](guardian-dossier.md) 的五段结构：

1. 完整 DSH 环境信息；
2. 当前生效的 AGENTS.md／CLAUDE.md 指令；
3. 全部直接用户消息、既往正常 turn 最终交付，以及主 Agent 精确委托请求组成的主体意图链；
4. 当前 turn 的完整工具请求及最小执行状态；
5. 当前待审批动作、权限增量和 justification。

编译器不做语义相关性筛选。历史工具结果正文、stdout／stderr、diff、reasoning 和 direct child-origin payload 不进入卷宗；主 Agent 后续自己转述的内容仍属于主轨迹。主体发出的 delegation request 则以精确参数、类型化 safe receipt 和最小 outcome 进入。v1 只能“完整交付”或因硬预算溢出／闭集工具分类、event projection 或 delegation projector 不完整而失败关闭／下沉人工，不得静默裁剪。

退出条件：编译确定性、当前动作不可裁剪、无工具／direct child-origin 结果正文泄漏、异常 turn 不产生虚假交付；闭集 classification catalog fingerprint、source projection version、safe receipt、投影顺序和当前 turn 双射可校验；compiler 记录各分区大小、编译延迟和溢出率，下游 Reviewer／coordinator 再按 dossierHash 联表裁决分布。

### 3.4 Full／Delta Transport

逻辑 dossier 始终是绑定冻结 revision 的完整快照。首期先采用 full delivery 测量真实成本，不把 full／delta cursor 作为卷宗 compiler 的前置条件。

若实验表明持久 Reviewer 重复接收完整材料不可接受，再单独设计 transport cursor；delta 必须能够确定性重建同一逻辑 dossier，历史重写、cursor 缺失、policy／dossier version 变化时必须回退 full。

退出条件：只有在 full 基线指标形成后才确定；任何 transport 优化都不得改变 Guardian 逻辑上看到的案件事实。

### 3.5 Tool-family Action Semantics

保留当前通用 `ActionSnapshot` 作为防重放事实边界，在其上建立工具族 projector registry。优先覆盖：

- shell／process：命令、argv、cwd、环境差异、权限扩张；
- filesystem：目标、操作类型、递归范围和可恢复性；
- patch／write：文件集合、变更范围和工作区边界；
- network：目标、协议、端口、触发动作和可能发送的数据；
- MCP／外部工具：server、tool、参数、账户／目标元数据和能力提示；
- permission request：请求的文件、网络、进程或 sandbox 权限集合。

无法形成完整语义快照的工具不得自动放行；`auto-then-user` 可以下沉人工。

退出条件：每个工具族有正常、缺字段、混淆目标、超大 payload 和不可序列化输入测试。

### 3.6 Risk Taxonomy

建立项目自己的风险类别和规则，至少评估：

- 数据外发与敏感信息暴露；
- 凭据访问和身份冒用；
- 不可逆或高代价破坏；
- 持久安全弱化；
- 权限和 sandbox 扩张；
- 网络暴露与外部副作用；
- 供应链和未验证执行；
- 绕过审批或规避既有拒绝。

每个类别需要定义触发事实、反证、影响范围、授权需求、人工确认条件和绝对拒绝条件。规则文本必须由本项目独立撰写。

退出条件：建立攻击／良性对照用例，风险判断不能只依赖命令名称或路径是否位于 workspace 外。

### 3.7 User Authorization Assessment

沿用项目自有的授权语义，并补充作用域判断：

```ts
interface AuthorizationAssessment {
  readonly level: 'explicit' | 'implicit' | 'absent' | 'conflicting' | 'unknown'
  readonly targetCovered: boolean
  readonly sideEffectsCovered: boolean
  readonly sourceRefs: readonly string[]
  readonly rationale: string
}
```

需要区分“用户要求达到某个目标”与“用户明确授权某个高风险手段”。紧急程度、assistant 自述和外部内容都不能单独提升授权。

退出条件：授权 assessment 可追溯到卷宗中保留的 source refs，缺失或冲突时不会生成自动 allow。

### 3.8 Policy and Decision Contract

完整 policy 由本项目从空白文本独立撰写，至少包含：角色边界、卷宗来源与角色解释、风险规则、授权规则、不确定性处理、调查限制和唯一结构化输出要求。

宿主 `reviewRunId` 标识一次业务 run；每个 attempt 的协议 `reviewId` 绑定 parent、实际 Reviewer Session、generation、action hash 和 deadline。业务 assessment 与防重放 envelope 分离，避免模型字段变化破坏关联协议。

退出条件：policy 版本化；unknown policy 失败关闭；自由文本、缺字段、矛盾字段和身份不匹配均不能产生 allow。

### 3.9 Review Attempts

在一次业务 review run 的固定 deadline 内增加最多两个 Reviewer attempts。所有 attempt 共享同一宿主 `reviewRunId`、不可变 dossier／`actionHash` 和总 deadline；每个 attempt 使用唯一协议 `reviewId` 并绑定实际 Reviewer Session，旧 attempt 的迟到结果不能满足新 attempt。只有明确分类的瞬时 transport／provider 错误、未调用结果工具、可修复的结构化输出错误和干净 Reviewer 的一次非语义故障可以重试。

明确 deny、human_review、abort、身份／hash／generation 不匹配、sidecar 完整性冲突、策略错误和 deadline 到期不得重试。污染 child 的 rotate + fresh-child 恢复属于基础设施恢复，与业务审查 attempt 分开计数和审计，也不能延长外层 deadline；它可改变实际 Reviewer Session id，但不得改变同一 run 的 generation、configuration／route、policy、dossier 或 deadline。

退出条件：最多两个 attempt、共享单一 deadline 和同一事实快照、支持 abort；允许与禁止重试的错误分类都有测试，任何 exhaustion 都按宿主模式失败关闭或有限人工下沉，绝不 allow。

### 3.10 Exact Rejection Circuit Breaker

首期只实现可由现有协议确定证明的精确重复熔断，不建立通用“同一目标”或动作语义等价判断。一个 live parent Session 的同一 DSH turn 内，Reviewer 明确 `deny` 后，若后续审批的 `actionHash` 完全相同，宿主可直接复用拒绝并跳过 Reviewer；新 `callId` 不改变该结论。新的直接用户消息进入主体轨迹后，旧熔断项不再直接复用，后续相同动作必须重新审查，但新消息本身不构成自动授权。

`human_review`、人工下沉结果、基础设施 `unavailable`、timeout、abort 和插件卸载均不建立拒绝熔断。熔断状态只属于当前 live turn；丢失该优化状态最多导致重新审查，绝不能产生 allow。实现不得从命令文本、路径重叠、风险类别或模型解释推断等价，也不得声称修改参数、换工具、间接工具或跨工具族动作与已拒请求相同。

轻微改写、效果键、目标重叠、跨工具族关系、materially safer alternative 和通用绕过识别全部作为未来可选优化；只有在工具族语义模型能够确定投影且独立评测证明收益后，才以新版本立项，不属于当前实现或验收目标。

退出条件：同一 parent lifecycle／turn／直接用户消息 frontier 下，相同 `actionHash` 的首次明确 deny 建立熔断，后续精确重复不调用 Reviewer 且仍映射为拒绝；不同 hash、非 deny 结果、新直接用户消息、下一 turn、abort 和 unload 不误命中；熔断永不映射为 allow。

### 3.11 Optional Investigation

v1 Guardian 是纯卷宗裁决者，不提供读取文件、shell、网络、Session 查询或其他 Agent 工具。只有五段式完整卷宗的真实评测证明某类本地事实会实质改善审批质量，才重新立项目的受限调查能力，而不是开放通用工具继承。

未来任何调查工具必须：无写入、默认无网络、有输入／输出上限、保留明确来源，并遵守 Reviewer deadline。

退出条件：v1 无实现任务；未来立项时逐个工具完成 capability、数据暴露和旁路审计。

### 3.12 Audit, Case Retention and Metrics

数据分成三个边界：

1. **安全关键 facts**：action projection、approval snapshot、safe receipt 与自动 allow 所依据的最小决策记录；按规范 durable 写入，缺失时自动审批失败关闭。
2. **默认最小决策记录**：保存 hash、版本、route／generation、attempt／污染恢复摘要、规范化 decision（不含 rationale 正文）、插件在返回 composer 前确定的 disposition 和失败阶段，不复制完整卷宗、人工 port outcome 或所谓 final DSH outcome；后者只能从匹配的 `approval/decided` Session event 读取。
3. **运行指标**：延迟、错误率、fallback、污染轮换等脱敏 telemetry；尽力写入，失败不得阻止 DSH 工具执行或人工审批。

另提供默认关闭的 `caseCapture.mode: full`：显式开启后保存 Guardian 实际收到的 canonical packet、fingerprint-bound policy artifact 与有界结构化 attempt／结果，用于 parser/coordinator replay、packetHash／packet 内部 dossierHash 验证和旧案例对新 policy 的行为评测；source-backed rebuild 仍必须有存活的 Session + fact sidecar。完整案例与 Reviewer 输入同级敏感，必须有限额、TTL、host-private 访问控制、确定性删除和显式脱敏导出；不得自动进入 Git、telemetry 或 golden fixture。外部模型回放只比较结构化行为要求，不假定逐字确定。

退出条件：可以解释一次 allow／deny／fallback 的依据和失败阶段；自动 allow 在最小记录 durable 前不会生效；完整捕获默认关闭且捕获失败不改变裁决；任何层级都不会保存 provider 凭据、隐藏 reasoning、内部 Controller capability 或 packet 之外的 child／宿主数据。

## 4. 实施顺序

```text
R0 独立实现原则、MIT 许可和路线图
 └── R1 Session/Sidecar Fact Sources
      └── R2 Five-section Dossier Compiler + Full Baseline Metrics
           ├── R3 Tool-family Action Projectors ───────────┐
           └── R4 Risk Taxonomy + Authorization Assessment ┤
                                                           └── R5 Complete Policy + Decision Assessment
                                                                ├── R6 Finite Attempts ───────────────┐
                                                                ├── R7 Rejection Circuit Breaker ─────┤
                                                                └── R8 Optional Transport/Investigation ┤
                                                                                                        └── R9 Audit/Metrics + Security Evaluation
```

R3 与 R4 都是 R5 的前置条件；R6、R7 与 R8 收敛后再完成 R9。R1–R5 是 Reviewer 能够进行有依据审批的主路径。R6–R9 不能用来掩盖主策略不完整；每个里程碑都必须保持当前 fail-closed 性质。

未修改的 stock DSH packages + companion Host Profile 验收可与 R1–R5 并行推进，但须先完成稳定 thin composer adapter。DSH 0.1.1-rc.2 的 private Web sibling listener 只允许在该锁定 Profile 中由 adapter 包装成 request-scoped human port；核心 policy 和任意未知 Profile 不得直接依赖其顺序。在上下文、policy 和风险评测完成前，插件仍只应视为协议与运行骨架，不应宣称具备成熟的自动审批能力。

## 5. 每个里程碑的提交纪律

每一阶段应至少包含：

1. 领域接口和不变量；
2. DSH adapter 边界；
3. 正常与对抗性测试；
4. prompt／schema／默认参数的版本变化说明；
5. fail-closed 回归；
6. 文档状态更新。

外部项目只能进入设计比较文档，不得成为复制源或 golden snapshot。若实现与外部项目出现相似行为，测试应证明这是由本项目需求和 DSH 威胁模型独立推导的结果。
