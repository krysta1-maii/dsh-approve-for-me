# 文档地图与维护规则

> 状态：2026-08-31。本文定义仓库文档的职责、权威顺序和维护纪律。

## 阅读入口

| 目的 | 文档 | 状态 |
|---|---|---|
| 快速了解项目 | [根 README](../README.md) | 概览，不定义新契约 |
| 查看稳定设计决策 | [设计共识](consensus.md) | v1 决策摘要 |
| 实现宿主、审批组合与生命周期 | [宿主接口与生命周期契约](host-contract.md) | v2 候选权威契约（机器决策槽） |
| 按模块施工（抽象与接口蓝图） | [施工蓝图](construction-spec.md) | v2 实施蓝图 |
| 实现 Guardian 卷宗与事实边界 | [Guardian 案件卷宗接口与编译规范](guardian-dossier.md) | v1 候选权威契约 |
| 查看当前代码已经做到什么 | [实现状态](implementation.md) | 当前事实 |
| 查看阶段性功能与业务审查 | [2026-08-29 GPT 审查报告](reviews/2026-08-29-functional-business-review-gpt.md) | 非规范、按提交冻结的审查快照 |
| 决定下一步施工顺序 | [施工计划](construction-plan.md) | 当前执行计划 |
| 验收真实 DSH/Profile/Web 行为 | [集成验证清单](integration.md) | 目标验收清单 |
| 建设完整 Reviewer 产品能力 | [Reviewer 独立实现路线](reviewer-roadmap.md) | 产品能力路线 |
| 查阅已废弃方案 | [历史归档](archive/README.md) | 非规范材料 |

## 权威顺序

同一主题出现差异时按下列规则处理：

1. 宿主组合、审批映射、生命周期、持久化与卸载以 `host-contract.md` 为准；
2. 模块切分、抽象与接口实现蓝图以 `construction-spec.md` 为准；与权威契约冲突时以 `host-contract.md`／`guardian-dossier.md` 为准；
3. 卷宗结构、事实来源、sidecar、完整性与案例 schema 以 `guardian-dossier.md` 为准；
4. 当前代码状态以 `implementation.md` 和仓库代码／测试为准；
5. 施工顺序以 `construction-plan.md` 为准；
6. `consensus.md` 只摘要已经确认的决策，不复制完整接口；
7. 根 README 只提供入口和用户可见状态；
8. `archive/` 中的内容没有规范效力，不得作为当前实现依据。

如果两个权威契约交叉，宿主负责“何时、由谁、以什么结果结束审批”，卷宗负责“Guardian 收到哪些经验证事实”。二者之间只能通过明确版本化接口连接。

## 当前部署边界

v2 的目标部署只 patch 一个官方包，并把以下组件作为一个整体交付并锁定兼容版本：

```text
stock DSH 0.1.2-alpha.2（不修改）
+ dsh-user-approval fork tarball（本仓库 patch/ 产出，替换官方同名包）
+ dsh-managed-agent（独立仓库，Host/Client bundle，依赖插件）
+ dsh-approve-for-me（本仓库，插件本体）
```

宿主闭包不再由本地源码 tarball 拼装：仓库以普通 npm 依赖固定 `0.1.2-alpha.2`（npm dist-tag `alpha`），复现锚点是 `pnpm-lock.yaml` 的 integrity 摘要；只有 approval fork 仍从锁定 commit（`dsh-v0.1.2-alpha.2` / `0a53fb55bea101816fa226bb964ae2bed71c343b`）的宿主源码构建，并由 workspace overrides 覆盖同名官方包。

官方 patch 只向 `dsh-user-approval` 增加 `ApprovalRequestEvent.requestId` 与 `ApprovalService.registerMachinePolicy()`：机器决策在 `never` 之后、`approval/request` waterfall 之前执行，拥有与 listener 顺序无关的确定性优先级。`'delegate'` 继续进入官方 `api-remotes → client/ui-approval` 人工瀑布。未注册机器策略时行为与上游一致。

fork tarball 保留上游 `name`/`version`（DSH 按模块名解析该包及其 `/types` 子路径），第三方身份由 `dshApprovalPatch` 标记、重命名 tarball 与安装器校验表达。已废弃的 companion Host Profile、thin composer adapter、mutation gate 与 topology attestation 方案见 [历史归档](archive/README.md) 与旧版契约。

## 维护纪律

- 新的稳定决策先进入对应权威契约，再在 `consensus.md` 摘要；
- 不在多个文档复制完整 TypeScript interface 或映射表，其他文档使用链接；
- 每份状态文档必须区分“已实现”“候选契约”“未来优化”；
- 被替代但仍有历史价值的长文移入 `archive/`，不要在现行计划中保留成片废弃方案；
- 文档中的 DSH API 必须对应当前锁定版本，升级版本时重新核验；
- 语义等价熔断、跨工具绕过识别、full/delta transport 等非 v1 项必须明确标为未来可选优化；
- 文档改动至少运行 `git diff --check`、Markdown 链接检查和代码块检查；涉及接口时同时运行 `npm run check`。
