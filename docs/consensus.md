# Approve for Me 设计共识

> 状态：2026-08-28。本文只保留稳定决策摘要，不定义接口、映射、算法或验收步骤。发生差异时遵循 [文档地图](README.md) 的权威顺序。

## 1. 项目定位

`dsh-approve-for-me` 是 DSH 工具副作用发生前的受管自动审批插件，也是 companion `dsh-managed-agent` 的首个业务应用。历史工作名 `dsh-approval-for-me` 已废弃。

插件向 Host Profile 的 terminal approval composer 提供隔离、可审计的 Guardian policy；它不是后台绕过器或事后审计器。自动放行只可能来自完整通过 schema、身份、动作和事实校验的确定性结果。具体行为由[宿主契约](host-contract.md)定义。

## 2. 基础设施与 authority

`dsh-managed-agent` 在 stock DSH `continuable` child 上提供其自有的 `ctx.managedAgents` 服务与 registration-scoped Controller。基础层拥有 child 的受控创建、恢复、投递、输入守卫、污染与轮换；本仓库拥有审批协议、Reviewer 业务身份、结果关联、策略和记录。两层不得复制私有状态或绕过 Controller。

DSH `approval/request` 中的 exact live `req.agent` 是当前控制 authority。裸 `sessionId` 只可用于归属、发现与串行，不能重新授予控制权。Reviewer 的产品语义是 Managed Reviewer，底层 wire mode 仍是官方 `continuable`，不是 DSH 新 mode。

## 3. 部署与审批组合

v1 保持官方 `@deepseek-ai/dsh-*` 包不变，由锁定版本的 stock DSH、companion managed-agent、本插件、companion Host Profile 和 profile-owned thin composer adapter 共同交付；完整边界见[文档地图的部署说明](README.md#当前部署边界)。

Host Profile 拥有 Host-plane、进程稳定的 exclusive 审批拓扑。Agent Preset 虽是可包含特权插件的 agent-scoped Cordis composition，却不能拥有该全局拓扑或向 Host consumers 发布所需人工桥，因此不能替代 Host Profile。

普通 sibling listener 顺序不是 policy priority。Profile 只提供一个自动 policy slot，并锁定 Agent Preset catalog、禁用可变 preset roots；Profile-owned mutation gate 在 listener 变更公开前拒绝非法注册，并通过可撤销 registration 通知拓扑失效，保证 preset composition 不插入审批链；人工恢复由 adapter 在每次 dispatch 内从当前 continuation 构造并消费 request-scoped port，核心 policy 不接触 `next()`。DSH 的权威结果来自父 Session 匹配的 `approval/decided`，不是 composer 的返回提议。接口、映射和生命周期均以[宿主契约](host-contract.md)为准。

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

官方第三审批 mode、patched DSH API、普通 sibling-listener priority、私有 Session JSON／未知 event、默认保存完整 packet，以及跨 reload 恢复旧 pending approval 均不属于现行方案；历史材料仅见 [`archive/`](archive/README.md)。
