# DSH 0.1.2-alpha.2 artifact 集成与验收

> 当前实现基线：目标宿主 `dsh-v0.1.2-alpha.2` / `0a53fb55bea101816fa226bb964ae2bed71c343b`，alpha.2 检查点为 42 个测试文件、329 项测试。本文区分“源码/组件自动验证”“真实 disposable Profile artifact smoke”和“仍需人工或真实 LLM/跨进程 E2E”的不同证据等级。
>
> 宿主组合与失败语义以 [宿主契约](host-contract.md) 为准，卷宗事实以 [卷宗规范](guardian-dossier.md) 为准。本文记录当前装配方法和发布验收边界，不定义新接口。

## 1. 不可变输入与部署图

部署由四组 artifact 组成：

```text
已发布的 DSH 0.1.2-alpha.2 npm 依赖闭包（dist-tag alpha）
+ @deepseek-ai/dsh-user-approval fork tarball
+ dsh-managed-agent tarball
+ dsh-approve-for-me tarball
```

硬约束：

1. 目标宿主为 `0.1.2-alpha.2`（tag `dsh-v0.1.2-alpha.2`、commit `0a53fb55bea101816fa226bb964ae2bed71c343b`）。除 approval fork 外，宿主闭包及其 vendor（`@deepseek-ai/cordis` 4.0.2、`@deepseek-ai/schemastery` 3.18.2）全部作为普通 npm 依赖固定在该版本上。
2. `pnpm-lock.yaml` 的 integrity 摘要是依赖闭包的复现锚点：安装只用 `pnpm install --frozen-lockfile`，不重新解析版本；lockfile 的 diff 就是供应链变更审查面。
3. `@deepseek-ai/dsh-user-approval` fork 固定 `patch/dsh-user-approval/upstream.json` 中同一 tag/commit 和 patch version；保留上游 package name/version，必须携带 `dshApprovalPatch`；`pnpm-workspace.yaml` 的 overrides 把该包解析到 `.build/dsh-user-approval-afm-0.1.2-alpha.2.tgz`。
4. fork 构建在一次性上游 clone（`.build/upstream-clone`）中进行，上游 checkout 只被读取；overlay、测试、编译、打包、marker/API 校验及 SHA-256 sidecar 必须全部成功；构建补充依赖使用精确版本。
5. `dsh-managed-agent` 作为独立 artifact 先于本插件挂载。其 `artifact.json` 必须记录已审查 source commit、`dirty: false` 和 tarball SHA-256。
6. 本插件 package 不内嵌 approval fork；目标 Profile 必须显式安装 fork、managed-agent 和 approve-for-me 三个 tarball。
7. Profile 中解析到同版本官方 approval 包、错误宿主闭包、dirty managed artifact 或摘要不符时均不得继续发布。

## 2. 依赖 bootstrap

预期 sibling 布局：

```text
../deepseek-harness      # 只需包含锁定 commit，HEAD 可指向任意位置
../dsh-managed-agent
../dsh-approve-for-me
```

生成本地 artifact 并安装完整依赖图：

```bash
cd ../dsh-approve-for-me

DSH_REPO=../deepseek-harness \
MANAGED_AGENT_SOURCE=../dsh-managed-agent \
npm run bootstrap:dependencies
```

该命令依次执行：

1. `build:approval-fork`：在一次性 clone 中 detach 到锁定 commit，生成 `.build/dsh-user-approval-afm-0.1.2-alpha.2.tgz`，执行 overlay 测试/构建/校验并写 SHA-256 sidecar；
2. `build:managed-artifact`：pack sibling managed-agent，检查 runtime、types、Cordis patch，并写 source/digest manifest；
3. `pnpm install --frozen-lockfile`：按 `pnpm-lock.yaml` 的 integrity 从 npm 安装 `0.1.2-alpha.2` 宿主闭包，并用 workspace overrides 把 `@deepseek-ai/dsh-user-approval` 解析到本地 fork tarball、`dsh-managed-agent` 解析到已 materialize 的 artifact。

升级目标宿主版本时：同步更新 peer/dev 依赖的版本、`patch/dsh-user-approval/upstream.json` 的 tag/commit/version 与 workspace overrides，重跑上述 bootstrap，并把 `pnpm-lock.yaml` 的 diff 作为供应链变更审查。

## 3. 构建、测试与 package 验证

```bash
# 本插件：noEmit 类型检查、Vitest、发布构建
npm run check

# alpha.2 实现检查点：42 files / 329 tests

# 解析安装闭包、fork marker/API 与目标版本
# 需要 sibling deepseek-harness，且该 checkout 的 HEAD 精确等于锁定 commit/tag
npm run verify:installed-target-host

# fork 独立校验
npm run verify:approval-fork

# 本插件真实 pack 内容检查
npm run package:smoke
```

package smoke 必须确认 tarball 包含：

- `package.json`；
- `cordis.patch.yml`；
- `lib/index.js`；
- `lib/index.d.ts`；

并且不泄漏 `src/`、`tests/`、`node_modules/`、`patch/` 或 TypeScript 构建配置。

managed-agent artifact 还必须包含 `dist/index.js`、`dist/index.d.ts` 和 `cordis.patch.yml`。

## 4. Scoped per-Agent effective tool catalog

生产目录解析必须满足：

1. 每个 `ToolExecution` 从 exact `exec.agent` 调用 `ctx.tools.schemas(agent)`，不得使用安装时无作用域快照；
2. 从产生当前 call 的 canonical `request/header.tools` 重建持久 schema；nested code dispatch 使用对应 root model call 的 header；
3. live scoped schema 集合与 durable header schema 集合按 `toolName → toolSchemaFingerprint` 完全一致（数组顺序可不同；PTC `run_code` wire 只含一个 schema，callable 集合是其 root 的完整注册表）；
4. 一次执行只冻结一个 catalog commitment，action projection、approval descriptor、dossier classification 和 durable sidecar 共同使用；
5. late/HMR registry 变化不改变已冻结执行，新执行可观察新目录；
6. restricted Agent 只看到其有效工具集合；missing/duplicate call、事件序列不连续、歧义 header、schema 漂移或 fingerprint 不符全部失败关闭；
7. cold resume 只从 exact durable request/header 与 sidecar 重建，不退回全局 `tools.schemas()`。

自动测试应覆盖普通 call、code dispatch、restricted scope、header drift、HMR drift、空/歧义历史和 cold reconstruction。

## 5. Source-backed dossier 与 R4

机器策略不得从注册时 capture metadata 直接构造授权事实。每个 pending ask 仅保留：

- exact live Agent；
- requestId / callId / toolName / actionHash；
- 与 exact parent Session 绑定的 authority。

裁决时必须重新：

1. 从 exact Agent/Session 和持久 projection 获取 source packet；
2. 验证 request、call、action、ask、父系、生命周期及 event sequence 的唯一相关性；
3. 编译 source-verified、branded dossier；
4. 仅在 dossier 为 `ready` 时投影 breaker/cache keys、classification、generation/configuration fingerprint 和 R4；
5. 任一冲突、不完整或 abort 均返回不可授权结果，不得回退到 capture-only facts。

R4 基线：

- 风险来自 verified action semantics、requested permissions 和直接来源证据；
- 授权只接受最新可见 direct-user message 中独立且精确的 `/approve-for-me <JSON>` next-action 指令；
- toolName、arguments 和 requestedPermissions 必须与 verified action 完全匹配；
- natural language、模型 rationale、不可见/被替代内容或只有 event ref 而无正文的历史不构成授权；
- unknown/critical、审批规避、冲突授权、目标/副作用未覆盖均禁止自动 allow；
- Guardian 输出不能降低 source-derived risk、遗漏来源类别或虚构 source refs/coverage。

## 6. 机器决策槽

patched approval 的顺序必须是：

```text
session never
→ exclusive machine policy
→ approval/request waterfall
```

验收项：

1. `never` 会话不调用机器策略并直接拒绝；
2. 机器策略返回终态时，后续 waterfall 不被调用；
3. `'delegate'` 才进入官方 waterfall，并可到达 `ui-approval`；
4. 重复 machine-policy id、非法返回值、策略异常、abort race 与 disposer 后调用均失败关闭；
5. `approval/asked` 与 `approval/decided` 审计事件严格绑定同一 requestId，decided 位于 asked 之后；
6. 本插件挂载时必须验证 fork marker 和 `registerMachinePolicy()`，同版本官方包不得静默降级。

## 7. Reviewer deliveryAttempts 与 deadline

### 7.1 持久容量

- `deliveryAttempts` 表示 child 上实际 transport delivery 的尝试次数；不表示 accepted decision 数，也不因结果被拒绝而回退。
- 目录只复用同 parent、generation、configuration fingerprint 且未 retired/contaminated 的唯一 child。
- `deliveryAttempts >= maxDeliveryAttemptsPerChild` 时通过 managed-agent `renew()` 创建 durable successor。
- retired/contaminated/旧 generation child 保留审计可见性，但永久不可复用。
- 非法或缺失的持久计数失败关闭。

### 7.2 单一绝对 deadline

- pre-review 创建一个 absolute `deadlineAt`；目录发现、create/renew、delivery、等待结果、污染恢复和第二次业务 attempt 共用它。
- 一次 review 最多两个业务 attempts；污染 child rotation 是基础设施恢复，不消耗新的业务 attempt，但也不得延长 deadline。
- 已过期或已 abort 的请求不得 deliver；运行中到期应 interrupt Reviewer。
- deadline 后的结果、重复结果、错误 child、旧 generation 和错误 nonce 均无副作用。
- durable confirmation 跨越 deadline 时，即使 Guardian 已返回 allow，也不得授权。

## 8. Disposable Profile artifact smoke

运行：

```bash
npm run profile:artifact-smoke
```

先在两个源码仓库都 clean 且 managed source lock 精确匹配时运行 `npm run build:demo-kit`。它把 approval patch、managed-agent、approve-for-me 三个原子 tarball 封存到 `.build/demo-kit/`，并用 manifest 锁定每件 artifact 的文件名、SHA-256、source repository/commit/tree、patch upstream identity 与三个输入 lock 摘要；完成验收的同一 manifest 以 `deployment-artifacts.lock.json` 进入版本控制。

`profile:artifact-smoke` 只消费这个 kit；不会在验收阶段重新 pack 三个生产 artifact。脚本把已发布的 `@deepseek-ai/dsh@0.1.2-alpha.2` CLI 安装到一次性 prefix 并使用临时 `DSH_HOME`，因此不需要任何 harness checkout：

1. 完整校验 demo-kit manifest、三个 artifact digest 与 source identity；
2. 单独 pack 非生产的 probe fixture；
3. 执行真实 `dsh plugin --profile approve-for-me-artifact-smoke add --save-exact ...`；
4. 写入最小插件配置；
5. 用 `--dump-config` 确认 `managed-agent-host`、`dsh-approve-for-me` 和 probe 已 compose；
6. 真正启动一次 Profile；
7. 从 Profile package anchor 验证精确依赖闭包、fork marker 与 machine-policy API；
8. probe 验证 managedAgents create/renew/provider API、approval machine policy、catalog route 校验和非空 Host tool catalog；
9. 从同一已安装 Profile 冷启动第二个 Host 进程，要求 probe 再次通过且 effective tool catalog 与首次完全一致；
10. 保存两次 boot probe、composed config、Profile package.json、pnpm lock 和 Cordis patch 到 `.build/profile-smoke/`。

### 自动 smoke 通过时证明

- 三个 tarball 可通过真实 CLI 安装到 disposable Profile；
- Profile package/lock 可生成；
- Cordis loader 能 compose 并启动这些 artifact；
- Profile 内解析到 patched approval，而不是源码 checkout 的偶然依赖；
- managed service、machine-policy API 和 Host tools 服务在真实 boot 时可达；
- 同一 Profile 可由全新 Host 进程再次启动，且暴露相同的 effective tool catalog。

### 自动 smoke 未证明

- 浏览器中官方 approval panel 的展示、点击和恢复；
- 真实 LLM provider/model 能完成 Guardian allow/deny/human_review；
- 真实工具执行前后的副作用阻断；
- pending approval、Reviewer child 与 Storage 状态在进程终止后的 cold-resume（smoke 只覆盖同一 Profile 的空载冷启动）；
- 浏览器刷新、网络断开、并发卸载或存储故障下的完整行为；
- scoped/restricted Agent 的每条运行时组合。后者由组件/集成测试覆盖，但仍应纳入真实 E2E。

## 9. 真实模型/Web 测试实例准备

```bash
DSH_DEMO_PROVIDER=<provider-id> \
DSH_DEMO_MODEL=<model-id> \
npm run demo:prepare
```

该命令只消费已封存 demo kit，把三件套通过目标版本 CLI 安装进全新的仓库内 `.build/demo-profile/home`，生成 Profile package/lock，并打印隔离启动命令。provider/model 参数必须直接使用目标 DSH provider/model 列表中的稳定 ID；可用 `DSH_DEMO_REASONING_EFFORT` 传入模型声明的 effort。loader 会在注册机器策略前查询 `ctx.llm.listProviders()` / `listModels()` 并失败关闭。credential、adapter、retry 和 request route 都继续由 DSH 管理，本插件不会复制 secret。

脚本拒绝已存在的输出目录，也不会启动 server、修改默认 `~/.dsh` 或访问当前运行实例。测试者可按输出命令在单独端口手工完成真实模型和 Web 链路，但这些人工结果不计入自动 smoke 证据。

## 10. 仍需 Web + 真实 LLM + cold-process E2E

发布验收环境必须使用已打包 artifact 和精确目标 Profile，而不是源码链接。至少执行：

1. **真实 LLM Guardian**：包络外动作分别产生 allow、deny、human_review；验证 source-backed dossier、R4 floor 和 durable decision record。
2. **Web 人工链**：`auto-then-user` 下 human_review 只经 `'delegate'` 到官方 `ui-approval`，面板可见、可批准/拒绝且不会被 managed composer 抢占。
3. **真实工具执行**：终态 allow 只消费一次；deny、deadline、abort、错误身份和存储失败均在副作用前阻断。
4. **cold-process**：完成一次 review 后彻底结束 DSH 进程，再从同一 Profile/Storage 启动；验证 child、generation、deliveryAttempts、request/header catalog、sidecar 和 pending state 的恢复。
5. **污染与容量**：污染 child、达到 delivery attempt 上限、renew/rotate 和迟到旧结果在进程重启边界保持失败关闭。
6. **卸载/重载**：machine policy、provider、pending human interaction 和 Web projection 按生命周期正确 settle/dispose/re-register。

这些项目不能由 unit tests、已存在脚本、`--dump-config` 或一次正常 Profile boot 替代。

## 11. 完成判定

### 11.1 自动 artifact 集成通过

- 已发布宿主闭包按 `pnpm-lock.yaml` integrity 可复现，approval fork 可从锁定 commit 重建；
- approval fork 与 managed artifact 身份/摘要通过；
- frozen install、typecheck、tests、build、package smoke 通过；
- disposable Profile artifact smoke 通过并产出可审查证据。

### 11.2 产品级审批 E2E 通过

在 11.1 之外，必须完成第 10 节的真实 Web、真实 LLM、真实工具副作用和 cold-process 场景，并确认所有 unknown/ambiguous/failure 路径均失败关闭。只有 11.1 不足以声明自动审批产品就绪。
