# dsh-approve-for-me 当前施工计划

> 状态：2026-08-28。本文从当前代码基线出发安排后续实现，不再保留 patched-DSH 施工方案。旧计划已归档至 [`archive/construction-plan-2026-08-25.md`](archive/construction-plan-2026-08-25.md)。文档职责和权威顺序见 [文档地图](README.md)。

## 1. 施工目标

将当前“协议与运行骨架”建设为可在受控 DSH Web Profile 中验收的自动审批产品，同时保持以下边界：

- 不修改官方 `@deepseek-ai/dsh-*` 插件族；
- 通过 `dsh-managed-agent` 的 `ctx.managedAgents` 管理隔离 Reviewer；
- 由配套 Host Profile 组合唯一自动 policy 和 stock Web 人工审批；
- 只有 source-verified 卷宗、合法 Reviewer 结果和 durable 决策事实可以产生 `allowed-once`；
- 身份、hash、generation、事实完整性和协议冲突始终失败关闭。

完整语义分别由 [宿主契约](host-contract.md) 与 [卷宗规范](guardian-dossier.md) 定义，本文不重复其接口。

## 2. 当前基线

### 已完成

- companion `dsh-managed-agent` 的 `ctx.managedAgents.registerProvider()` 接入；
- providerData、ActionSnapshot、`actionHash` 与 ApprovalDecision 协议；
- 一次性 decision channel、deadline、abort、tombstone；
- per-parent lane 与 Managed Reviewer create／reuse／污染轮换；
- Reviewer composition、唯一 scoped decision tool、`approval=never`、`sandbox=read-only`；
- `tools/pre-execute` 动作捕获骨架；
- 标准 DSH bundle 包装；
- 宿主 v1 和 Guardian 卷宗 v1 候选接口。

### 尚未完成

- 配套 Host Profile 与稳定的 thin approval-composer adapter；
- 当前 sibling approval answerer 向 `ApprovalPolicyContributionV1` 的迁移；
- source-backed dossier compiler 和 Storage Domain fact adapters；
- 完整错误分类、双 attempt、精确拒绝熔断；
- 最小决策记录与 opt-in full case capture；
- 完整风险／授权 policy；
- 真实 Profile、Web、cold resume、HMR 和卸载验收。

当前代码事实的逐文件清单见 [implementation.md](implementation.md)。

## 3. v1 部署组成

v1 将以下内容视为一个不可拆分的受支持部署：

```text
未修改的 stock DSH packages（锁定兼容版本）
+ dsh-managed-agent Host/Client bundle
+ dsh-approve-for-me Guardian policy bundle
+ companion Host Profile
+ profile-owned thin approval-composer adapter
```

### 3.1 Host Profile，不是 Agent Preset

Host Profile 负责 Host-plane Cordis 插件图、审批 listener 拓扑、稳定 adapter 生命周期和版本锁定。Agent Preset 是 agent-scoped Cordis composition，虽可包含特权插件，但不能拥有或向 Host consumers 发布这里要求的进程稳定 exclusive 审批拓扑，因此不是该前置设施的替代品。

### 3.2 不修改官方插件族的兼容桥

DSH `0.1.1-rc.2` 的 Web 人工审批仍是 `dsh-host-apiproxy` 内部 sibling listener，没有公开 callable human service。v1 不读取其 private pending registry，也不复制 Web RPC；配套 Profile 提供一个稳定 adapter：

1. adapter 作为 Profile 自有组件，不随 Guardian policy HMR 卸载；
2. adapter 持有唯一自动 policy slot；
3. policy 返回 `delegate-human` 时，adapter 将当前请求的 continuation 包装成 request-scoped `HumanApprovalPort`；
4. Profile 固定 adapter 与 stock Web human listener 的拓扑，禁止其他自动 approval sibling 插入；
5. 该兼容桥只在锁定版本和真实 Profile 验收后成立，不推广为 DSH 通用 listener-priority 契约。

未来若 DSH 正式公开 terminal composer／human port，Profile adapter 可以替换，Guardian policy、卷宗和应用层接口不变。

## 4. 实施阶段

### H1：Companion Profile 与 composer adapter

交付：

- Host Profile 配置／bundle；
- 稳定 `TerminalApprovalComposerPortV1` 实现；
- request-scoped `HumanApprovalPortV1` 兼容桥；
- exclusive policy slot、重复注册失败和显式 deployment default；
- DSH 版本、Host listener 图与 Agent Preset catalog 的 topology attestation；
- 禁用可变／用户 preset roots 与 preset HMR，allowlist 审计确保 preset 不注册 approval listener；
- Profile-owned 原子 topology mutation gate 与同步 `onTopologyInvalidated` callback；
- adapter 独立于 Guardian HMR 的生命周期测试。

退出条件：`auto` 和 `auto-then-user` 的所有路径均由受控 Profile 决定；核心插件不再直接注册 sibling approval answerer。任意未知 Profile 默认不宣称受支持。

### H2：宿主 policy 与生命周期迁移

交付：

- `approval-answerer.ts` 改造成 `ApprovalPolicyContributionV1` adapter；
- `starting → ready`、`starting | ready → failed`、`starting | ready | failed → draining → disposed` 状态机；
- 完整错误分类与模式映射；
- pending approval 不跨 reload；
- 插件 disposer 不等待 profile-owned 人工作答；
- Storage Domain handle 的 open／drain／close ownership。

退出条件：宿主契约第 8、10、14 节的分支和 race 测试全部通过。

### D1：事实源与卷宗 compiler

交付：

- parent Session fact source；
- action projection、approval snapshot、safe receipt 的 Storage Domain sidecar；
- root-principal／delegation-envelope ledger；
- direct child-origin output 的 source-boundary 排除；
- 五段式 immutable dossier 与 source-verified brand；
- 完整性、预算和基线指标。

退出条件：卷宗规范第 16 节测试成立；缺失、漂移或损坏事实不能产生 ready dossier。

### H3：Review Run、attempt 与精确熔断

交付：

- 不可变 `reviewRunId` 与每 attempt 唯一 `reviewId`；
- 单一总 deadline、最多两个业务 attempts；
- 污染恢复与业务 attempt 分离审计；
- 只对同 parent lifecycle／turn／user frontier／`actionHash` 的 Guardian deny 熔断。

退出条件：安全判断不重试，迟到／旧 generation 结果无副作用；语义等价和跨工具关系不进入 v1 验收。

### H4：决策事实与案例留存

交付：

- `review_records` 最小决策记录；
- 自动 allow 前的 durability gate；
- `caseCapture.mode: full` 的 canonical artifact；
- deterministic quota／TTL／GC／single-writer reconcile；
- host-private 访问、parent deletion cascade 与显式脱敏导出；
- telemetry 与安全事实分离。

退出条件：默认不保存完整 packet；案例或 telemetry 写入失败不改变既有 deny／fallback，且绝不能绕过 allow 的最小记录门槛。

### RP：Reviewer 产品能力主线

沿用 [Reviewer 独立实现路线](reviewer-roadmap.md) 的 R1–R9 里程碑；本节只表示整条产品主线，不重新编号。依次完成：

1. tool-family action semantics；
2. risk taxonomy；
3. user authorization assessment；
4. 完整 policy 与 decision assessment；
5. 审计指标和安全评测。

full/delta transport、调查工具和语义等价熔断仍是可选后续项，不阻塞 v1。

### I1：真实集成验收

按 [integration.md](integration.md) 在锁定的 stock DSH + companion Profile 上验证：

- 首次物化、复用、cold resume；
- 自动／人工映射和 Abort 竞速；
- 全输入守卫；
- HMR、卸载、污染轮换；
- Storage Domain durability 与删除规则；
- Web 只读 Reviewer、历史和 Stop；
- pack、安装、dump-config 与重启。

## 5. 依赖关系

```text
H1 Companion Profile ──→ H2 Host policy/lifecycle ──┐
                                                    ├─→ H3 Attempts/breaker ─→ H4 Records/cases ─→ I1
D1 Fact sources/dossier ────────────────────────────┘
                    └─→ RP Reviewer product line ──────────────────────────────┘
```

H1 与 D1 可以并行。H3 必须同时建立在可用的 composer 和 source-verified dossier 上。RP 直接引用 [Reviewer 路线图](reviewer-roadmap.md) 的 R1–R9，不另造同名阶段；I1 的最终产品结论还要求其中 R1–R5 的上下文、风险／授权与完整 policy 完成，不能用宿主运行正确掩盖 Reviewer 语义尚未成熟。

## 6. 每阶段完成纪律

每个阶段至少需要：

1. 版本化接口与不变量；
2. 对官方 DSH API 的真实类型适配；
3. 正常、失败和对抗性测试；
4. `npm run check` 与文档代码块／链接检查；
5. 更新 `implementation.md` 的已实现事实；
6. 若契约变化，先更新对应权威文档，再更新共识摘要；
7. 一次边界清楚的 Git 提交。

## 7. 当前施工入口

下一步从 **H1 Companion Profile 与 composer adapter** 开始，同时可以并行启动 **D1 Fact sources/dossier**。在 H1 完成前，现有 `dsh plugin --profile web add` 只能用于骨架开发，不构成产品级 `auto-then-user` 部署。
