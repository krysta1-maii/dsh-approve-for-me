# Stock DSH + Companion Profile 集成验证清单

> 状态：2026-08-28，目标验收计划。companion `dsh-managed-agent` 服务接入与 bundle 包装已完成；companion Host Profile、thin composer adapter 及真实 Profile／Web 验收尚未完成。
>
> 宿主组合与失败语义以 [宿主契约](host-contract.md) 为准，卷宗事实以 [卷宗规范](guardian-dossier.md) 为准，施工顺序见 [当前施工计划](construction-plan.md)。本文只定义验收，不定义新接口。

## 1. 集成硬约束

1. 使用未修改且锁定兼容版本的官方 `@deepseek-ai/dsh-*` packages；不得应用 managed patch、fork 或 `patch-package`。
2. 使用本项目配套的 Host Profile，而不是假设任意 stock Profile 都满足审批拓扑；Agent Preset 不能替代 Host Profile。
3. companion `dsh-managed-agent` 必须作为 Host/Client bundle 安装并提供其自有的 `ctx.managedAgents` 服务。
4. `dsh-approve-for-me` 必须通过 `ctx.managedAgents.registerProvider()` 注册 Reviewer，不再调用 patched `ctx.subagents.registerManagedProvider()`。
5. Session persistence 必须启用，Managed catalog/providerData 使用插件自己的持久化边界，不向 Session 写外部未知 event。
6. companion Profile 必须提供稳定 thin composer adapter、唯一自动 policy slot 和 request-scoped `HumanApprovalPort` bridge；核心插件不得依赖 sibling listener 顺序。
7. 未授权输入、污染、超时、模型错误、工具错误和存储错误全部失败关闭。

## 2. 构建与安装前检查

```bash
# dsh-managed-agent
npm run check
npm pack --dry-run

# dsh-approve-for-me
npm run check
npm pack --dry-run
```

两包共同必须具备：

- `name` / `inject` / `Config` / `apply`；
- `dsh.bundle.patch`；
- 完整 `exports` 和构建产物；
- stock DSH 精确 peer 版本；
- 不含 patched DSH tarball、源码覆盖或 postinstall patch。

其中 `dsh-managed-agent` 同时提供 Host 与 Client bundle；`dsh-approve-for-me` 只提供 Host bundle，Web 只读展示和 Stop 复用前者的 Client bundle。

本仓库的发布产物还必须确认：

- `package.json` 声明 `license: MIT`，tarball 包含根 `LICENSE`；
- Reviewer policy、上下文算法、测试与文档均为本项目独立编写；
- 不包含从 Codex Guardian 复制、翻译、近似改写或 vendor 的代码、提示词、测试、snapshot 与文档表达。

## 3. Companion Host Profile 装配

单独执行以下命令只能安装两个 bundle，不能生成产品级审批组合：

```bash
dsh plugin --profile <companion-profile> add /path/to/dsh-managed-agent
dsh plugin --profile <companion-profile> add /path/to/dsh-approve-for-me
```

配套 Profile 还必须装配稳定 thin composer adapter。验证：

- Profile manifest 包含两个 bundle 和 adapter；
- 官方 DSH package 内容及 lockfile resolution 未修改，兼容版本被锁定；
- adapter 先于 Guardian policy 存在且不随 policy HMR 卸载；
- Profile 只有一个自动 policy slot，第二个 contribution 注册失败；
- 可变／用户 Agent Preset roots 与 preset HMR 已禁用，启用 preset catalog 与 package resolution 由 fingerprint allowlist 锁定；逐个审计其 composition 不注册 `approval/request` listener；所有受支持的 Profile／preset／listener mutation API 由 Profile-owned 原子 gate 持有；
- adapter 的 request continuation 下游是已核验的 stock Web human listener，Host sibling 与 preset-scoped listener 均不能插入；
- policy 未挂载时的 deployment default 明确且经过测试；
- Reviewer provider／model／generation／policyVersion／toolsetVersion 显式存在，缺失、空值或 schema 非法配置在 provider 注册前使挂载失败；
- `auto-then-user` 缺少 adapter 或 adapter 静态声明 `supportsHumanDelegation: false` 时拒绝挂载；request-scoped `HumanApprovalPort` 只在每次 dispatch 内构造，运行时 continuation 缺失／抛错／非法返回映射为 `unavailable`；
- Reviewer route 不继承主 Agent 模型；语法有效但 catalog 中不存在／运行期不可用的 route 在 materialize／request 时失败且不静默切换；
- `dsh-managed-agent` Client bundle 被 Web Profile 收集；
- 将核心插件装入任意未经认证的 Profile 时，启动检查失败或明确标记为 unsupported，不悄悄采用加载顺序；
- 启动时分别在测试 preset 预置普通与 prepended `approval/request` listener，确认 attestation 校验失败；ready 后再经 mutation API 尝试两种注册，确认在 Cordis graph 可见前被拒绝；模拟受控 catalog／package drift 时，mutation gate 必须先同步调用 `onTopologyInvalidated`，runtime 进入 `failed` 且 policy gate 保持安装；mutation 在 runtime dispose 撤销 contribution 前始终不可见，disposer 完成后才允许发布重配置。

## 4. 基础运行时验收

### 4.1 首次物化

1. approval hook 获得 exact live parent Agent；
2. Controller `create()` 持久预留 logical child；
3. 首次 `deliver()` armed child id、request id、content hash 与一次性 nonce；
4. `startContinuable()` 使用预留 child id 创建官方 child Session；
5. pre-step guard 只允许该初始请求进入 transcript/LLM；
6. decision tool 产生一次结构化结果。

### 4.2 复用与 cold resume

- 第二次审批通过 `followup()` 进入同一 child Session；
- idle/进程重启后，官方 continuation manager cold-resume 同一 Session；
- `registerContinuableSetup()` 重新安装 guard、模型、system prompt、唯一工具、approval/sandbox policy；
- providerData 与 reasoning effort 等配置从插件持久 catalog 恢复；
- 未知或不兼容 providerData 失败关闭并轮换 generation。

### 4.3 输入守卫矩阵

逐项投递并断言消息可以被 inbox 接受，但不会产生 `user/message` 或 LLM 请求：

- Web/Host `subagent.prompt`；
- 模型工具 `send_message`；
- `reportFrom` / settlement relay；
- 直接 `Agent.followup`；
- `Agent.steer`；
- `Agent.inject`；
- 过期、重复或内容不匹配的 armed nonce；
- 旧 generation child。

允许路径只包括 Controller 当前 armed 的请求，以及结果工具自身受控的终止流程。

## 5. 审批业务验收

1. 有效 `allow` 只在最小决策记录 durable 后映射为 `allowed-once`；
2. `deny` 在两种 mode 中都拒绝，记录写入失败也不把它下沉为可人工放行；
3. companion Profile 只有一个自动 policy slot；第二个自动 policy 无论加载顺序都注册失败。`human_review` 在 `auto-then-user` 中由 composer 调用 request-scoped `HumanApprovalPort`，在 `auto` 中拒绝；只有稳定 adapter 可以在已核验拓扑中使用 continuation，核心 policy 不接触 sibling `next()`；
4. 不支持工具、动作／卷宗能力不足、预算溢出、Reviewer 暂时故障和有限 attempt 耗尽：`auto` 为 `unavailable`，`auto-then-user` 在父请求仍活跃时下沉；
5. timeout 或正常 unload：`auto-then-user` 仅在 signal 仍活跃时下沉；用户 Stop／Abort 始终 `cancelled`；
6. reviewId、actionHash、actual Reviewer Session、generation、sidecar／snapshot 任一身份或完整性冲突都在两种 mode 中硬停止，不调用人工 port；
7. late／duplicate／tombstoned／无法安全关联的 result 无副作用且不下沉；
8. 最多两个业务 attempt 共享同一 dossier、actionHash 和总 deadline；deny、human_review、完整性冲突与 abort 不重试；
9. per-parent 串行、跨 parent 并行保持正确；
10. 下沉仍是同一次尚未执行的 DSH 工具调用；`HumanApprovalPort` 缺失、抛错或返回非法 outcome 时 composer 明确返回 `unavailable`；
11. composer outcome 与 abort signal 竞速时，审计以匹配的 `approval/decided` event 为权威；最小记录／案例不得把 composer proposal 冒充 final DSH outcome。

## 6. 卸载、重载与污染

1. 宿主只允许 `starting → ready`、`starting | ready → failed` 与 `starting | ready | failed → draining → disposed`；只有 `ready` 接受新自动审批，dispose 幂等；
2. 分别注入 gate 注册后的 startup failure 与 ready 期 fatal invariant breach：均进入 `failed`、停止自动 review、清理已拥有资源但保留 policy gate；新 `auto` 请求 unavailable，新 `auto-then-user` 请求有限下沉；`dispose(failed)` 必须经 draining 到 disposed；
3. 卸载先进入 `draining`，terminal broker 中的 policy gate 继续注册：新 `auto` 请求 unavailable，新 `auto-then-user` policy 立即返回 `delegate-human`；
4. 当前自动审查作废：活跃的 `auto-then-user` 请求由 profile composer 接管 dispatch-local 人工 port，已 abort 的请求 cancelled；pending approval 不跨 reload 恢复；
5. interrupt/drain 当前 Reviewer，并排空已经入队的安全关键 sidecar／decision-record 写任务；
6. decision tool、provider、capture hooks 和 guard 按 ownership 顺序撤销；所有插件拥有的存量 policy 调用 settle 后最后撤销自动 policy registration、幂等关闭 Storage Domain handle，profile broker／人工 terminal 继续运行；
7. 插件缺席期间尝试唤醒旧 child，确认不能产生有效审批；人工 terminal 仍可处理普通 DSH 请求；
8. 重载后扫描 provider 的全部历史 generation，但旧 pending reviewId／result channel／迟到结果均不可复用；
9. 发现未授权 transcript 变化时标记污染，旧 child 永久无 armed request；
10. 新审批创建新 result channel，必要时创建新 generation；旧 child 仍被 provider 级 fail-closed guard 覆盖；
11. 建立一个 delegated Web 人工 pending 后立即卸载插件：disposer 不等待用户作答并可完成，人工 pending 仍由 profile composer 持有，随后可正常 settle。

## 7. Web 验收

- Reviewer 出现在官方子代理树；
- 历史可查看；
- Client marker 将产品语义显示为 Managed Reviewer，同时明确底层 wire mode 仍为 continuable；
- composer 永久只读；
- 不显示 Send、附件、命令和模型选择入口；
- running 时 Stop 可用并走官方 continuable interrupt；
- 普通 one-shot/continuable 子代理 UI 不受影响；
- 刷新和 Host 重启后 marker/只读状态恢复。

## 8. 数据与导出验收

- providerData、nonce、armed state 和内部 catalog 不进入 Session export；
- Reviewer transcript 只包含已授权业务请求和模型／工具输出；
- 插件存储损坏时不恢复为可交互 Reviewer；
- action snapshot、approval snapshot、safe receipt 和最小决策记录遵守强持久化与隐私边界；
- 默认最小记录不含完整 packet、用户／项目指令、工具参数或 rationale 正文；
- `caseCapture` 默认关闭；full 模式保存的 packet 与实际 Guardian 输入 canonical 相等，并执行 canonical byte accounting、max case／artifact／total bytes、TTL、expired-first deterministic eviction、single-writer guard 和 crash reconcile；
- 四张 host-private tables 服从 exact parent deletion cascade、fork non-inheritance 和显式访问边界；完整 artifact 与最小记录无强事务指针；
- 完整案例捕获或 telemetry 失败不改变审批结果，且完整案例绝不自动进入 Session export、telemetry、Git 或测试 fixture；
- 显式案例导出经过脱敏、secret scan 和人工确认；
- 不向 Session append 外部未知 event，确保 stock persistence 可恢复。

## 9. 测试分层

```text
unit          两仓库 domain/application/guard/catalog 测试
adapter       stock DSH 真实类型和 scoped service 组合
integration   stock DSH runtime + persistence + cold resume
security      全输入旁路、重放、污染、unload 和 DoS
web smoke     bundle 加载、树、历史、只读 composer、Stop
profile       dsh plugin 安装、dump-config、重启与卸载
```

## 10. 分级完成判定

### 10.1 Profile／运行时可安装实测

只有同时满足以下条件，才可把 README 的运行状态改为“可安装实测”；这个结论只证明受控 Profile 装配和运行边界，不代表 Reviewer 已具备成熟自动审批能力：

- 两包和 thin composer adapter 均由 companion Host Profile 正确装配；
- 官方 packages 未修改且兼容版本被锁定；
- 首次审批、复用和 cold resume 通过；
- 全输入守卫矩阵通过；
- 宿主映射、abort、unload／reload 和污染轮换保持 fail-closed；
- Web 只读与 Stop 通过；
- 完整测试和 pack 校验通过。

### 10.2 自动审批产品就绪

只有在 10.1 之外同时满足以下条件，才可宣称“自动审批产品就绪”或成熟的自动审批能力：

- [当前施工计划](construction-plan.md) 的 D1、H2–H4 和 I1 退出条件全部成立；
- [Reviewer 路线图](reviewer-roadmap.md) 的 R1–R5 完成，source-backed dossier、工具语义、风险／授权 assessment 和完整 policy 已实现；
- 自动 allow 的最小决策记录 durability gate、默认关闭的 full case capture 及其保留边界通过验收；
- 风险、安全和误放行评测达到另行版本化的发布门槛。

宿主运行正确不能替代 Reviewer 语义成熟；任何 README 状态更新必须明确属于上述哪一级。
