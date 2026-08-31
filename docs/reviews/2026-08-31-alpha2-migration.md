# alpha.2 迁移与供应链重构（2026-08-31）

以代码为第一事实的复查 + 迁移记录。范围：`dsh-approve-for-me` 与 sibling `dsh-managed-agent`；参照仓库 `deepseek-harness` 只读。

## 1. 触发事实

- 本机 `../deepseek-harness` 已前进到 `0.1.2-alpha.2`（commit `0a53fb55bea101816fa226bb964ae2bed71c343b`，tag `dsh-v0.1.2-alpha.2`）。
- 迁移前的仓库把宿主固定在 `0.1.2-alpha.1` / `cd5ef814…`，因此 `verify:target-host`、`bootstrap:target-host`、`profile:artifact-smoke` 在当前 checkout 上全部 fail-closed（"host version mismatch: expected 0.1.2-alpha.1, got 0.1.2-alpha.2"），而 `npm run check`（41 files / 324 tests）、`package:smoke`、`verify:approval-fork` 仍然通过。
- `0.1.2-alpha.2` 已发布到 npm（dist-tag `alpha`）；`0.1.2-alpha.1` 从未发布。自建宿主 artifact 闭包在 alpha.1 时代是唯一取得精确宿主包的方式，这个前提已经不成立。

## 2. 决策

宿主闭包改为消费 registry 上已发布的 `0.1.2-alpha.2`，可复现性锚点由本地 `target-host-artifacts.lock.json` 换成 `pnpm-lock.yaml` 的 integrity 摘要。理由：

- 与真实部署一致（`dsh plugin add` 装的就是这些包），不再有"本地重打包结果与用户实际安装物不同"的风险面；
- 删除了 `bootstrap-target-host.mjs` 中 `build:lib:host` 失败只 `console.warn` 再继续打包的 fail-open 路径，以及 `--refresh` 无对照重新基线（TOFU）的问题；
- 不再需要为了取依赖而在官方仓库里安装/构建。

approval fork 仍然是唯一从宿主**源码**构建的产物（官方包没有 `registerMachinePolicy()`），但构建位置从"在上游 checkout 里注册 git worktree"改为"一次性 `git clone` 到 `.build/upstream-clone`"：官方仓库全程只被读取。迁移完成后 `git -C ../deepseek-harness status --porcelain` 为 0 行、`git worktree list` 只有主工作树。

## 3. 代码层面的 alpha.1 → alpha.2 破坏性变更

对这两个插件真正生效的只有一处：`JsonValue` 从 `@deepseek-ai/dsh-session` 移到新包 `@deepseek-ai/dsh-util-values`（`dsh-managed-agent` 的 `src/storage.ts`、`src/contracts.ts`、`tests/contracts.spec.ts` 三处 import）。`dsh-approve-for-me` 的 `src/` 无需任何改动即通过 alpha.2 类型检查。

其余 alpha.2 变更已核对但不影响本仓库现有用法：`deepFreeze`/`assertNever` 迁到 `dsh-util-values`、`FIRST_PARTY_SECTION_ORDER`/`PERSONA_ORDER` 改为 `systemPrompt.getSectionOrder()`/`getContextOrder()`、`effectiveSandboxMode` 不再从 `dsh-sandbox-policy` 导出、`SubagentControlError` 改为 typert `RemoteError`、`SessionEvent.ignorable?: true` 被保留为外部插件事件的持久化兼容机制。

fork overlay 只需并入上游在该包内的唯一改动：`order: 115` → `scope.systemPrompt.getContextOrder('APPROVAL_POLICY')`。patch 语义未变，`patchVersion` 保持 2。

## 4. 变更清单

- 两仓库：删除 `scripts/bootstrap-target-host.mjs`、`target-host-artifacts.lock.json`、`file:.artifacts` devDependency 与 pnpm-workspace override 清单；peer/dev 依赖改为 `0.1.2-alpha.2`（`cordis` 4.0.2、`schemastery` 3.18.2）。
- `pnpm-workspace.yaml`：`autoInstallPeers: true` + `strictPeerDependencies: true`，仅保留把 `@deepseek-ai/dsh-user-approval` 指到 fork tarball 的两条 override。
- `build-fork.sh`：throwaway clone；上游只需**包含**锁定 commit（HEAD 可在别处）。
- `profile-artifact-smoke.mjs`：改为把已发布的 `@deepseek-ai/dsh@0.1.2-alpha.2` CLI 装到一次性 prefix，不再需要 harness checkout 或其构建产物。
- `verify-target-install.mjs`：期望值改为 alpha.2，fork marker 与 `upstream.json` 联动而不是硬编码 commit。
- stock 语义标识随宿主基线更新：`DSH_ALPHA1_*` → `DSH_ALPHA2_*`，`argumentSemanticsId` = `dsh-0.1.2-alpha.2-stock-v1`（该值进入 catalog 指纹，因此旧的 allow-cache/decision record 自然失效，这是期望行为）。
- CI：三条 lane 重写为"npm 闭包 + 仅 fork 需要 harness checkout"，actions 全部 SHA 固定，Node 统一 24，fork 相关 checkout 加 `fetch-depth: 0`（`verify-target-host` 要求 exact tag）。

## 5. 本次实际跑通的验证

| 验证 | 结果 |
| --- | --- |
| `dsh-managed-agent` `npm run check` | 9 files / 41 tests 通过 |
| `dsh-approve-for-me` `npm run check` | 41 files / 324 tests 通过 |
| `verify:managed-source` | 通过（reviewed lock 已刷新为 `c826018743…`，49 files） |
| `verify:approval-fork` / `verify:target-host` | 通过（fork v2 @ `0a53fb55…`，tag `dsh-v0.1.2-alpha.2`） |
| `verify:installed-target-host` | 通过（整条闭包解析为 alpha.2 + fork marker + `registerMachinePolicy()`） |
| 两仓库 `package:smoke` | 通过（238 / 65 entries） |
| `profile:artifact-smoke` | 通过：真实 Profile 安装 + boot，`/approve-for-me` 授权动作自动放行并真实执行 `bash` 副作用；`auto-then-user` 下沉被人工通道拒绝且命令未执行；杀进程冷重启后 25 个 effective tool 完全一致 |
| `pnpm install --frozen-lockfile`（两仓库） | 通过 |
| 官方 harness 仓库 | `git status` 0 行，无额外 worktree |

`dsh-managed-agent` 已提交 `9990c94`，因此本次 `artifact.json` 首次记录 `dirty: false`。

## 6. 仍未验证（不得当作已具备）

1. 真实 LLM Guardian 的 allow/deny/human_review（Profile smoke 里的 Guardian 是脚本化 adapter，只回放 source-derived baseline）；
2. 浏览器审批面板的人工点击链路；
3. 带 pending approval / Reviewer child 状态的跨进程 cold-resume（当前只验证了无 pending 状态的冷重启）；
4. deadline、污染、renew、卸载/重载的并发与故障注入；长程 soak。

## 7. 复查中记录的既有缺口（未在本次修改）

- `DefaultDossierCompiler` 把 `pending.confinement` 固定写成 `unconfined-composition`，因此 `projectDossierTrustEnvelopeV1` 永远返回 `undefined`，gate 的 trust-envelope 快路径对已编译卷宗不可达（默认 `enabled: false`，无放行风险，但该配置项目前是无效开关）。
- `completeness.complete` 恒为 `true`，其后的守卫为空转。
- 编译器不要求卷宗内存在任何 direct-user 消息；"无 direct-user 不产生 facts"实际只由 `DossierGateFactProjector` 的 frontier 检查保证，且该分支没有对应测试。
- `package.json` 的 `files` 整包发布 `docs/`（含内部 review 文档），`package-smoke` 的泄漏正则不覆盖 `docs/`。
- `DshStorageDomainGateDecisionRecordStore` 对完全相同的既存行返回 `confirmed`（幂等重放），并非严格一次性。
