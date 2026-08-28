# dsh-approve-for-me

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 的受管自动审批插件。

> 当前代码状态（2026-08-28）：领域协议、应用层、companion `dsh-managed-agent` 的 `ctx.managedAgents` Guarded Continuable 接入和 DSH bundle 包装已实现，当前测试为 82 项。宿主 v1 与卷宗 v1 已形成候选接口；现有审批 listener 仍是待迁移骨架，companion Host Profile、thin composer adapter、卷宗 compiler 和真实 Profile／Web 验收尚未完成。
>
> 当前 Reviewer 状态：审批执行骨架和最小保守 `policy-v1` 已实现；父 Session + sidecar 驱动的五段式实验卷宗已形成接口规范，子代理采用 root-principal／delegation-envelope 归因并排除 direct child-origin output，但 compiler 代码、完整风险／授权策略、有限重试和拒绝熔断尚待逐步实现。项目采用独立 MIT 实现；Codex Guardian 仅作为设计参照，不复制或翻译其代码、提示词、测试与文档表达。

## 项目目标

`dsh-approve-for-me` 为每个主 Session 管理一个持久的 Approval Reviewer child。Reviewer 使用独立 Session 和受控模型配置，接收有界、不可变的动作快照，并通过插件自有的结构化结果工具返回审批决定。

这里的“持久”指 Reviewer Session 和 transcript 可以在 Activation 释放后继续保留，并在后续审批时 cold-resume；不要求 Reviewer Agent 永久在线。

本项目是 [`dsh-managed-agent`](../dsh-managed-agent) 的首个业务应用。目标基础插件不修改官方 mode，而是在官方 continuable child 上提供 `ctx.managedAgents` 与 provider 私有 Controller：

```text
ctx.managedAgents.registerProvider()
└── controller
    ├── create(parent, options)
    ├── list(parentSessionId)
    ├── rotate(parent, childId)
    ├── deliver(parent, childId, content)
    └── interrupt(parent, childId)
```

基础层负责受控创建、发现、投递、恢复、pre-step 输入守卫、generation/污染管理和停止；审批 schema、singleton、串行、deadline、结果关联、污染 child 隔离与失败关闭仍全部由本仓库负责。当前代码已使用 companion `dsh-managed-agent` 服务契约的 `ctx.managedAgents.registerProvider()`，不再调用 patched `ctx.subagents.registerManagedProvider()`。

## 已实现内容

### 真实契约消费

- 直接消费 `@deepseek-ai/dsh-*@0.1.1-rc.2`、`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/schemastery@3.18.1` 和 `dsh-managed-agent@0.1.0-dev.0`（精确版本）。
- companion `dsh-managed-agent` Host 插件在 stock `continuable` 之上提供其自有的 `ctx.managedAgents` 服务，本项目通过 `registerProvider()` 注册 Reviewer，不修改任何官方 DSH 包。
- 全部本地 `Dsh*` facsimile 已删除；`tests/adapters/real-contract.test.ts` 证明 `ManagedAgentProvider`／`ManagedAgentController`／`AgentSetup`／`ToolDefinition`／`approval/request` listener 以真实类型组合，无 `as unknown as` 贯穿 seam。

### 代码分层

```text
src/
├── index.ts                    # 公共导出（已收窄）
├── plugin.ts                   # Cordis composition root（name/inject/apply）
├── config.ts                   # 可序列化 Config（Schemastery）+ normalizeConfig
├── domain/
│   ├── json.ts                 # lossless JSON／freeze／canonical
│   └── protocol.ts             # providerData／ActionSnapshot／Request／Decision／hash
├── application/
│   ├── decision-channel.ts     # 一次性结果关联、deadline、tombstone
│   ├── reviewer-directory.ts   # find-or-create、代际/指纹选择
│   ├── serial-lanes.ts         # per-parent 串行
│   └── review-coordinator.ts   # 一次审批的完整编排
├── ports/
│   ├── managed-reviewer.ts     # 最窄 managed port + ParentAuthority
│   └── action-projector.ts     # ActionProjector / ActionCapture
├── reviewer/
│   ├── policy.ts               # 最小保守 v1 prompt、decision schema、policy registry
│   ├── provider.ts             # 真实 ManagedAgentProvider + AgentSetup/toolFilter
│   └── decision-tool.ts        # 真实 ToolDefinition 的两阶段结果工具
└── dsh/
    ├── managed-controller.ts   # ManagedAgentController → 应用 port
    ├── action-capture.ts       # 真实 ToolExecution 的 capture/release bridge
    └── approval-answerer.ts    # 当前 sibling 骨架；待迁移到 terminal composer policy
```

### Reviewer composition

`materialize()` 每次 startup／cold resume 都走同一个 composition factory：

- 严格解析 `providerData`，从 policy registry 解析版本（未知版本失败关闭）；
- `agentOptions` 固定 provider/model；`toolFilter` 与 setup 都不继承全局工具；
- `installModelSelection()` 同时应用 reasoningEffort；
- `systemPrompt.section({ complete: true })` + `suppressRuntimeContext()`；
- `tools.restrict({ allow: [] })` + 注册唯一 `submit_approval_decision`；
- child 会话 approval policy 固定为 `never`、sandbox 固定为 `read-only`；
- setup 只依赖 `childSessionId` 与 `DecisionSink`，不保留 child Agent。

### 决策工具的两阶段输出

```text
ToolDefinition.execute()         校验真实调用者 → 暂存 candidate → concludeTurn()
        ↓  child-scoped tools/result
成功终态才 authorized submit；失败/身份不符/无调用者 -> 丢弃，不产生副作用
```

### 宿主与恢复状态

当前 `approval-answerer.ts` 仍是 sibling-listener 骨架；Reviewer directory／coordinator 已具备 contaminated child 跳过、rotate 和有界恢复，但完整宿主 policy、Profile composer、draining 与持久决策边界尚未实现。目标模式映射、人工恢复、污染审计和生命周期只由 [宿主契约](docs/host-contract.md) 定义，当前代码事实见 [实现状态](docs/implementation.md)。

## 后续施工

当前代码首先完成了身份、动作快照、结果关联、Managed Reviewer create／reuse／rotate 和失败关闭骨架；`policy-v1` 仍是最小保守占位策略。下一步分两条可并行主线：

1. **宿主主线**：实现 companion Host Profile 与 thin composer adapter，再迁移 policy、draining、attempt、精确熔断和留存端口；
2. **Reviewer 主线**：实现 Session／Storage Domain facts source 与五段式卷宗，再建设工具族动作语义、风险分类、用户授权 assessment 和完整 policy。

当前阶段、依赖关系和退出条件以 [施工计划](docs/construction-plan.md) 为准；宿主接口见 [宿主契约](docs/host-contract.md)，卷宗边界见 [卷宗规范](docs/guardian-dossier.md)，Reviewer 产品能力见 [Reviewer 路线图](docs/reviewer-roadmap.md)。所有内容从 DSH 的需求与威胁模型独立推导；外部项目只用于能力覆盖比较，不作为源码或文本素材。

## 依赖边界

- 领域层（`domain/`）不 import Cordis／DSH 类型。
- 应用层（`application/`、`ports/`）只依赖领域协议与自己的 port。
- `dsh-managed-agent` 只通过 Host 的 `ctx.managedAgents` 服务接入；本仓库对它的使用仍是 type-only import，运行时零引用。

## 部署状态

应用迁移与标准 bundle 包装已完成，但 companion Host Profile 和真实集成验收尚未完成：**在验收通过前，尚不应作为正式产品环境配置**。v1 的目标部署整体由锁定版本的 stock DSH、`dsh-managed-agent` Host/Client bundle、本插件、companion Host Profile 和 profile-owned thin composer adapter 组成。

Host Profile 拥有 Host-plane、进程稳定的 Cordis composition。Agent Preset 虽是可包含特权插件的 agent-scoped composition，却不能拥有本项目要求的 exclusive 全局审批拓扑，因此不能替代 Host Profile。完整组件、不变量和兼容桥边界以 [宿主契约](docs/host-contract.md) 为准，分级完成条件见 [集成验证计划](docs/integration.md)。

## 标准 DSH 插件安装

本仓库已声明 `dsh.bundle.patch`（`cordis.patch.yml`），可把基础 bundle 与审批骨架装入开发 Profile：

```bash
# 先安装基础 Host/Client bundle
dsh plugin --profile web add /path/to/dsh-managed-agent

# 再安装本审批插件
dsh plugin --profile web add /path/to/dsh-approve-for-me
```

这些命令**不会自动生成 companion Host Profile 或 composer adapter**，因此只用于当前骨架开发，不等于产品级 `auto-then-user` 安装。bundle 层只插入 `dsh-approve-for-me` 插件行；Reviewer 配置仍需在 Profile 的 `cordis.patch.yml` 中补上（可参考仓库示例），或使用 `dsh --profile web --dump-config` 调整：

```yaml
- id: dsh-approve-for-me
  config:
    mode: auto
    timeoutMs: 30000
    reviewer:
      generation: primary-v1
      provider: <llm-provider-id>
      model: <llm-model-id>
      policyVersion: policy-v1
      toolsetVersion: 1
```

安装后建议依次执行：

```bash
npm run check                 # 本仓库自检：typecheck + 82 项测试 + build
npm pack --dry-run            # 确认 tarball 包含 lib / cordis.patch.yml / LICENSE / docs
dsh --profile web --dump-config
dsh --profile web
```

Web 上的“Managed Reviewer”只读标识和 Stop 由 `dsh-managed-agent` 的 Client bundle 提供；本插件不需要额外 Client bundle。

## 开发

```bash
npm install
npm run check
```

`npm run check` 依次执行 typecheck、82 项测试和构建。

## 文档

从 [文档地图与维护规则](docs/README.md) 开始。主要入口：

- [设计共识](docs/consensus.md)
- [宿主接口与生命周期契约](docs/host-contract.md)
- [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)
- [实现状态](docs/implementation.md)
- [当前施工计划](docs/construction-plan.md)
- [Stock DSH 集成验证清单](docs/integration.md)
- [Approval Reviewer 独立实现路线](docs/reviewer-roadmap.md)
- [跨仓库 Guarded Continuable 无补丁改造计划](../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)

## 许可证与外部参照

本项目原创代码与文档使用 [MIT License](LICENSE)。OpenAI Codex Guardian 是审批 Reviewer 设计时的外部参照之一；本项目不包含、复制、翻译或近似改写其代码、提示词、测试、snapshot 或文档表达，因此不把 Codex 内容作为本仓库的第三方组成部分分发。

参照只用于检查通用安全能力是否遗漏，例如证据信任、有界上下文、结构化结果、固定 deadline、有限重试、失败关闭和拒绝熔断。具体领域模型、算法、默认参数、策略文本和测试均须基于 DSH 独立设计。该边界的详细纪律见 [Reviewer 路线图](docs/reviewer-roadmap.md)。
