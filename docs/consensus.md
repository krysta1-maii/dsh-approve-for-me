# Approve for Me 最终设计共识

> 状态：2026-08-24 建立业务边界；2026-08-25 部署机制改为 stock DSH 上的 Guarded Continuable，并确定 Reviewer 后续采用独立 MIT 实现。审批协议、身份／哈希校验、失败关闭、最小权限和每父 Reviewer 等产品边界继续有效；早期“官方第三 mode”与 patched API 描述均由 [`dsh-managed-agent` 无补丁改造计划](../../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)取代。

## 1. 项目定位

`dsh-approve-for-me` 是面向 DSH 的受管自动审批 provider 插件，也是 `dsh-managed-agent` 的首个适配应用。历史工作名 `dsh-approval-for-me` 已废弃。

项目不是绕过审批，而是向 DSH 的 approval answerer waterfall 增加一个隔离、可审计的自动 Reviewer。只有通过完整 schema、身份、哈希、代际和 deadline 校验的确定性 `allow` 才能映射为单次 `allowed-once`。

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

### Human answerer

人工 answerer 是 approval waterfall 中的下游 handler。`auto-then-user` 通过 `next()` 转交，而不是让 Reviewer 自己聊天式询问用户。

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

## 5. providerData

providerData 是 Runtime 不解释的 lossless JSON。首期包含 schema version、`primary` role、应用 generation、可复算 configuration fingerprint、provider／model／effort route、policy version 和 toolset version。

它不得包含凭据、函数、工具对象、Agent、Session、Controller 或业务请求。每次 materialize 都必须严格运行时解析；未知版本、额外字段、非法 route 或错误 fingerprint 明确失败。

## 6. 动作捕获

DSH `approval/request` 只有 Agent、tool name、可选 call id／reason／signal，不包含工具参数。自动 Reviewer 不能只依据 tool name 决策。

本插件将在 `tools/pre-execute` 中以 exact Agent + call id 捕获完整、frozen 的 `ToolExecution.arguments`，并在 `tools/result` 后释放。只有 call id、exact Agent 和 tool name 全部匹配时才自动评审。

缺失或不匹配时：`auto` 返回 unavailable；`auto-then-user` 调用 `next()`。

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

唯一自动放行路径是：完整动作已捕获、请求正确投递、首个结果 schema 有效、全部 identity／hash／generation／deadline 匹配，并且 decision 为 `allow`。

- valid allow → `allowed-once`；
- valid deny → `rejected`；
- valid human_review + `auto-then-user` → `next()`；
- valid human_review + `auto` → `rejected`；
- request abort → `cancelled`；
- timeout、模型／transport、managed error、invalid、mismatch、missing snapshot → `unavailable` 或人工 fallback，绝不 allow。

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
10. `auto`／`auto-then-user` 不产生隐式 allow。
11. typecheck、单元测试和 build 全部通过。

真实集成里程碑还需证明 provider registration／effect disposal、动作 capture hooks、Reviewer materialize setup、scoped decision tool、approval listener、persistence／cold-resume／HMR、provider unavailable 和只读 Web 路径。

## 17. 明确禁止

本插件不得：

- 用 continuable followup 模拟 Managed Agent；
- 按 child id 猜测或重获 Controller；
- 保存 unpublished child Agent 作为旁路；
- 把 Controller 或 providerData 暴露到模型、wire 或 Web；
- 把 MessageId、Agent idle 或自由文本当作业务结果；
- 在 route 失效时静默切换模型；
- 在缺失、非法或不确定结果时自动放行；
- 复制、翻译或近似改写 Codex Guardian 的代码、提示词、测试、snapshot 或文档表达。
