# Patched-DSH 运行时集成验证清单（Phase 5）

> 前提：DSH checkout 位于基线 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，且工作树干净。

## 1. 应用上游补丁

```bash
cd /path/to/dsh-managed-agent
node scripts/upstream-patch.mjs apply /path/to/deepseek-harness

# 验证与应用状态
node scripts/upstream-patch.mjs check /path/to/deepseek-harness
```

补丁修改 `packages/subagent/subagent/src/{managed,types,index,descriptor,...}.ts` 等源码，并将官方 subagent 增加第三种 `managed` mode。

## 2. 从 patched DSH 构建 lib

```bash
cd /path/to/deepseek-harness
pnpm install
npm run build:lib:host     # 生成各包 lib/*.js + lib/types/*.d.ts
```

本插件所需的包：`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-user-approval`、`@deepseek-ai/dsh-sandbox-policy`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`。

## 3. 把 patched 包接入集成 fixture

推荐做法（二选一，均须锁定 commit）：

- **workspace/git 依赖**：把 `@deepseek-ai/dsh-subagent` 及其依赖替换为 patched checkout 的 `file:`／`git:` 引用，CI 中先执行第 1–2 步；
- **本地 pack**：`npm pack` patched 包到本地 tarball，`package.json` 指向 tarball。

## 4. 最小场景验收

1. plugin registration → 首次审批 → create → deliver → scoped decision tool（`tools/result` 提交）；
2. 第二次审批复用同一 Reviewer child；
3. idle release 后 cold resume 同一 Session（`materialize(source: 'resume')` 与 startup 同一 composition factory）；
4. 父 Session 恢复后使用新的 exact parent Agent（`ParentAuthority.live` 逐次派生）；
5. plugin unload／reload 后新 registration 发现旧 child（`registration.dispose()` 后重新注册同名 provider）；
6. `auto-then-user` 正确进入下游 answerer（`next()`）；
7. 官方 Web 子代理树可读、managed composer 只读、running 时 Stop 可用。

## 5. 测试分层

```text
unit          本仓库：domain + application ports（npm run check）
adapter       本仓库：真实 DSH 类型与 scoped 服务（tests/adapters/*）
integration   patched DSH runtime + persistence（D‌SH 侧 fixture，本节）
web smoke     Host/Web managed-node 路径（DSH 侧 e2e）
```

## 6. 已知事项

- `dsh-managed-agent` 的 contract 包是 `private`，当前以 `file:../dsh-managed-agent` 加入 devDependencies；跨仓库消费时应先 `npm pack` 并锁定 tarball 或 commit。
- Reviewer 的 setup 依赖 `agentCtx.systemPrompt`／`agentCtx.tools`／`agent.session`／`setApprovalPolicy`／`setSandboxMode`：任一服务缺失会直接抛错（插件不可挂载），不会降级成 composition 不完整的 Reviewer。
