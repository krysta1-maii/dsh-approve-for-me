# Stock DSH Guarded Continuable 集成验证清单

> 状态：2026-08-25，目标路线验收计划；业务插件应用迁移（Phase 3）与标准 bundle 包装（Phase 4 包侧）已完成，真实 profile 人工验收（Phase 5）尚未完成。
>
> 跨仓库施工顺序以 [`dsh-managed-agent` Guarded Continuable 无补丁改造计划](../../dsh-managed-agent/docs/guarded-continuable-migration-plan.md)为准。本文取代旧的 patched-DSH Phase 5 清单；在 Phase 5 完成前仍不能直接用于 stock DSH 产品验收。

## 1. 集成硬约束

1. 使用未修改的官方 `@deepseek-ai/dsh-*` 包和 profile；不得应用 managed patch、fork 或 `patch-package`。
2. `dsh-managed-agent` 必须作为标准 Host/Client bundle 安装并提供 `ctx.managedAgents`。
3. `dsh-approve-for-me` 必须通过 `ctx.managedAgents.registerProvider()` 注册 Reviewer，不再调用 patched `ctx.subagents.registerManagedProvider()`。
4. Session persistence 必须启用，Managed catalog/providerData 使用插件自己的持久化边界，不向 Session 写外部未知 event。
5. 未授权输入、污染、超时、模型错误、工具错误和存储错误全部失败关闭。

## 2. 构建与安装前检查

```bash
# dsh-managed-agent
npm run check
npm pack --dry-run

# dsh-approve-for-me
npm run check
npm pack --dry-run
```

两包必须具备：

- `name` / `inject` / `Config` / `apply`；
- `dsh.bundle.patch`；
- Host 入口与 Client 入口；
- 完整 `exports` 和构建产物；
- stock DSH 精确 peer 版本；
- 不含 patched DSH tarball、源码覆盖或 postinstall patch。

## 3. Profile 安装

在 DSH CLI 可找到 `pnpm` 的环境中执行本地包安装：

```bash
dsh plugin --profile web add /path/to/dsh-managed-agent
dsh plugin --profile web add /path/to/dsh-approve-for-me
```

验证：

- profile manifest 的 dependencies 包含两个包；
- `dsh.profile.bundles` 自动包含两个 bundle；
- dump-config 中 Host 插件顺序为基础插件先于审批插件；
- Client bundle 被 Web profile 收集；
- 不修改官方包内容和 lockfile resolution。

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

1. 有效 `allow` 只映射为 `allowed-once`；
2. `deny` 不放行；
3. `human_review` 在 `auto-then-user` 中调用 `next()`；
4. 无法完整捕获动作时，`auto` 拒绝、`auto-then-user` 下沉；
5. requestId、actionHash、actual Reviewer Session、deadline 任一不匹配均拒绝；
6. late/duplicate/tombstoned result 无副作用；
7. timeout、abort、模型失败、无工具调用、工具执行失败、插件卸载均不放行；
8. per-parent 串行、跨 parent 并行保持正确。

## 6. 卸载、重载与污染

1. 卸载先停止接受审批并 disarm pending request；
2. interrupt/drain 当前 Reviewer；
3. decision tool、answerer、provider 和 guard 按 effect 顺序撤销；
4. 插件缺席期间尝试唤醒旧 child，确认不能产生有效审批；
5. 重载后扫描 provider 的全部历史 generation；
6. 发现未授权 transcript 变化时标记污染，旧 child 永久无 armed request；
7. 新审批创建新 generation，旧 child 仍被 provider 级 fail-closed guard 覆盖。

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
- Reviewer transcript 只包含已授权业务请求和模型/工具输出；
- 插件存储损坏时不恢复为可交互 Reviewer；
- action snapshot 和审批结果遵守既定审计与隐私边界；
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

## 10. 完成判定

只有同时满足以下条件才可把 README 状态改为“可安装实测”：

- 两包均可通过标准 DSH bundle 安装；
- 官方包未修改；
- 首次审批、复用和 cold resume 通过；
- 全输入守卫矩阵通过；
- 所有失败路径保持 fail-closed；
- unload/reload 和污染轮换通过；
- Web 只读与 Stop 通过；
- 完整测试和 pack 校验通过。
