# Approve for Me 最终设计共识

> 状态：2026-08-24 建立业务边界；2026-08-25 部署机制改为 stock DSH 上的 Guarded Continuable，并确定 Reviewer 后续采用独立 MIT 实现；2026-08-28 宿主 fallback、生命周期、有限尝试、事实持久化、案例留存和配置取向已形成 [宿主接口与生命周期契约](host-contract.md)。审批协议、身份／哈希校验、失败关闭、最小权限和每父 Reviewer 等产品边界继续有效；早期“官方第三 mode”与 patched API 描述均由 [`dsh-managed-agent` 无补丁改造计划](../../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)取代。

## 1. 项目定位

`dsh-approve-for-me` 是面向 DSH 的受管自动审批 provider 插件，也是 `dsh-managed-agent` 的首个适配应用。历史工作名 `dsh-approval-for-me` 已废弃。

项目不是绕过审批，而是为 DSH 的单一终端 approval policy composer 提供一个隔离、可审计的自动 Reviewer policy。只有通过完整 schema、身份、哈希、代际和 deadline 校验的确定性 `allow` 才能映射为单次 `allowed-once`。

## 2. 基础设施边界

最终基础架构是 `dsh-managed-agent` 在 stock DSH 官方 `continuable` child 上提供的 Guarded Continuable Host 服务。本插件只通过标准 Cordis service 注册稳定 provider：

```text
dsh-approve-for-me/reviewer
```

`ctx.managedAgents.registerProvider()` 返回进程内、不可序列化且 registration-scoped 的 Controller capability：

```text
create(parent, options)
list(parentSessionId)
rotate(parent, childId)
deliver(parent, childId, ContentBlock[])
interrupt(parent, childId)
```

基础层负责 provider ownership、父子 Session 谱系、exact live parent／direct child 校验、受控 create／same-Session resume／inbox admission、持久 catalog、污染标记与轮换、Activation release，以及官方子代理树和只读 Web 语义。

基础层明确不负责 Approval schema、一父一实例、request id、业务 result、deadline、审查尝试、风险策略、业务 generation、失败映射或人工回退。以上规则全部属于本仓库。

## 3. 角色与 authority

### Parent Agent／Session

DSH `approval/request` 提供的 `req.agent` 是请求发生时的精确 live Agent，也是 Managed Controller create／deliver 的 authority。不得只凭 `sessionId` 重新查找 Agent，也不得使用全局 current initiator 替代它。

持久 `parentSessionId` 只用于归属、串行 lane、发现和协议身份，不单独授予控制权。

### Managed Controller

Controller 属于 provider registration，而不是某个 child 或 parent。它可以管理该 provider 的多个 Reviewer，但每次调用都由基础层重新校验 exact parent、direct child 和 descriptor provider。

### ReviewerSessionManager

Manager 是本插件对 Controller 的应用层 wrapper，不是 authority 本身。它负责按 parent 串行审批、查找或懒创建 Reviewer、构造请求、在 deliver 前 arm broker、关联结果、timeout／abort interrupt 和 fail-closed reduction。

### Approval Reviewer

Reviewer 是由 `ctx.managedAgents` 独占管理、底层使用官方 `continuable` wire mode 的持久 child Session。其 Activation 可以在 idle 后释放；后续审批通过同一 child cold-resume，继续保留兼容 transcript。产品界面可以标识为 Managed Reviewer，但不得把该语义误写成官方新增的 `managed` mode。

### Terminal approval composer／HumanApprovalPort

DSH 明确要求部署组合一个 terminal answerer，普通 sibling waterfall listener 的注册／prepend 顺序不是 policy priority 机制。因此本插件不得把“自动 listener 调用 `next()`，恰好落到人工 sibling”当成产品契约。

宿主必须提供一个显式 terminal approval composer（或等价的 profile-owned broker），由它按固定代码路径组合 `ApproveForMePolicy` 与 `HumanApprovalPort`，并且只由该 composer 向 DSH `approval/request` 提议 answerer outcome；权威最终值仍由 DSH 与 abort signal 竞速后写入 `approval/decided`：

```text
DSH approval/request
→ terminal composer
  → 唯一全局 approve-for-me 自动 policy slot
  → 仅在 disposition = delegate-human 时调用 HumanApprovalPort.answer(同一 borrowed request)
→ composer proposal
→ DSH abort race + authoritative approval/decided
```

v1 composer 只提供一个全局自动 policy slot：插件挂载期间每个 `ApprovalRequest` 都进入该 policy，不支持的请求也必须显式映射；第二个自动 policy 注册无条件失败，不使用任意 `owns(request)` predicate。`auto` 不需要人工 port；`auto-then-user` 在挂载时必须取得显式 `HumanApprovalPort`／broker registration，缺失时拒绝启用该 mode。人工 port 负责 Web／ACP／其他部署的人类交互，Reviewer 不得自行聊天式询问用户。broker 生命周期独立于自动 policy registration：插件卸载只撤销自动 policy，人工 terminal fallback 继续存在。

当前代码仍以 prepended sibling answerer + `next()` 实现，这只可视为待迁移骨架，不满足 stock DSH 的最终宿主契约；真实 profile 验收前必须完成 terminal composer 接口和迁移。DSH 0.1.1-rc.2 的 Web 人工审批由 `dsh-host-apiproxy` 内部 sibling listener 实现，并未公开可调用的 human port；因此 profile composer seam 是明确的宿主集成前置条件，不能由本插件读取其 private pending registry 或复制 Web 协议来伪造。该 seam 未提供时，本项目两个 mode 都不得宣称完成 stock Web profile 验收，`auto-then-user` 必须拒绝挂载。

## 4. 实例和生命周期

首期策略是“一父 Session、一个当前配置代际的 primary Reviewer”：

1. 首次 approval hook 在 parent lane 内 `list()`。
2. 只复用 provider、parent、role、generation 和 configuration fingerprint 全部匹配的 child。
3. 没有匹配项时 `create()`；多个当前匹配项视为歧义并失败关闭。
4. 旧 generation 或不兼容 providerData 的 child 保持 dormant 历史，不用新 composition 静默解释。
5. 后续请求对同一兼容 child `deliver()`；Runtime 必要时 cold-resume。
6. Parent Agent runtime 卸载后，旧 Agent authority 失效，live descendant 被 drain，但已持久化 Session 和 transcript 保留。
7. Parent Session 以后恢复时，新 exact parent Agent 可以重新发现兼容 child。
8. Provider unload／HMR 撤销旧 Controller；重新注册后获得新 capability。

“持久 Reviewer”不等于常驻进程 Agent，也不表示 parent teardown 会删除 child 历史。

### 4.1 宿主状态与 pending approval

宿主目标状态机为：

```text
starting → ready → draining → disposed
                  ↘ failed
```

只有 `ready` 接受新的自动审批。卸载／HMR 先进入 `draining`，但 terminal broker 中的状态感知 policy gate 必须保留：draining 期间新 `auto` 请求返回 `unavailable`，新 `auto-then-user` 请求由 policy 立即返回 `delegate-human`，不能因先注销 listener 而绕过 mode。随后宿主终止当前自动审查、disarm pending result channel、interrupt／drain live Reviewer、排空已经入队的安全关键 sidecar 写入，撤销 provider／capture hooks；所有**插件拥有的**存量 policy 调用 settle 后才最后撤销自动 policy registration、幂等关闭 owned Storage Domain handle 并进入 `disposed`。policy 返回 `delegate-human` 后，人工 pending 由 profile composer 独占且不计入插件 in-flight，dispose 不等待用户作答。broker／人工 terminal fallback 不随自动 policy registration 销毁；dispose 必须幂等。

Reviewer Session 可以在以后 cold-resume，但某一次 pending approval 绑定旧 open turn、deadline、generation 和一次性 result channel，**不得跨 unload／reload 恢复**。`auto-then-user` 中，正常卸载时仍活跃的存量请求交给显式人工 port；已经 Stop／Abort 的请求返回 `cancelled`。重载后的自动审查必须是新请求和新 result channel，不能接受旧 generation 的迟到结果。

这采用取消重建而不是无缝续审：审批结果是当前精确工具调用的一次性 capability，不是可跨宿主代际恢复的业务任务。

## 5. providerData

providerData 是 Runtime 不解释的 lossless JSON。首期包含 schema version、`primary` role、应用 generation、可复算 configuration fingerprint、provider／model／effort route、policy version 和 toolset version。

它不得包含凭据、函数、工具对象、Agent、Session、Controller 或业务请求。每次 materialize 都必须严格运行时解析；未知版本、额外字段、非法 route 或错误 fingerprint 明确失败。

Reviewer route 必须由插件配置显式固定，不继承主 Agent 当前 provider／model，也不在 route 不可用时静默切换。缺失、空值或 schema 非法的 provider／model id、generation、policy version 或 toolset version 应在 provider 注册前使插件挂载失败。stock DSH model selection 不负责预检 catalog；因此语法有效但不存在／暂不可用的 route 在 materialize／request 时按 Reviewer 能力故障处理，在 `auto-then-user` 中可以人工恢复，但不能改用另一模型。只有未来显式注入权威 provider/model catalog verifier 后，才能宣称挂载期验证 route 存在。

## 6. 动作捕获

DSH `approval/request` 只有 Agent、tool name、可选 call id／reason／signal，不包含工具参数。自动 Reviewer 不能只依据 tool name 决策。

本插件将在 `tools/pre-execute` 中以 exact Agent + call id 捕获完整、frozen 的 `ToolExecution.arguments`，并在 `tools/result` 后释放。只有 call id、exact Agent 和 tool name 全部匹配时才自动评审。

缺失或不匹配时：普通能力缺失在 `auto` 返回 unavailable、在 `auto-then-user` 由 terminal composer 调用显式 `HumanApprovalPort`；若已经形成身份／完整性矛盾，则两种 mode 都硬停止。

## 7. action hash

`ActionSnapshot` 首期包含 schema version、`kind: 'tool-call'`、tool name、lossless JSON arguments 和归一化 requested permissions。

哈希使用：

```text
SHA-256(
  UTF8("dsh-approve-for-me/action-snapshot/v1\0")
  + canonical JSON(ActionSnapshot)
)
```

对象 key 顺序不改变哈希，数组顺序和任意动作字段变化必须改变哈希。`reviewId`、deadline、parent 和 Reviewer identity 由 ApprovalRequest 独立绑定。

## 8. ApprovalRequest

每个请求绑定 protocol version、plugin-owned `reviewId`、parent Session、Reviewer Session、generation、可选 DSH call id／reason、`actionHash`、issued／deadline 和完整 ActionSnapshot。

Request parser 必须重新计算 action hash。Controller `deliver()` 返回的 `MessageId` 只表示 inbox acceptance，不能当作审批结果。

## 9. ApprovalDecision

Reviewer 只能通过 provider setup 安装的 scoped decision tool 提交 protocol version、request／parent／Reviewer／generation identity、`actionHash`、`allow | deny | human_review`、risk、categories、user authorization 和 rationale。

结果工具每次 Activation materialize 时安装一次；每次审批只在 broker 中 arm 新 request。工具不得直接执行审批副作用。Broker 还必须接收实际调用工具的 child Session id，不能相信模型 payload 自报身份。

## 10. Result broker

Pending entry 在 deliver 前创建。首个结果只有在 `reviewId`、parent、payload Reviewer、实际 tool child、generation、`actionHash` 和 deadline 全部匹配时才生效。

- 完全有效：兑现一次并写 accepted tombstone；
- duplicate：不重复兑现；
- timeout／abort／delivery failure 后到达：late；
- unknown id：不影响其他 pending；
- routable invalid schema：关闭对应 pending 为 invalid-result；
- 任一身份不匹配：关闭对应 pending 为 identity-mismatch；
- 无法路由的非法 payload：不猜测要关闭哪个请求。

所有终态不可逆。tombstone 当前有容量上限；TTL 和持久审计在后续里程碑补齐。

## 11. 串行与并发

同一 parent Session 的串行锁覆盖：

```text
ensure Reviewer
→ arm broker
→ deliver
→ wait decision／timeout／abort
→ fail-closed mapping
→ cleanup
```

同一个 Reviewer 首期不并发处理两个审批。不同 parent 使用不同 lane，可以并行。队列完全属于本插件策略。

## 12. 审批映射

唯一自动放行路径是：完整动作已捕获、请求正确投递、首个结果 schema 有效、全部 identity／hash／generation／deadline 匹配，并且 decision 为 `allow`。人工 fallback 只恢复普通能力不足，不能绕过身份、完整性或协议不变量。

| 情况 | `auto` | `auto-then-user` |
|---|---|---|
| Guardian 明确 `allow` | `allowed-once` | `allowed-once` |
| Guardian 明确 `deny` | `rejected` | `rejected` |
| Guardian 明确 `human_review` | `rejected` | `HumanApprovalPort.answer(request)` |
| 不支持的工具、无法形成完整语义快照、卷宗预算溢出 | `unavailable` | `HumanApprovalPort.answer(request)` |
| Reviewer model／provider／transport 暂时故障或有限尝试耗尽 | `unavailable` | `HumanApprovalPort.answer(request)` |
| Reviewer deadline 到期且父请求仍活跃 | `unavailable` | `HumanApprovalPort.answer(request)` |
| 插件正常卸载且父请求仍活跃 | `unavailable` | `HumanApprovalPort.answer(request)` |
| 用户 Stop／Abort | `cancelled` | `cancelled` |
| Session／Reviewer 身份矛盾、`actionHash`／generation 不匹配、sidecar／approval snapshot 冲突 | `unavailable` | `unavailable` |
| 非法、伪造、迟到或无法安全关联的 Reviewer 结果 | `unavailable` | `unavailable` |

`HumanApprovalPort.answer(request)` 接收 DSH 借出的**同一次尚未执行的工具调用请求对象**，不是创建新的授权或在执行后补票。terminal composer 调用人工 port 前必须再次确认 request signal 未 aborted；人工 port 缺失、抛错或返回非法值统一为 `unavailable`。不得使用普通 sibling `next()` 顺序模拟该组合。

技术边界是：能力不足可以人工恢复；身份、完整性和协议矛盾必须硬停止；任何 fallback 都不能生成隐式 allow。

### 12.1 Review attempts

一次业务 review run 共享同一个宿主 `reviewRunId`、不可变 dossier／`actionHash` 和总 deadline，首期最多两个 Reviewer attempts；每个 attempt 使用唯一协议 `reviewId` 并绑定实际 Reviewer Session，防止迟到结果跨 attempt 被接受。只允许重试明确分类的瞬时 transport／provider 错误、未调用结果工具、可修复的结构化输出错误，或干净 Reviewer 的一次非语义故障。

明确 `deny`、明确 `human_review`、身份／hash／generation 不匹配、sidecar 完整性冲突、策略版本错误、deadline 到期和用户 Abort 均不得重试。污染 child 的 rotate + fresh-child 恢复属于基础设施恢复，必须与业务 attempt 分开计数和审计，但同样不能延长总 deadline；它只能改变实际 Reviewer Session id，不能改变该 run 的 generation、configuration／route、policy 或 dossier。

原则是只重试传输和表达失败，不重试已经形成的安全判断。

### 12.2 事实、案例与指标

DSH Session log 继续保存 `approval/asked`、`approval/decided`、`tool/call`、`tool/result` 与 turn 生命周期。插件的 action projection、approval snapshot、safe receipt 和自动 allow 所依据的最小决策记录属于安全关键事实，必须使用 Storage Domain 强持久化；缺失时自动审批失败关闭。

每次 review 默认保存不含完整 packet／rationale 正文的最小决策记录。完整 Guardian 案例采用显式 opt-in：`caseCapture.mode: full` 才保存实际投递的 canonical packet、exact fingerprint-bound policy artifact 和有界结构化结果，并受 deterministic 数量／字节 quota、TTL、parent deletion、host-private 访问和显式脱敏导出规则约束。完整 artifact 与最小记录不建立强事务指针，异步捕获失败不改变既有 allow／deny／fallback；运行指标写入失败也不得阻止工具执行或人工审批。详细接口见 [Guardian 案件卷宗规范](guardian-dossier.md#134-决策记录与可选完整案例)。

这一区分体现：决策事实强一致、失败关闭；完整调试案例受控留存；产品 telemetry 尽力写入且不得干扰 DSH 主执行链。

## 13. Reviewer composition

当前 provider `materialize()` 在受管 child setup 中安装：

- 独立 provider／model／reasoning effort；
- complete Reviewer system prompt；
- runtime-context suppression；
- inherited tool restriction `allow: []`；
- 唯一 scoped decision tool；
- approval policy `never`；
- sandbox mode `read-only`。

不得继承 Parent transcript；所需事实由 approval hook 按 [Guardian 案件卷宗接口与编译规范](guardian-dossier.md) 从父 Session log 与 Storage Domain sidecar 编译成版本化 deliver payload。卷宗采用 principal／delegation-envelope 模型：v1 只接受无父 Session 且 header／runtime effective delegation depth 为 0 的主／根 Agent requester，owned 子代理及后代只延伸主 Agent 的事务意图，不创造授权；enabled tools 必须闭集分类。Reviewer 只接收主 Agent 轨迹、精确委托和 content-free safe receipts，不遍历 child Session，也不接收 direct child-origin report、closing output 或工具结果正文。Provider setup 不得保留 unpublished child Agent，也不得调用 send／followup／steer／inject 绕过 Controller。

## 14. 可实现安全边界

当前 DSH 公共 API 不能为同进程插件提供 OS 沙箱，也不能普遍禁止所有 global hooks 或 provider 网络访问。首期可以可靠限制模型可见工具、prompt、runtime context、sandbox 和 approval policy，但不得描述成绝对的 no-plugin／no-hook／no-network 隔离。

Managed capability 防止普通产品通道和其他 provider 操作 child；它不防恶意同进程代码。

## 15. 独立实现与外部参照边界

后续 Reviewer 产品能力由本项目基于 DSH 的消息来源、Session 历史、工具协议和威胁模型独立设计。当前卷宗以 DSH Session log 为规范事实来源，不由宿主预判消息授权语义。Codex Guardian 只作为外部能力清单参照，用于提醒用户授权、精确动作、有界上下文、固定 deadline、有限重试和拒绝熔断等通用问题；它不定义本项目的类型、算法、默认参数或策略文本。

本项目不得复制、翻译或近似改写 Codex 的代码、policy／prompt、schema、测试、snapshot、注释或文档表达，也不得用外部项目的 prompt snapshot 作为本项目 golden test。所有实现从空白文本和本项目规格出发，使用 MIT 许可证。完整组成部分和实施顺序见 [Approval Reviewer 独立实现路线](reviewer-roadmap.md)。

## 16. 验收标准

当前协议核心必须证明：

1. providerData 严格解析并验证 fingerprint。
2. ActionSnapshot lossless snapshot、冻结和稳定 hash。
3. Request parser 复算 hash。
4. Decision 严格 schema、闭集 enum 和字段上限。
5. Broker 只接受一次完整身份匹配结果。
6. invalid、mismatch、timeout、abort、duplicate、late、unknown 全部失败关闭。
7. 同 parent 串行、不同 parent 并行。
8. Reviewer 懒创建、兼容 child 复用、新 generation 创建替代 child。
9. approval answerer 原样传递 exact live parent。
10. profile 只组合一个 state-aware terminal approval composer；`auto`／`auto-then-user` 不依赖 sibling 顺序、不产生隐式 allow，显式人工 port 不越过身份／完整性冲突。
11. pending approval 不跨 unload／reload 恢复，Stop／Abort 始终 cancelled。
12. 最多两个业务 attempts 共享同一 dossier／actionHash／deadline，安全判断不重试。
13. 自动 allow 在最小决策记录 durable 前不生效；完整案例捕获默认关闭且失败不改变裁决。
14. Reviewer route 显式固定，不继承主 Agent，也不静默切换。
15. typecheck、单元测试和 build 全部通过。

真实集成里程碑还需证明 provider registration／effect disposal、动作 capture hooks、Reviewer materialize setup、scoped decision tool、approval listener、persistence／cold-resume／HMR、provider unavailable、两级案例留存和只读 Web 路径。

## 17. 明确禁止

本插件不得：

- 用 continuable followup 模拟 Managed Agent；
- 按 child id 猜测或重获 Controller；
- 保存 unpublished child Agent 作为旁路；
- 把 Controller 或 providerData 暴露到模型、wire 或 Web；
- 把 MessageId、Agent idle 或自由文本当作业务结果；
- 在 route 失效时静默切换模型；
- 跨 unload／reload 恢复旧 pending approval 或接受旧 result channel 的迟到结果；
- 在缺失、非法或不确定结果时自动放行；
- 默认保存完整 Guardian packet，或把完整案例自动写入 telemetry、Session export、Git／测试 fixture；
- 复制、翻译或近似改写 Codex Guardian 的代码、提示词、测试、snapshot 或文档表达。
