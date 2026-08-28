# Approve for Me 设计共识

> 状态：2026-08-28。本文只保留稳定决策摘要，不定义接口、映射、算法或验收步骤。发生差异时遵循 [文档地图](README.md) 的权威顺序。

## 1. 项目定位

`dsh-approve-for-me` 是 DSH 工具副作用发生前的受管自动审批插件，也是 companion `dsh-managed-agent` 的首个业务应用。历史工作名 `dsh-approval-for-me` 已废弃。

插件通过 patched `dsh-user-approval` 的 `registerMachinePolicy()` 机器决策槽提供隔离、可审计的 Guardian policy；它不是后台绕过器或事后审计器。自动放行只可能来自完整通过 schema、身份、动作和事实校验的确定性结果。具体行为由[宿主契约](host-contract.md)定义。

## 2. 基础设施与 authority

`dsh-managed-agent` 在 stock DSH `continuable` child 上提供其自有的 `ctx.managedAgents` 服务与 registration-scoped Controller。基础层拥有 child 的受控创建、恢复、投递、输入守卫、污染与轮换；本仓库拥有审批协议、Reviewer 业务身份、结果关联、策略和记录。两层不得复制私有状态或绕过 Controller。

DSH `approval/request` 中的 exact live `req.agent` 是当前控制 authority。裸 `sessionId` 只可用于归属、发现与串行，不能重新授予控制权。Reviewer 的产品语义是 Managed Reviewer，底层 wire mode 仍是官方 `continuable`，不是 DSH 新 mode。

## 3. 部署与审批组合

v2 只 patch 官方 `@deepseek-ai/dsh-user-approval`（新增 `requestId` 与 `registerMachinePolicy()` 机器决策槽），由锁定版本的 stock DSH、fork tarball、独立仓库的 `dsh-managed-agent` 与本插件共同交付；完整边界见[文档地图的部署说明](README.md#当前部署边界)。

机器决策在 `never` 之后、`approval/request` waterfall 之前执行，拥有与 listener 注册顺序无关的确定性优先级；本体插件返回 `'delegate'` 时，请求继续走官方 `api-remotes → client/ui-approval` 人工瀑布。普通 sibling listener 顺序仍不是策略优先级机制，但自动裁决路径已不依赖它。已废弃的 companion Host Profile、mutation gate 与 topology attestation 方案仅见[历史归档](archive/README.md)。

## 4. Guardian 事实边界

父 DSH Session log 是主体轨迹的规范来源，官方 Storage Domain sidecar 只补充日志缺少的最小执行事实。编译器必须冻结并交叉校验 source prefix；缺失、漂移、歧义或冲突均失败关闭。

v1 采用 root-principal／delegation-envelope 归因。子代理可以延伸主 Agent 的事务意图，但不能创造或扩大用户授权；direct child-origin 输出不作为授权事实。source-backed compiler 先产生 verified dossier，之后才按实际 Reviewer 与每个 attempt 的身份封装 packet。全部结构、算法和保留规则以[卷宗规范](guardian-dossier.md)为准。

## 5. 安全与恢复原则

Reviewer route、generation、policy 和 toolset 必须显式固定，不能继承主 Agent 或静默切换。只有 `ready` 状态接受自动 review；身份、哈希、generation 与 source 完整性冲突永不进入人工可放行路径。pending approval 不跨 unload／reload 恢复，Stop／Abort 始终取消当前请求。

默认只保存字段白名单内的最小决策记录；完整案例必须显式 opt-in。自动 allow 依赖的记录必须先 durable，telemetry 与案例捕获失败不能绕过该门槛。记录不复制人工结果，也不冒充最终 DSH outcome。

DSH 同进程插件边界不是 OS 安全边界。v1 限制 Reviewer 的工具、prompt、runtime context、sandbox 与 approval policy，但不宣称绝对 no-plugin、no-hook 或 no-network 隔离。

## 6. 独立实现与状态入口

Reviewer policy、卷宗算法、schema、测试和文档均从 DSH 的需求与威胁模型独立设计并采用 MIT 许可证。Codex Guardian 只用于能力覆盖比较，不复制、翻译或近似改写其实现与表达。

当前事实见[实现状态](implementation.md)，施工顺序见[施工计划](construction-plan.md)，真实环境完成条件见[集成验证清单](integration.md)，Reviewer 产品里程碑见[独立实现路线](reviewer-roadmap.md)。宿主运行正确与 Reviewer 语义成熟是两个独立门槛。

## 7. 已废弃方向

官方第三审批 mode、普通 sibling-listener priority、companion Host Profile／thin composer adapter／mutation gate／topology attestation、私有 Session JSON／未知 event、默认保存完整 packet，以及跨 reload 恢复旧 pending approval 均不属于现行方案；历史材料仅见 [`archive/`](archive/README.md)。官方包的最小 patch 是现行方案的一部分，其范围只限 `dsh-user-approval` 的 `requestId` 与 `registerMachinePolicy()`。
