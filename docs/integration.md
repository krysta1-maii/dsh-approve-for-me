# Patched DSH 0.1.2 + 机器决策槽 集成验证清单

> 状态：2026-08-28，目标验收计划（v2）。patch 包结构已成形；0.1.2 迁移、本体机器策略接入与真实 Profile／Web 验收尚未完成。
>
> 宿主组合与失败语义以 [宿主契约](host-contract.md) 为准，卷宗事实以 [卷宗规范](guardian-dossier.md) 为准，施工顺序见 [当前施工计划](construction-plan.md)。本文只定义验收，不定义新接口。

## 1. 集成硬约束

1. stock DSH 0.1.2-alpha.1 除 `@deepseek-ai/dsh-user-approval` 外不修改；该包由本仓库 `patch/` 产出 fork tarball 替换。
2. fork tarball 保留上游 `name`/`version`，带 `dshApprovalPatch` 标记；`verify-fork.mjs` 全部通过。
3. `dsh-managed-agent` 作为独立插件先安装，提供 `ctx.managedAgents`；本插件通过 peerDependencies 声明依赖。
4. 本体通过 `ctx.approval.registerMachinePolicy()` 注册唯一机器策略；不依赖 `approval/request` listener 顺序做自动裁决。
5. 人工兜底走官方 `api-remotes → client/ui-approval`；approve-for-me 会话不 compose ACP 机器桥（或明确接受其只影响 delegate 链）。
6. 未授权输入、污染、超时、模型错误、工具错误和存储错误全部失败关闭。

## 2. 构建与安装前检查

```bash
# 本仓库
npm run check
patch/dsh-user-approval/scripts/build-fork.sh
node patch/dsh-user-approval/scripts/verify-fork.mjs \
  .build/dsh-user-approval-afm-0.1.2-alpha.1.tgz \
  patch/dsh-user-approval/upstream.json

# 依赖插件仓库
npm run check
npm pack --dry-run
```

两插件共同必须具备：`name`/`inject`/`Config`/`apply`、`dsh.bundle.patch`、完整 `exports` 和构建产物；本体还要求 README/tarball 声明官方包 fork 与 MIT 归属。

## 3. 目标 Profile 装配

```bash
# 1) fork 覆盖官方审批包（安装器执行，并校验 dshApprovalPatch 标记）
# 2) 依赖插件
dsh plugin --profile <profile> add /path/to/dsh-managed-agent
# 3) 本体插件
dsh plugin --profile <profile> add /path/to/dsh-approve-for-me
```

验证：

- Profile 中 `@deepseek-ai/dsh-user-approval` 解析到 fork（标记字段 + 冒烟 `registerMachinePolicy` 存在）；
- `dsh --profile <profile> --dump-config` 显示两插件；
- `ctx.managedAgents` 服务可用；
- Reviewer provider/model/generation/policyVersion/toolsetVersion 显式存在，非法配置在注册前失败；
- 未 patch/官方同名包误装时本体拒绝挂载。

## 4. 基础运行时验收

### 4.1 首次物化

1. `approval/request` 到达机器策略且 `requestId` 与 `approval/asked.id` 一致；
2. Controller `create()` 持久预留 child；首次 `deliver()` armed 身份/内容 hash/nonce；
3. pre-step guard 只允许初始请求；decision tool 产生一次结构化结果。

### 4.2 复用与 cold resume

- 第二次审批 `followup()` 进入同一 child Session；
- 重启后 continuation manager cold-resume 同一 Session 并重装 guard/model/tools/policy；
- 未知或不兼容 providerData 失败关闭并轮换 generation。

### 4.3 输入守卫矩阵

与 v1 相同：Web/Host prompt、`send_message`、settlement relay、直接 followup/steer/inject、过期/重复 nonce、旧 generation child 全部不能进入 transcript；允许路径只包括 armed 请求与结果工具自身。

## 5. 机器决策槽验收

1. 注册一个抢答 `allowed-once` 的 prepend `approval/request` listener：机器策略返回 `rejected`，请求结果为 `rejected` 且 listener 未被调用；
2. `never` 会话：机器策略不被调用，结果 `rejected`；
3. `'delegate'`：下一机器策略和 waterfall 依次执行；到达 `ui-approval`；
4. 重复 `id` 注册抛错；disposer 后请求恢复 fail-closed `unavailable`；
5. 机器策略抛错或返回非法值 → `unavailable`；
6. abort 竞速：信号取消后迟到的机器策略结果被丢弃，审计为 `cancelled`。

## 6. 审批业务验收

1. `trustEnvelope` 命中：包络内动作 `allowed-once`，0 次 LLM、0 次人工；
2. 包络外：走 Guardian；`deny` 两种 mode 都拒绝；`human_review` 在 `auto` 拒绝、在 `auto-then-user` 下沉；
3. deny breaker 只命中同 lifecycle/turn/frontier/`actionHash`；命中不调 Guardian、仍 `rejected`；
4. 身份/requestId/actionHash/generation/source 冲突在两种 mode 都不 delegate；
5. 自动 allow 在最小记录 durable 前不生效；记录冲突不 delegate；
6. 最多两个业务 attempts、单 deadline、迟到/重复/旧 generation 结果无副作用；
7. per-parent 串行、跨 parent 并行。

## 7. 卸载、重载与污染

1. `starting|ready → failed`、`starting|ready|failed → draining → disposed`；dispose 幂等；
2. `draining` 中 machine policy 保持注册：新 auto 请求 unavailable，auto-then-user 在 signal 活跃时 delegate；
3. `failed` 不 delegate；卸载先 settle 后撤销 machine policy 注册；
4. 卸载期间建立的人工 pending 由 Profile 交互链继续，不阻塞 dispose；
5. 污染 child 永久无 armed request；rotate 恢复不延长 deadline、不算业务 attempt；
6. 重载后旧 pending/reviewId/迟到结果不可复用。

## 8. Web 验收

- Reviewer 出现在官方子代理树，只读 composer + Stop 由 `dsh-managed-agent` Client bundle 提供；
- 审批面板（`ui-approval`）仅在 `delegate` 时出现；
- 刷新/重启后 marker 与只读状态恢复。

## 9. 数据与导出验收

- `executions`/`approval_snapshots`/`review_records`/`case_artifacts` 遵守强持久化与隐私边界；
- 默认最小记录不含 packet、用户/指令/参数或 rationale 正文；`caseCapture` 默认关闭；
- artifact 丢失/过期不改变历史审批或父 Session 恢复；
- 显式导出经过脱敏、secret scan、人工确认。

## 10. 分级完成判定

### 10.1 可安装实测

- fork 构建/校验通过；两插件在目标 Profile 正确装配；
- 首次审批、复用、cold resume、输入守卫矩阵通过；
- 机器决策槽与模式映射全部分支通过；
- 卸载/重载/污染 fail-closed；Web 审批与 Stop 通过。

### 10.2 自动审批产品就绪

在 10.1 之外：D1、P2、H4 与 I1 退出条件全部成立；Reviewer 路线图 R1–R5 完成；长程 soak 包络内 0 人工、0 误放行；风险/安全评测达到另行版本化的发布门槛。宿主运行正确不能替代 Reviewer 语义成熟。
