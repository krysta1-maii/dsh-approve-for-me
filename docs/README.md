# 文档地图与维护规则

> 状态：2026-08-28。本文定义仓库文档的职责、权威顺序和维护纪律。

## 阅读入口

| 目的 | 文档 | 状态 |
|---|---|---|
| 快速了解项目 | [根 README](../README.md) | 概览，不定义新契约 |
| 查看稳定设计决策 | [设计共识](consensus.md) | v1 决策摘要 |
| 实现宿主、审批组合与生命周期 | [宿主接口与生命周期契约](host-contract.md) | v1 候选权威契约 |
| 实现 Guardian 卷宗与事实边界 | [Guardian 案件卷宗接口与编译规范](guardian-dossier.md) | v1 候选权威契约 |
| 查看当前代码已经做到什么 | [实现状态](implementation.md) | 当前事实 |
| 决定下一步施工顺序 | [施工计划](construction-plan.md) | 当前执行计划 |
| 验收真实 DSH/Profile/Web 行为 | [集成验证清单](integration.md) | 目标验收清单 |
| 建设完整 Reviewer 产品能力 | [Reviewer 独立实现路线](reviewer-roadmap.md) | 产品能力路线 |
| 查阅已废弃方案 | [历史归档](archive/README.md) | 非规范材料 |

## 权威顺序

同一主题出现差异时按下列规则处理：

1. 宿主组合、审批映射、生命周期、持久化与卸载以 `host-contract.md` 为准；
2. 卷宗结构、事实来源、sidecar、完整性与案例 schema 以 `guardian-dossier.md` 为准；
3. 当前代码状态以 `implementation.md` 和仓库代码／测试为准；
4. 施工顺序以 `construction-plan.md` 为准；
5. `consensus.md` 只摘要已经确认的决策，不复制完整接口；
6. 根 README 只提供入口和用户可见状态；
7. `archive/` 中的内容没有规范效力，不得作为当前实现依据。

如果两个权威契约交叉，宿主负责“何时、由谁、以什么结果结束审批”，卷宗负责“Guardian 收到哪些经验证事实”。二者之间只能通过明确版本化接口连接。

## 当前部署边界

v1 的目标部署不修改官方 `@deepseek-ai/dsh-*` 插件族，而是把以下组件作为一个整体交付并锁定兼容版本：

```text
stock DSH packages
+ dsh-managed-agent Host/Client bundle
+ dsh-approve-for-me Guardian policy bundle
+ companion Host Profile
+ profile-owned thin approval-composer adapter
```

这里的 **Host Profile** 指 Host-plane Cordis 插件图和进程稳定的生命周期装配。**Agent Preset** 是 agent-scoped Cordis composition，虽然可包含特权插件，但不能拥有或向 Host consumers 发布本项目要求的 exclusive 全局 `approval/request` 拓扑与人工桥，因此不能替代 Host Profile。

配套 Profile 固定 DSH 兼容版本、Host listener 图、Agent Preset catalog 和唯一自动 policy slot；可变 preset roots 必须禁用，全部启用 preset 都不得注册 `approval/request` listener；Profile-owned mutation gate 在变更公开前拒绝非法注册，并使运行期 attestation 可同步失效。薄 adapter 在该受控拓扑内把 stock Web 人工 listener 的 request-scoped continuation 包装成 `HumanApprovalPort`；核心插件本身不得依赖任意 profile 的 sibling 加载顺序。任意第三方 profile 在未经同等约束与真实验收前不属于 v1 支持范围。

## 维护纪律

- 新的稳定决策先进入对应权威契约，再在 `consensus.md` 摘要；
- 不在多个文档复制完整 TypeScript interface 或映射表，其他文档使用链接；
- 每份状态文档必须区分“已实现”“候选契约”“未来优化”；
- 被替代但仍有历史价值的长文移入 `archive/`，不要在现行计划中保留成片废弃方案；
- 文档中的 DSH API 必须对应当前锁定版本，升级版本时重新核验；
- 语义等价熔断、跨工具绕过识别、full/delta transport 等非 v1 项必须明确标为未来可选优化；
- 文档改动至少运行 `git diff --check`、Markdown 链接检查和代码块检查；涉及接口时同时运行 `npm run check`。
