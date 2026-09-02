# dsh-user-approval fork（dsh-approve-for-me patch）

对官方 `@deepseek-ai/dsh-user-approval` 的最小修改，作为 `dsh-approve-for-me` 的第三方 patch 交付。

## 为什么保留原名和版本

DSH 内部有 20+ 处按模块名解析 `@deepseek-ai/dsh-user-approval`（含 `.../types` 子路径和 Cordis Context 增强）。因此：

- `package.json` 的 `name` / `version` **必须**与上游一致；
- 第三方身份通过 `dshApprovalPatch` 标记字段、重命名 tarball 和本 README 表达；
- 该 tarball 是官方包在锁定版本上的 drop-in 替换。

## 修改内容

| 变更 | 位置 | 说明 |
|---|---|---|
| `requestId` | `ApprovalRequestEvent` | `ApprovalService.request()` 把已生成的 ask id 传给机器策略与 answerer，消除 callId+reason 启发式关联 |
| `registerMachinePolicy()` | `ApprovalService` | `never` 之后、`approval/request` waterfall 之前的全局独占机器决策槽；唯一 policy 的非 `'delegate'` 结果认领请求；异常 fail-closed `unavailable`；disposer 支持卸载 |

未注册机器策略时行为与上游完全一致。

## 目录

```text
upstream.json                        # 锁定的上游 tag/commit 与 patch 版本
overlay/src/index.ts                 # 上游 src 的覆盖文件（含 patch）
overlay/src/types.ts
overlay/src/invariant.ts             # 未修改，保留覆盖以显式声明不漂移
overlay/tests/approval-machine-policy.spec.ts
scripts/build-fork.sh                # 生成 fork tarball
scripts/mark-package.mjs             # 写入 dshApprovalPatch 标记
scripts/verify-fork.mjs              # 校验 tarball 的 name/version/标记/已编译 API
scripts/verify-target-host.mjs        # 校验目标 DSH commit/tag、tarball 和可选 Profile 安装位置
```

## 构建

前置条件：sibling 目录有 `deepseek-harness`，其对象库**包含** `upstream.json` 中完整 40 位 commit（HEAD 可指向任意位置）；可用 `pnpm`。构建脚本拒绝短 SHA，并只在该精确 commit 上构建。

```bash
patch/dsh-user-approval/scripts/build-fork.sh
# 产物：.build/dsh-user-approval-afm-0.1.2-alpha.5.tgz
```

脚本在一次性 clone（`.build/upstream-clone`）中 detach 到锁定 commit，覆盖源码、运行 overlay 测试、重建 `lib/`、打标记、校验并输出 `.sha256`，构建结束删除该 clone。上游 checkout 全程只被读取（`git clone`），不注册 worktree，也不写入其 index/config。`SKIP_BUILD=1` 被明确拒绝，因为它不能证明编译产物包含 patch。

## 安装与校验

```bash
# 先在本仓库验证构建产物
npm run build:approval-fork
npm run verify:approval-fork

# 再由目标 Profile 安装器把同一 tarball 替换到
# @deepseek-ai/dsh-user-approval；安装后必须重新读取安装位置的
# package.json 并校验 dshApprovalPatch marker、patchVersion、完整 upstreamCommit。
# 不要把本仓库的 node_modules、全局安装的 DSH CLI 或另起的 Web server
# 当成目标 Profile 验收。
```

## 上游跟进

当前锁定：`upstreamVersion 0.1.2-alpha.5`、`upstreamTag dsh-v0.1.2-alpha.5`、`upstreamCommit db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`、`patchVersion 3`；patch 语义与上一版本一致，本版上游增量是 Session 日志读取从 `session.events` 迁到 `snapshotEvents()`/`eventAt()`（overlay 的 `index.ts`/`invariant.ts` 以 alpha.5 源码为底座重打，`types.ts` 无上游变更）。

上游版本变化时：更新 `upstream.json` 的 tag/commit/version，重放 overlay，重跑构建脚本；`build-fork.sh` 会拒绝在错误 commit 上构建。目标是把这两个改动作为上游 PR 合并，合并后本目录只保留记录、不再产出 tarball。

## 许可

上游代码为 MIT，保留其 LICENSE；本 patch 的增量修改同样以 MIT 发布。本包不是 deepseek-ai 官方发布物。
