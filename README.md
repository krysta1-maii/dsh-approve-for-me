# dsh-approve-for-me

面向 DeepSeek Harness（DSH）的受管自动审批插件：工具副作用发生前，由隔离的 Guardian Reviewer 裁决；只有来源可验证、作用域精确且满足证据规则的动作才可能自动放行，其余请求失败关闭或下沉官方人工审批链。

> 当前实现基线：精确适配 DSH `0.1.2-rc.1`（commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，tag `dsh-v0.1.2-rc.1`），采用机器决策槽 v3。宿主闭包直接消费 npm 上已发布的 `0.1.2-rc.1` 包，由 `pnpm-lock.yaml` 的 integrity 固定；本仓库另外交付插件本体与 `@deepseek-ai/dsh-user-approval` 的最小 fork，`dsh-managed-agent` 由独立仓库构建为受摘要约束的安装 artifact。rc.1 实现检查点通过 44 个测试文件、378 项测试。生产 loader 会从 `ctx.llm.listProviders()` / `listModels()` 绑定并校验 Guardian route，再复用 DSH 的 adapter、凭据、retry 与 model selection；stale provider/model/effort 在注册机器策略前失败关闭。真实 artifact 已具备 disposable Profile 自动冒烟；真实 LLM Guardian 判断质量（S1/S2）与 pending 状态跨进程 cold-resume 已验收，policy-v3 的 danger 升档自动放行已在 live 实例实测通过（证据见 [验收记录](docs/acceptance-0.1.2.md)）；官方 Web 人工面板点击链、故障注入与长程 soak 仍须单独执行端到端验收。

## 部署组成

```text
npm 已发布的 @deepseek-ai/*@0.1.2-rc.1 宿主闭包
+ @deepseek-ai/dsh-user-approval fork tarball
+ dsh-managed-agent tarball（Host/Client bundle）
+ dsh-approve-for-me tarball
```

- 宿主基线固定为 tag `dsh-v0.1.2-rc.1` / commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`；该版本已发布到 npm（dist-tag `alpha`）。
- 除 approval fork 外的宿主包全部按精确版本从 registry 安装，可复现性由 `pnpm-lock.yaml` 的 integrity 摘要保证；本仓库不再自建、也不再锁定本地宿主 tarball 闭包。
- approval fork 仍从固定 commit 的宿主**源码**构建，保留官方 `name`/`version`，以 `dshApprovalPatch` 和独立 tarball 名标识；运行时会拒绝没有该标记或 `registerMachinePolicy()` 的同版本官方包。构建在一次性 clone 中进行，只读取上游 checkout，绝不写入。
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

## Web 当前会话信息流

插件同时交付静态 `dsh.client` 浏览器入口，把父会话中已经存在的官方持久审计对投影为一条紧凑的 Chat 信息流状态项：

```text
approval/asked   → Approve for me · 审批中
approval/decided → 同一状态项原位更新为 已允许 / 已拒绝 / 已取消 / 审批不可用
```

状态项按 requestId 精确配对，显示工具名、审批原因和“查看操作”入口；颜色、字号、间距、暗色模式及 reduced-motion 均复用 DSH design tokens。它保持为独立信息流项，不会被 compact transcript 折叠进“工具调用”摘要；刷新或重载后由持久事件重建，孤立的 `approval/asked` 保持未决而不会伪造结果。

该 UI 是只读、非授权的 client projection：不拦截 `approval/request`，不注册第二条审批链，不向 `user/message`／`assistant/message`／`tool/result` 等模型 surface 写入状态，也不新增可能破坏旧版持久化或后续 dossier 编译的私有 Session event。最终展示始终以权威 `approval/decided` 为准；发生人工下沉时，它表示整条审批请求的最终结果，而不冒充 Reviewer 的中间提议。

## 设置中的 Reviewer 模型

Host 在可选的 DSH Settings 服务上注册 `dsh-approve-for-me` namespace；浏览器半侧以同名 key 向“设置 → 插件 → 插件配置”贡献原生风格卡片。卡片从 `remote.session.modelCatalog()` 读取实时 provider/model 目录，展示名称但只持久化稳定的 provider/model id；未出现在当前目录中的已配置 route 会明确标为不可用，不会被静默替换为默认模型。

选择先保留为本地草稿，点击保存后以 namespace revision 为 fence，原子修改 `reviewer.provider` 与 `reviewer.model` 两个路径。并发变更会阻止旧草稿覆盖新配置；重置会删除用户层 route，重新继承 Profile 的组合配置。配置提交后旧 machine policy 立即撤销，只有新 route 通过 DSH catalog 精确校验后才重新挂载；不可用 route 保持失败关闭。切换到非部署默认模型时不携带旧模型的 `reasoningEffort`，而是使用新 adapter 的默认值。

该设置只开放 Reviewer route。generation、policy/toolset 版本、审批模式、trust envelope、tool catalog 等授权边界仍由部署配置拥有；provider 私有配置、凭据与 retry 继续完全复用 DSH。

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

R4 是提供给 Reviewer 并约束 authorization-derived cache/replay fast path 的结构化基线，只使用 verified action semantics、requested permissions、保留且可见的 direct-user 消息和精确 `/approve-for-me <JSON>` 指令；它不替代 Reviewer 对完整 source-backed dossier 的业务判断。

首次 fresh review 中，Reviewer 拥有最终的 allow／deny／human_review 裁决权：清晰、无歧义的普通自然语言请求可以构成授权，`/approve-for-me` 是高置信结构化信号而不是自动 allow 的必需前置。Host 只校验 parent/action/generation/deadline 等客观绑定，不以 R4 标签重写身份有效的 Reviewer 决策。sandbox-denied 候选仍不直接进入预审 fast path；当前 turn 的同动作严格扩权重试由 Host 绑定候选事实，再交 Reviewer 判断必要性与风险。

`policy-v3`（demo profile 与质量冒烟的默认）进一步移除了“critical 风险永不放行”的硬编码：一次 `danger-full-access` 升级是普通可评审请求，R4 基线将其标为 `high` 评审信号而非禁令，Reviewer 按直达用户证据覆盖裁决，且 danger 放行必须在 `assessment.sourceRefs` 引用所依据的用户消息。剩余绝对禁令只有 rejection-bypass 与证据缺失（证据事实而非判断）；permission-expansion 在任何政策下都不进入 fast path，每次升级都由新鲜 Guardian 评审。`policy-v2` 保留注册，配置 `reviewer.policyVersion` 即可回退。

## 历史预算、取消与事件循环公平性

第一版 approval barrier 会在进程重启后的首次审批中重放全部历史 `tool/result`，而每条 native result 又全表读取 execution sidecar，形成 O(R×E) 放大；长 Session 会耗尽事件循环，使 Web Stop、审批持久化和 timer 都得不到调度。当前实现改为利用 `sourceEventSeqs` 和 approval 前最后一条 exact request 做 `repository.get()`，只等待本进程已经在写的结果，不再全历史重放。

`maxSourceEvents` 默认且最高为 `20000`（部署只能下调），在读取全量 sidecar 或同步构建 dossier 前拒绝超预算历史：`auto-then-user` 下进入官方人工审批，`auto` 下保持 unavailable。Storage Domain 大索引每 32 条主动让出一次 macrotask 并检查 AbortSignal；`timeoutMs` 现在覆盖从 machine-policy 入口开始的事实读取、dossier、Reviewer 与确认全链，而不仅是 Reviewer I/O。用户 Stop 或 deadline 会立即结束当前审批等待，底层协作任务仍由 lifecycle 持有并排空，迟到工作不能产生授权。

## Reviewer 容量与 deadline

- `deliveryAttempts` 是 managed-agent 持久目录中对 child 的实际 transport delivery 尝试计数，不是“已接受结果”计数。
- `maxDeliveryAttemptsPerChild` 达到后，目录通过 durable `renew()` 取得 successor；污染 child 也永久退出复用集合。
- 一次业务 review 最多两个业务 attempts；污染恢复是基础设施轮换，不额外增加业务 attempt。
- `timeoutMs` 从 machine-policy 入口开始形成完整外层 deadline；Reviewer 内部同一个绝对 `deadlineAt` 覆盖目录发现、renew、delivery、污染恢复、重试和结果等待，任何内层恢复都不得越过外层预算。
- deadline/abort 后的迟到、重复或旧 generation 结果没有审批副作用。

## 可复现 bootstrap 与验证

只有 approval fork 与 managed artifact 需要 sibling checkout：

```text
../deepseek-harness   # 需包含 a66e4702576...（HEAD 可以在别处；仅被读取）
../dsh-managed-agent  # 已审查的 managed-agent source commit
../dsh-approve-for-me # 本仓库
```

```bash
# 构建 immutable approval fork 与 managed artifact，再按 frozen pnpm lock
# 安装已发布的 rc.1 宿主闭包
DSH_REPO=../deepseek-harness \
MANAGED_AGENT_SOURCE=../dsh-managed-agent \
npm run bootstrap:dependencies

# rc.1 类型、测试与构建
npm run check

# 校验本插件发布包内容
npm run package:smoke

# 从 clean、锁定来源构造输入，再封存三原子 demo kit
npm run materialize:demo-inputs
npm run build:demo-kit

# 只消费封存 kit，在临时 DSH_HOME 安装并启动脚本化验收 Profile
npm run profile:artifact-smoke

# 把三件套安装到仓库内新的隔离 DSH_HOME；ID 直接取自目标 DSH provider/model 列表
DSH_DEMO_PROVIDER=<provider-id> DSH_DEMO_MODEL=<model-id> npm run demo:prepare
```

`build:approval-fork` 在 `.build/upstream-clone` 中检出固定 commit 并构建，上游 checkout 只被 `git clone` 读取；`verify:target-host` 再校验该 commit、tag、版本与 fork 标记。`build:demo-kit` 只接受 clean、锁定的两个源码仓库，生成 `.build/demo-kit/demo-kit.json`；已验收 release set 同步冻结在 tracked `deployment-artifacts.lock.json`。两者逐一记录三个 tarball 的 SHA-256、source identity 与输入 lock 摘要。`demo:prepare` 不启动 server，不接触当前实例；它把稳定 route ID 写入隔离 Profile，并输出启动命令。provider credential 与 adapter 配置仍由该 DSH Profile 管理。

## 自动 Profile smoke 证明什么

`profile:artifact-smoke` 在 disposable `DSH_HOME` 中（CLI 也来自已发布的 `@deepseek-ai/dsh@0.1.2-rc.1`，无需宿主 checkout）：

- 完整校验 demo kit manifest、artifact digest 与 source identity，只消费三份预封存部署 tarball；
- 安装 approval fork、managed-agent、本插件三个部署 tarball，并加入独立 probe tarball；
- 通过真实 `dsh plugin --profile ... add --save-exact` 生成 Profile package/lock；
- 用 `--dump-config` 确认 managed host、本插件和 probe 已 compose；
- 真正启动目标 Profile，并在其中跑完两条 gate 路径：一次 `/approve-for-me` 授权动作被自动放行并真实执行了 `bash` 副作用，一次 `auto-then-user` 下沉被人工通道拒绝且命令没有执行；
- 杀掉进程后再从同一个已安装 Profile 冷启动一次，要求 effective tool catalog 完全一致；
- 从 Profile 自身解析依赖，验证 fork marker/API 与精确 rc.1 安装闭包；
- 验证 `ctx.managedAgents` 的 create/renew/provider API、`ctx.approval.registerMachinePolicy()` 以及非空 Host tool catalog。

它证明 artifact 安装图、Cordis loader boot、机器决策槽与两条业务路径在真实 Host 进程内可达；它**不证明**浏览器审批面板与人工点击流程、真实 LLM Reviewer 的判断质量，也不证明带 pending approval / Reviewer child 状态的跨进程 cold-resume（冒烟里的 Guardian 是脚本化 adapter，不是真实模型）。后两者分别由 `profile:quality-smoke`（真实 LLM，S1/S2）与 `profile:pending-smoke`（SIGKILL cold-resume）覆盖，证据与 policy-v3 live 实测补记见 [验收记录](docs/acceptance-0.1.2.md)。

## 仍需人工/真实环境 E2E（2026-09-04 对账）

已完成：真实 LLM Guardian 授权内放行/授权外下沉（S1/S2）、SIGKILL 后 pending 状态 cold-resume、policy-v3 danger 升档授权内场景的 live 实测。发布前仍需验证：

1. policy-v3 提示词下的 S1/S2 自动化回归、探针版 S3（规格已备）与 S3b（无授权 danger 必须 human/deny）；
2. `auto-then-user` delegate 后官方 Web approval panel 的完整点击链（live 已观察到状态项与人工兜底，无自动化证据）;
3. Reviewer 子代理树、只读 composer、Stop 与 pending approval 的 UI 优先级；
4. deadline、污染、renew、卸载/重载期间的真实并发与失败注入；
5. 长程 soak。

## 文档

从 [文档地图与维护规则](docs/README.md) 开始：

- [宿主接口与生命周期契约](docs/host-contract.md)
- [施工蓝图](docs/construction-spec.md)
- [Guardian 案件卷宗接口与编译规范](docs/guardian-dossier.md)
- [R4 风险与授权评估](docs/risk-assessment.md)
- [集成验证清单](docs/integration.md)
- [实现状态](docs/implementation.md)
- [0.1.2 验收记录](docs/acceptance-0.1.2.md)

## 许可证与外部参照

本项目原创代码与文档使用 MIT License。官方包 fork 仅修改 `dsh-user-approval`，保留其 MIT LICENSE 与版权声明；`dshApprovalPatch` 明确标识第三方修改版本。Codex Guardian 仅作为能力覆盖参照，不复制或翻译其代码、提示词、测试与文档表达。
