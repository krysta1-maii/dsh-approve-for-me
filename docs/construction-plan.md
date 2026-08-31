# dsh-approve-for-me 当前施工计划

> 状态：2026-08-31，宿主方案 v2（机器决策槽），目标宿主 0.1.2-alpha.2（commit 0a53fb55bea101816fa226bb964ae2bed71c343b）。本文从"插件本体 + 官方 patch"的仓库形态出发安排后续实现；不再保留 companion Host Profile／thin composer adapter 方案。旧计划与旧宿主契约已归档/被替代，文档职责和权威顺序见 [文档地图](README.md)。

## 1. 施工目标

将当前"协议与运行骨架"建设为可在 patched dsh-user-approval + stock DSH 0.1.2-alpha.2 中验收的自动审批产品，近期目标是**能在真实 dsh 测试用例上运行的 demo**：

- 官方只 patch @deepseek-ai/dsh-user-approval：requestId + registerMachinePolicy()；
- 本体插件注册唯一机器决策槽，机器裁决拥有与 listener 顺序无关的确定性优先级；
- trustEnvelope 快路径 + deny breaker/allow-cache 让长程任务尽量无人值守；
- 只有 source-verified 卷宗、合法 Guardian 结果和 durable 决策事实可以产生 allowed-once；
- 身份、hash、generation、事实完整性和协议冲突始终失败关闭；
- dsh-managed-agent 保持独立仓库，作为依赖插件提供 Guarded Continuable reviewer child。

完整语义以 [宿主契约](host-contract.md) 与 [卷宗规范](guardian-dossier.md) 为准，本文不重复接口。

## 2. 当前基线（代码为准）

**已完成的里程碑**（详见 [实现状态](implementation.md) 与 docs/reviews/ 审查快照）：

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 0.1.2-alpha.2 基线迁移（npm 发布闭包 + fork 一次性 clone 构建，两仓库 check 全绿，提交 7837883 / 9990c94） | 完成 |
| P1 | 机器决策槽接入（registerMachinePolicy() 全局独占、never 优先、fail-closed） | 完成 |
| P2 | 裁决管线产品化（breaker/allow-cache/sealed replay/durable 记录） | 完成 |
| D1 | source-backed dossier compiler + Storage Domain sidecar | 完成 |
| H4 | durable 决策事实（afm_decision_records）与最小记录 | 完成 |
| R4/R5 | 风险/授权基线与 v2 decision schema 验证器 | 完成 |
| R7/R9 | exact denial breaker 与审计管线 | 完成 |

**尚未完成**：

- 真实 LLM Guardian 的 allow/deny/human_review 全链（现有 profile smoke 的 Guardian 是脚本化 adapter，只回放 source-derived baseline）；
- auto-then-user 下沉后官方 Web approval panel 可见且可操作；
- pending approval、Reviewer child、storage 状态在"彻底杀掉进程再重启"后的 cold-resume；
- deadline、污染、renew、卸载/重载的真实并发与故障注入；
- R6 完整 review run 审计与 R8 full case capture 的 Storage Domain 后端；
- 长程 soak：包络内 0 人工、0 误放行。

当前代码事实的逐文件清单见 [implementation.md](implementation.md)。

## 3. v2 部署组成

    stock DSH 0.1.2-alpha.2（不修改）
    + dsh-user-approval fork tarball（本仓库 patch/ 产出）
    + dsh-managed-agent（独立仓库，依赖插件）
    + dsh-approve-for-me（本仓库，插件本体）

官方 patch 只有两处新增，未注册机器策略时行为与上游一致；fork tarball 保留原名/版本并用 dshApprovalPatch 标记第三方身份。宿主闭包按已发布的 npm 0.1.2-alpha.2 消费（复现锚点是 pnpm-lock.yaml 的 integrity），只有 approval 包被 workspace overrides 换成本地 fork tarball。构建与校验见 patch/dsh-user-approval/README.md。

## 4. 当前阶段：demo 化施工（G → H → I → J）

> 目标定义：**"能在测试 dsh 用例上实际跑"** = 在真实 stock Profile（已发布的 alpha.2 CLI + 三个部署 tarball）里，用真实 LLM 配置完成一次完整的"模型触发提权 → Guardian 裁决 → 自动放行并真实执行副作用"链路，以及一次"人工在 Web 面板拒绝/允许"链路；所有验证用 disposable DSH_HOME，不触碰正在使用的 DSH 实例。

### G1：真实提权用例端到端验证

- 在 disposable Profile 上以真实 provider/model 配置 reviewer（reviewer.provider / reviewer.model），trustEnvelope.enabled: false，mode: auto-then-user；
- 演示触发源用 stock 沙箱提权（tool-bash 的 sandbox_permissions + justification 重试路径），不用自造钩子：模型首次执行受限命令被 sandbox 拒绝 → 收到 [sandbox: escalation available — retry...] 提示 → 携带 sandbox_permissions（最窄可用更宽模式）+ justification 重试 → ctx.approval.request() → 机器决策槽；
- 检查点 A：approval/decided 出现且为 allowed-once，命令真实执行；afm_decision_records 有 confirmed 行。若为 unavailable，用 DSH_APPROVE_FOR_ME_DEBUG=1 定位是卷宗编译、R4 还是 Guardian 契约哪一环；
- 完成定义：10 次连续提权用例中，模型无契约违规且全部走通；human_review → delegate 与 deny → breaker 各出现一次；
- 此阶段可能需要对 src/reviewer/policy.ts 的 Guardian 提示词做"只拷贝卷宗事实、不得降级风险/省略类别/夸大覆盖"的约束强化，但不得放宽 validateDecisionAssessmentV1。

### H1：人工下沉 Web 链路

- 同一 Profile 启动 dsh web，auto-then-user 模式下让模型触发提权；
- 人工在官方 approval panel 点拒绝/允许，检查 approval/decided 与工具是否实际执行；核对 panel 展示的 requestId/callId/args/justification；
- 检查点 C：人工允许→工具执行；人工拒绝→命令未执行且 approval/decided 为 rejected；页面刷新后仍能看到 pending 状态（跨进程冷恢复的最小形态）；
- 完成定义：允许/拒绝各一次人工点击，ui-approval 面板路径可复现。

### H2：跨进程 cold-resume 与故障注入

- 在提权 ask 挂起时 kill Host 进程再启动：pending approval、reviewer child、durable sidecar 是否全部恢复；
- deadline 后迟到结果无副作用；污染/轮换各注入一次；卸载/重载 dsh-approve-for-me；
- 完成定义：每一项都 fail-closed（无迟到放行、无重复放行、无丢失决策记录）。

### I：可交付 Demo 封装

- 新增 scripts/demo-profile.sh：一次性 DSH_HOME + Profile 安装 + 预置用户消息 + 启动 Web，输出"期望看到的 5 个决策事件序列与人工兜底步骤"；
- 更新 docs/reviews/ 与 docs/implementation.md 的"当前未执行"清单（G1/G2 完成后移除前两条，H1/H2 完成后移除第三条）。

### J：复查缺口修复（在 demo 前至少完成前两项）

- 修 dossier-compiler.ts 的 confinement 恒为 unconfined-composition（trust-envelope 快路径目前不可达），并把 completeness.complete 恒真守卫改为真实判断；
- 补 dossier compiler 的"零 direct-user 消息"测试（该不变量目前只靠 projector frontier 保证）；
- 修复 package.json 的 docs/ 泄漏与 package-smoke 正则；
- 补 DshStorageDomainGateDecisionRecordStore 对幂等重放的注释/测试。

## 5. 依赖关系

    P0─P1─P2─D1─H4 ──→ G1 ──→ H1 ──→ H2 ──→ I（demo 封装）
                        │
                        └──→ J（复查缺口，可与 G1 并行）

P1 与 D1 可以并行；P2 需要可用的机器决策槽与事实源；G1 需要真实 LLM 配置；H1 需要 Web 面板；H2 需要 G1/H1 的 stable 基线。

## 6. 每阶段完成纪律

每个阶段至少需要：

1. 版本化接口与不变量；
2. 对 patched DSH API 的真实类型适配；
3. 正常、失败和对抗性测试；
4. npm run check 与文档代码块／链接检查；
5. 更新 implementation.md 的已实现事实；
6. 若契约变化，先更新对应权威文档，再更新共识摘要；
7. 一次边界清楚的 Git 提交。

## 7. 当前施工入口

当前入口是 **G1：真实提权用例端到端验证**，前置条件是真实 LLM provider 配置与 disposable Profile 安装（profile:artifact-smoke 已验证安装与启动路径）。dsh plugin --profile web add 当前只用于骨架开发，不构成产品级部署。
