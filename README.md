# dsh-approve-for-me

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 的受管自动审批插件。

> 当前代码状态（2026-08-27）：领域协议、应用层和标准 `ctx.managedAgents` Guarded Continuable 接入已实现，当前测试为 82 项；已补齐标准 DSH bundle 包装（`dsh.bundle.patch` + `cordis.patch.yml`）。审批 listener 仍是待迁移骨架；真实 profile 还需正式的 terminal approval composer seam，尚未完成人工测试与验收。
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

基础层负责受控创建、发现、投递、恢复、pre-step 输入守卫、generation/污染管理和停止；审批 schema、singleton、串行、deadline、结果关联、污染 child 隔离与失败关闭仍全部由本仓库负责。当前代码已使用标准 `ctx.managedAgents.registerProvider()`，不再调用 patched `ctx.subagents.registerManagedProvider()`。

## 已实现内容

### 真实契约消费（Phase 0）

- 直接消费 `@deepseek-ai/dsh-*@0.1.1-rc.2`、`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/schemastery@3.18.1` 和 `dsh-managed-agent@0.1.0-dev.0`（精确版本）。
- `dsh-managed-agent` Host 插件在 stock `continuable` 之上提供 `ctx.managedAgents`，本项目通过 `registerProvider()` 注册 Reviewer，不修改任何官方 DSH 包。
- 全部本地 `Dsh*` facsimile 已删除；`tests/adapters/real-contract.test.ts` 证明 `ManagedAgentProvider`／`ManagedAgentController`／`AgentSetup`／`ToolDefinition`／`approval/request` listener 以真实类型组合，无 `as unknown as` 贯穿 seam。

### 分层（Phase 1–4）

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

### 审批模式（目标契约）

- `auto`：只有完整验证且最小决策记录已 durable 的 `allow` 自动映射为 `allowed-once`；其他决定或故障均不放行。
- `auto-then-user`：只有能力不足、Reviewer 暂时不可用或明确 `human_review` 可由 terminal composer 调用显式 `HumanApprovalPort`；身份、hash、generation 或 sidecar 完整性冲突硬停止。

当前 `approval-answerer.ts` 仍用 prepended sibling listener + `next()`，DSH 不保证这种 listener 顺序是 policy priority，因而不能作为上述产品契约。DSH 0.1.1-rc.2 的 Web 人工 answerer 也没有公开 callable port；完成 host/profile terminal composer seam 前，`auto-then-user` 不得用于真实 profile 验收。

### 污染隔离与 generation 轮换

- Managed catalog 暴露持久 `contaminated` 标志；Reviewer directory 永久跳过受污染 child；
- deliver 阶段发现新污染时，先调用 Controller `rotate()` 排空旧 child 并预留干净替代，再在串行 lane 内重试一次；
- 重载后同一逻辑 Reviewer 会从持久 catalog 中找到新的干净 generation，旧 child 仍由 Host 守卫拒绝授权。

## 下一阶段：填充 Reviewer 产品能力

当前代码首先完成了身份、动作快照、结果关联、生命周期和失败关闭等安全骨架；`policy-v1` 只是最小保守占位策略。下一阶段按依赖顺序独立实现：

1. DSH Session log／Storage Domain sidecar facts source 与冻结快照；
2. 环境、项目指令、用户—主 Agent 交付链与精确委托包络、当前 turn 工具状态和审批动作组成的五段式卷宗；
3. 以完整 full dossier 为基线的大小、延迟、溢出率和裁决倾向评测；
4. shell、filesystem、network、MCP 和 permission request 等工具族动作语义；
5. 项目自有的风险分类、用户授权 assessment、完整 policy、有限尝试和拒绝熔断。

宿主组合、审批映射、Review Run、生命周期和留存端口见 [Approve-for-me 宿主接口与生命周期契约](docs/host-contract.md)；卷宗的候选接口、提取不变量、sidecar 边界和测试条件见 [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)；完整组件和实施顺序见 [Approval Reviewer 独立实现路线](docs/reviewer-roadmap.md)。所有内容从 DSH 的需求与威胁模型独立推导；外部项目只用于能力覆盖比较，不作为源码或文本素材。

## 依赖边界

- 领域层（`domain/`）不 import Cordis／DSH 类型。
- 应用层（`application/`、`ports/`）只依赖领域协议与自己的 port。
- `dsh-managed-agent` 只通过 Host 的 `ctx.managedAgents` 服务接入；本仓库对它的使用仍是 type-only import，运行时零引用。

## 部署状态与目标前提

应用迁移（Phase 3）与标准 bundle 包装（Phase 4 包侧部分）已完成，但真实 profile 集成验收（Phase 5）尚未执行：**在人工验收通过前，尚不应作为正式产品环境配置**。目标前提为：

1. stock DSH 安装并挂载标准 `dsh-managed-agent` Guarded Continuable bundle；
2. 配置 `reviewer.generation/provider/model/policyVersion/toolsetVersion`（可选 `mode`、`timeoutMs`、`reasoningEffort` 和 case capture）；
3. 目标 composition root 通过代码级 options 注入 terminal composer、可选 `HumanApprovalPort` 和权限投影 port，均不进入序列化 Config；当前导出的安装接口尚待按宿主契约迁移；
4. profile 只注册单一 terminal approval composer 和一个全局自动 policy slot；`auto-then-user` 还须提供显式 `HumanApprovalPort`，不得依赖普通 sibling listener 顺序；
5. 未授权输入、污染、超时或基础设施失败必须继续映射为拒绝、`unavailable` 或受限人工恢复，不得静默降级为放行。

完整人工验收清单见 [集成验证计划](docs/integration.md)。

## 标准 DSH 插件安装

本仓库已声明 `dsh.bundle.patch`（`cordis.patch.yml`），可作为标准 Host bundle 装入 DSH profile：

```bash
# 先安装基础 Host/Client bundle
dsh plugin --profile web add /path/to/dsh-managed-agent

# 再安装本审批插件
dsh plugin --profile web add /path/to/dsh-approve-for-me
```

bundle 层只负责插入 `dsh-approve-for-me` 插件行；**Reviewer 配置是部署相关值**，需要在 profile 的 `cordis.patch.yml` 中补上（可参考 `cordis.patch.yml` 顶部示例），或使用 `dsh --profile web --dump-config` 调整：

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

- [跨仓库 Guarded Continuable 无补丁改造计划](../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)
- [项目共识与设计边界](docs/consensus.md)
- [实现状态与后续接入](docs/implementation.md)
- [Approval Reviewer 独立实现路线](docs/reviewer-roadmap.md)
- [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)
- [Stock DSH 集成验证清单](docs/integration.md)
- [历史施工计划与当前业务分层](docs/construction-plan.md)

## 许可证与外部参照

本项目原创代码与文档使用 [MIT License](LICENSE)。OpenAI Codex Guardian 是审批 Reviewer 设计时的外部参照之一；本项目不包含、复制、翻译或近似改写其代码、提示词、测试、snapshot 或文档表达，因此不把 Codex 内容作为本仓库的第三方组成部分分发。

参照只用于检查通用安全能力是否遗漏，例如证据信任、有界上下文、结构化结果、固定 deadline、有限重试、失败关闭和拒绝熔断。具体领域模型、算法、默认参数、策略文本和测试均须基于 DSH 独立设计。该边界的详细纪律见 [Reviewer 路线图](docs/reviewer-roadmap.md)。
