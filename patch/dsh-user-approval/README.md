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
| `registerMachinePolicy()` | `ApprovalService` | `never` 之后、`approval/request` waterfall 之前的确定性机器决策槽；首个非 `'delegate'` 结果认领请求；异常 fail-closed `unavailable`；disposer 支持卸载 |

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
```

## 构建

前置条件：sibling 目录有 `deepseek-harness` 且 HEAD 等于 `upstream.json` 的 commit；可用 `pnpm`。

```bash
patch/dsh-user-approval/scripts/build-fork.sh
# 产物：.build/dsh-user-approval-afm-0.1.2-alpha.1.tgz
```

脚本在临时 worktree 中覆盖源码、重建 `lib/`、打标记并校验，不污染上游 checkout。

## 安装与校验

```bash
# 用 fork tarball 覆盖 profile 依赖中的官方包（由安装器执行）
npm install -D --force .build/dsh-user-approval-afm-0.1.2-alpha.1.tgz
node patch/dsh-user-approval/scripts/verify-fork.mjs \
  .build/dsh-user-approval-afm-0.1.2-alpha.1.tgz \
  patch/dsh-user-approval/upstream.json
```

## 上游跟进

上游版本变化时：更新 `upstream.json` 的 tag/commit/version，重放 overlay，重跑构建脚本；`build-fork.sh` 会拒绝在错误 commit 上构建。目标是把这两个改动作为上游 PR 合并，合并后本目录只保留记录、不再产出 tarball。

## 许可

上游代码为 MIT，保留其 LICENSE；本 patch 的增量修改同样以 MIT 发布。本包不是 deepseek-ai 官方发布物。
