# dsh-approve-for-me

面向 DeepSeek Harness（DSH）的受管自动审批插件：在工具副作用发生前，由隔离的 Guardian Reviewer 裁决；确定性信任包络内的常规动作直接放行，长程任务尽量无人值守。

> 当前代码状态（2026-08-28）：宿主方案已切换到 **机器决策槽 v2**——本仓库交付“插件本体 + 官方 `dsh-user-approval` 的最小 patch”，`dsh-managed-agent` 保持独立仓库作为依赖插件。patch 已在本仓库成形（overlay + 构建/校验脚本），本体的 `approval-gate` 端口骨架、P2 纯逻辑组件与 `DefaultGatePipeline` 已建立；`package.json` 的 DSH 依赖已声明为 0.1.2-alpha.1，并新增了 DSH machine-policy adapter 与 transitional delegating gate（P0/P1 起步）。Guardian 编排、pipeline 与插件组合根串联、持久化记录与真实 0.1.2 Web 验收尚未完成。当前测试 121 项仍基于本机 0.1.1-rc.2 安装基线；0.1.2 fork 的实机构建/挂载验收待完成。

## 项目目标

`dsh-approve-for-me` 为每个主 Session 管理一个持久的 Approval Reviewer child。Reviewer 使用独立 Session 和受控模型配置，接收有界、不可变的动作快照，并通过插件自有的结构化结果工具返回审批决定。

v2 的裁决入口是 patched `dsh-user-approval` 提供的 **`registerMachinePolicy()`**：机器决策在 `never` 之后、`approval/request` waterfall 之前执行，拥有确定性优先级；人工兜底通过官方 `api-remotes → client/ui-approval` 瀑布链完成。

## 部署形态（v2）

```text
stock DSH 0.1.2-alpha.1（不改动）
+ dsh-user-approval fork tarball（本仓库 patch/ 产出，替换官方同名包）
+ dsh-managed-agent（独立仓库，Host/Client bundle，依赖插件）
+ dsh-approve-for-me（本仓库，插件本体）
```

- 官方包只 patch 一个：`@deepseek-ai/dsh-user-approval`；
- fork tarball 保留上游 `name`/`version`（DSH 按模块名解析，不能改名），用 `dshApprovalPatch` 标记字段和重命名 tarball 表达第三方身份；
- 不再需要 companion Host Profile、thin composer adapter、mutation gate 或 topology attestation。

## 裁决管线（目标形态）

```text
模型 tool call
→ tools/pre-execute 动作快照 + 工具审批行为分类（ordinary/gate-ask/body-escalation）
→ ctx.approval.request()
→ ApprovalService.decide()          // patched 官方包
   ├─ never? → rejected
   └─ registerMachinePolicy.decide() // 本体插件，确定性优先
        ├─ 身份/requestId/callId/分类校验（失败关闭）
        ├─ trustEnvelope 快路径 → allowed-once
        ├─ deny breaker / allow-cache → rejected / allowed-once
        └─ Guardian 裁决（经 dsh-managed-agent 的受管 child）
             allow → allowed-once；deny → rejected
             human_review → auto: rejected；auto-then-user: 'delegate'
→ 'delegate' → 官方 waterfall → Web 人工审批
```

## 仓库结构

```text
src/
├── index.ts / plugin.ts / config.ts        # 公共导出、组合根、配置
├── domain/                                 # 协议、JSON、hash
├── application/                            # channel、directory、lanes、coordinator
├── ports/                                  # managed reviewer / action projector 端口
├── reviewer/                               # Guardian composition 与决策工具
├── dsh/                                    # DSH 适配层
└── approval-gate/                          # v2 裁决执行器端口（本阶段新增）
    ├── catalog.ts                          # 工具审批行为闭集分类
    ├── trust-envelope.ts                   # 确定性信任包络
    ├── breaker.ts                          # 精确拒绝熔断 / allow-cache
    ├── sealed-decision.ts                  # 前置裁决密封与重放身份
    └── machine-policy.ts                   # DSH-neutral 机器决策端口

patch/
└── dsh-user-approval/
    ├── upstream.json                       # 锁定上游 tag/commit 与 patch 版本
    ├── overlay/src/{index,types,invariant}.ts
    ├── overlay/tests/approval-machine-policy.spec.ts
    └── scripts/{build-fork.sh,mark-package.mjs,verify-fork.mjs}
```

## 构建与安装

```bash
# 本仓库自检（0.1.1-rc.2 基线）
npm run check

# 构建官方包 fork（要求 sibling deepseek-harness 位于锁定 commit）
patch/dsh-user-approval/scripts/build-fork.sh
# → .build/dsh-user-approval-afm-0.1.2-alpha.1.tgz

# 校验 fork tarball
node patch/dsh-user-approval/scripts/verify-fork.mjs \
  .build/dsh-user-approval-afm-0.1.2-alpha.1.tgz \
  patch/dsh-user-approval/upstream.json
```

目标安装顺序（真实 0.1.2 Profile）：

```bash
# 1) fork 覆盖官方审批包（由安装器执行）
# 2) 依赖插件
dsh plugin --profile <profile> add /path/to/dsh-managed-agent
# 3) 本体插件
dsh plugin --profile <profile> add /path/to/dsh-approve-for-me
```

在 patch 被上游合并并通过真实 Web 验收前，本插件不视为产品级配置。

## 文档

从 [文档地图与维护规则](docs/README.md) 开始：

- [宿主接口与生命周期契约](docs/host-contract.md)（机器决策槽 v2）
- [施工蓝图](docs/construction-spec.md)（模块抽象与接口定义）
- [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)
- [当前施工计划](docs/construction-plan.md)
- [设计共识](docs/consensus.md)
- [集成验证清单](docs/integration.md)
- [实现状态](docs/implementation.md)

## 许可证与外部参照

本项目原创代码与文档使用 MIT License。官方包 patch 仅修改 `dsh-user-approval`，保留其 MIT LICENSE 与版权声明；`dshApprovalPatch` 标记明确其为第三方修改版本。Codex Guardian 仅作为能力覆盖参照，不复制或翻译其代码、提示词、测试与文档表达。
