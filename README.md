# dsh-approve-for-me

面向 DeepSeek Harness（DSH）的受管自动审批插件：工具副作用发生前，由隔离的 Guardian Reviewer 裁决；只有来源可验证、作用域精确且满足证据规则的动作才可能自动放行，其余请求失败关闭或下沉官方人工审批链。

> 当前实现基线：精确适配 DSH `0.1.2-alpha.1`（commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`），采用机器决策槽 v2。本仓库交付插件本体以及 `@deepseek-ai/dsh-user-approval` 的最小 fork；`dsh-managed-agent` 由独立仓库构建为受摘要约束的安装 artifact。alpha.1 实现检查点通过 41 个测试文件、324 项测试。真实 artifact 已具备 disposable Profile 自动冒烟；Web 人工审批、真实 LLM Guardian 与跨进程 cold-resume 仍须单独执行端到端验收。

## 部署组成

```text
精确 DSH 0.1.2-alpha.1 源码产出的本地 package artifacts
+ @deepseek-ai/dsh-user-approval fork tarball
+ dsh-managed-agent tarball（Host/Client bundle）
+ dsh-approve-for-me tarball
```

- 宿主源码固定为 tag `dsh-v0.1.2-alpha.1` / commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`。
- `target-host-artifacts.lock.json` 固定宿主闭包内每个 tarball 的名称、版本与 SHA-256；普通 bootstrap 必须复现完全相同的记录。
- approval fork 固定同一上游 commit，保留官方 `name`/`version`，以 `dshApprovalPatch` 和独立 tarball 名标识；运行时会拒绝没有该标记或 `registerMachinePolicy()` 的同版本官方包。
- managed artifact 由 sibling `dsh-managed-agent` 打包；`managed-agent-source.lock.json` 先约束完整 reviewed source tree 摘要，`artifact.json` 再记录 source commit/tree digest、dirty 状态、文件名和 tarball SHA-256。任何 source 漂移都在打包前失败；发布输入仍应使用 `dirty: false` 的已审查 commit。
- 插件包不内嵌 approval fork；部署时必须把 fork、managed-agent 和本插件三个 artifact 一起安装到目标 Profile。

## 裁决入口

patched `dsh-user-approval` 提供唯一的 `registerMachinePolicy()` 槽：

```text
模型 tool call
→ tools/pre-execute 捕获 exact ToolExecution
→ 按 exact Agent 解析当前 scoped tools.schemas(agent)
→ 与产生该 call 的 canonical request/header tools 逐字节规范化比对并冻结 catalog
→ ctx.approval.request()
→ ApprovalService.decide()
   ├─ never → rejected
   └─ machine policy
      ├─ 从 exact Session/source snapshot 编译 branded dossier
      ├─ 从 verified action + direct-user evidence 计算 R4
      ├─ trust envelope / deny breaker / allow cache
      └─ Guardian Reviewer（dsh-managed-agent child）
         ├─ allow / deny
         └─ human_review → auto: rejected；auto-then-user: delegate
→ delegate → 官方 approval/request waterfall → Web 人工审批
```

机器策略位于 `never` 之后、官方 `approval/request` waterfall 之前；机器策略异常、身份冲突、catalog 漂移、卷宗不完整、存储失败或 deadline 到期均不能自动放行。

## Scoped effective tool catalog

工具目录不是安装期全局快照，而是每次执行绑定的授权事实：

1. 从 exact `ToolExecution.agent` 读取 `ctx.tools.schemas(agent)`；
2. 从该 call 的 canonical `request/header` 重建持久工具集合；nested code dispatch 绑定其 root model call 的 header；
3. 两份 JSON 规范化结果必须相同，随后冻结为同一个 approval/dossier catalog commitment；
4. action projector、durable sidecar、卷宗分类与冷恢复都消费该 commitment；
5. restricted scope、缺失/歧义历史、late/HMR drift 或 schema 指纹不一致均失败关闭。

因此不同 Agent 可以拥有不同有效工具集合，冷恢复也不会退回无作用域的全局 schema 快照。

## Source-backed dossier 与 R4

生产 gate 不信任注册时缓存的分类或模型声明。每个 ask 只保存相关性句柄；裁决时重新从 exact Agent/Session、requestId、callId、actionHash 和持久事件序列构建事实，只有编译为 branded、`ready` 的 source-verified dossier 才能进入授权路径。

R4 风险/授权基线只使用：

- verified action snapshot 与结构化语义；
- 卷宗中保留且可见的 direct-user 消息；
- 精确的 `/approve-for-me <JSON>` next-action 指令。

自然语言暗示、模型 rationale 和仅有事件引用而无正文的历史都不能证明授权。unknown/critical 风险、目标或副作用未覆盖、审批规避和权限扩张证据不足均禁止自动 allow。sandbox-denied 候选从不直接成为授权或预审 fast path；每次提权都必须由 fresh Guardian 选择一个同动作合法重试关系，机器策略再把该选择约束到卷宗候选闭集。

## Reviewer 容量与 deadline

- `deliveryAttempts` 是 managed-agent 持久目录中对 child 的实际 transport delivery 尝试计数，不是“已接受结果”计数。
- `maxDeliveryAttemptsPerChild` 达到后，目录通过 durable `renew()` 取得 successor；污染 child 也永久退出复用集合。
- 一次业务 review 最多两个业务 attempts；污染恢复是基础设施轮换，不额外增加业务 attempt。
- 同一个绝对 `deadlineAt` 覆盖目录发现、renew、delivery、污染恢复、重试和结果等待；恢复与重试不得延长授权窗口。
- deadline/abort 后的迟到、重复或旧 generation 结果没有审批副作用。

## 可复现 bootstrap 与验证

要求 sibling checkout：

```text
../deepseek-harness   # exact cd5ef814...
../dsh-managed-agent  # 已审查的 managed-agent source commit
../dsh-approve-for-me # 本仓库
```

```bash
# 构建 immutable approval fork、managed artifact、精确宿主 artifact 闭包，
# 再按 frozen pnpm lock 安装
DSH_REPO=../deepseek-harness \
MANAGED_AGENT_SOURCE=../dsh-managed-agent \
npm run bootstrap:dependencies

# alpha.1 类型、测试与构建
npm run check

# 校验本插件发布包内容
npm run package:smoke

# 使用真实 DSH CLI、已 materialize 的 managed tarball 和临时 DSH_HOME 安装并启动 Profile
DSH_REPO=../deepseek-harness \
npm run profile:artifact-smoke
```

`bootstrap:target-host` 会从精确宿主源码构建依赖闭包并与 `target-host-artifacts.lock.json` 比对；只有显式执行 `bootstrap:target-host:refresh` 才会更新已审查的 artifact lock。approval fork 的构建依赖也使用精确版本。

## 自动 Profile smoke 证明什么

`profile:artifact-smoke` 在 disposable `DSH_HOME` 中：

- 校验 `.artifacts/managed-agent/artifact.json` 的 digest，并安装这一个已经 materialize/安装过的 managed-agent tarball，而不是从 source 二次 repack；
- 安装 approval fork、managed-agent、本插件三个部署 tarball，并加入独立 probe tarball；
- 通过真实 `dsh plugin --profile ... add --save-exact` 生成 Profile package/lock；
- 用 `--dump-config` 确认 managed host、本插件和 probe 已 compose；
- 真正启动一次目标 Profile；
- 从 Profile 自身解析依赖，验证 fork marker/API 与精确 alpha.1 安装闭包；
- 验证 `ctx.managedAgents` 的 create/renew/provider API、`ctx.approval.registerMachinePolicy()` 以及非空 Host tool catalog。

它证明 artifact 安装图、Cordis loader boot 和关键服务接口可达；它**不证明**浏览器审批面板、真实 LLM Reviewer 决策、实际工具副作用、人工点击流程，也不证明杀死并重新启动 OS 进程后的 cold-resume。

## 仍需人工/真实环境 E2E

发布前仍需在真实 Web 与真实模型配置下验证：

1. Guardian allow/deny/human_review 与真实工具调用的完整链；
2. `auto-then-user` delegate 后官方 Web approval panel 可见且可操作；
3. Reviewer 子代理树、只读 composer、Stop 与 pending approval 的 UI 优先级；
4. 浏览器刷新与 DSH 进程彻底退出/重启后的 durable cold-resume；
5. deadline、污染、renew、卸载/重载期间的真实并发与失败注入。

## 文档

从 [文档地图与维护规则](docs/README.md) 开始：

- [宿主接口与生命周期契约](docs/host-contract.md)
- [施工蓝图](docs/construction-spec.md)
- [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)
- [集成验证清单](docs/integration.md)
- [实现状态](docs/implementation.md)

## 许可证与外部参照

本项目原创代码与文档使用 MIT License。官方包 fork 仅修改 `dsh-user-approval`，保留其 MIT LICENSE 与版权声明；`dshApprovalPatch` 明确标识第三方修改版本。Codex Guardian 仅作为能力覆盖参照，不复制或翻译其代码、提示词、测试与文档表达。
