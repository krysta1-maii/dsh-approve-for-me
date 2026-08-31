# 2026-08-31 实现审查与加固报告

> 审查对象：`dsh-approve-for-me`（本仓库，工作区当前状态）与 sibling `dsh-managed-agent`。
> 兼容对象：`../deepseek-harness` @ `dsh-v0.1.2-alpha.1` / `cd5ef8148158c3a752a658978873241fdf8e2bbc`（全程只读，未修改）。
> 运行约束：所有验证使用一次性临时 `DSH_HOME`，未影响正在运行的 dsh 实例。

## 1. 结论摘要

当前实现已到达 **dsh@0.1.2-alpha.1 真机集成基线**：机器决策槽 v2、scoped effective tool catalog、source-backed dossier、R4 基线、Storage Domain 决策行与事实侧车、Reviewer deadline/attempts/污染轮换语义均已落地并通过可复现验证。

本次审查修复了：

- 本机 corepack 包装器损坏导致 bootstrap/package/profile smoke 全部无法运行的阻断级问题；
- `actions/checkout` `path: ../` 布局非法与 managed-agent 仓库名大小写错误；
- durable sidecar 校验缺口与“污染 sidecar 可伪造 result 事件身份”的安全问题；
- `session/event` observer 的未处理 rejection、schema 指纹额外字段、轨迹校验器未接线、budget-overflow 下沉契约不符；
- 多份文档的过期状态与实现不一致。

发布前仍未完成：真实 LLM Guardian/Web 面板/跨进程 cold-resume E2E，以及 `dsh-managed-agent` 干净提交后的 source lock 刷新（`artifact.json.dirty` 必须为 `false`）。

## 2. 验证矩阵

| 验证 | 结果 |
|---|---|
| `npm run check`（本仓库） | 41 个测试文件 / 324 项测试 + build 通过 |
| `npm run check`（dsh-managed-agent） | 9 个测试文件 / 41 项测试 + build 通过 |
| `verify:target-host` / `verify:installed-target-host` | fork v2 + exact 0.1.2-alpha.1 安装闭包 PASS |
| `bootstrap:target-host`（`DSH_SKIP_BUILD=1`，只读宿主） | 75 个宿主 artifact 与 `target-host-artifacts.lock.json` 逐项一致 |
| `verify:managed-source` | sibling source tree 摘要 = reviewed lock（51 files） |
| `package:smoke`（两个仓库） | tarball 内容、泄漏与身份检查 PASS |
| `profile:artifact-smoke` | 真实 `dsh plugin add` 安装、Cordis compose、自动放行真实 side effect、human fallback 拒绝、全新进程重启目录一致（25 个 effective tools） |
| `pnpm install --frozen-lockfile --offline` / `pnpm peers check` | PASS / 无 peer 问题 |
| `git diff --check`（两个仓库） | 无空白错误 |
| `../deepseek-harness` | `git status` 始终干净，HEAD 未变 |

## 3. 修复明细

### 3.1 工具链与可复现性

1. **pnpm 解析（阻断级）**：本机 corepack 包装器报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，导致 `package:smoke`、`build:managed-artifact`、`bootstrap:*`、`profile:artifact-smoke` 全部失败。新增 `scripts/lib/pnpm.mjs`，解析顺序：`PNPM` env → PATH `pnpm`（解析为绝对路径避免 shim 递归）→ `corepack pnpm` → corepack 缓存中的 `pnpm.cjs`（优先 `packageManager` 固定的 11.7.0）。两个仓库的 Node 脚本与 `patch/dsh-user-approval/scripts/build-fork.sh` 均已接入。
2. **managed source lock 刷新**：接入 helper 后刷新 `managed-agent-source.lock.json`（51 files / `6ac4bc1b…`）并重建 `.artifacts/managed-agent`（tarball sha256 `1afeb53c…`）。

### 3.2 安全加固

3. **`DshStorageDomainFactRepositories.validExecution` 校验缺口（high）**：补齐 code-dispatch 请求的 `rootCallId/parentCallId/rootRequestEventSeq/parentRequestEventSeq/arguments` 校验、`request.kind` 与 `request.eventType` 配对，并用 `parseActionSnapshot + hashAction` 重算 `projection.actionHash`。新增回归测试。
4. **污染 sidecar 伪造 result 事件身份（high）**：`DshParentSessionFactSource` 现在把每个 durable execution fact 与 canonical live session 事件逐字段绑定——native `tool/result` 校验 `sourceEventSeqs`/`source.callId`/`toolCallId`，code-dispatch 校验 `rootCallId/parentCallId/subCallId/name`；身份不符即从 frozen snapshot 丢弃，dossier 因此不完整并 fail closed。新增回归测试。
5. **`session/event` observer 的未处理 rejection（medium）**：`observeSessionEvent` 失败可能击穿 Node 进程；`plugin.ts` 现在显式 `.catch()`。
6. **schema 指纹顶层额外字段（low）**：`effectiveToolBindingFromSchemaV1` 只接受 `{name, description, parameters}`，避免 wire/callable 携带未知顶层字段仍被判为同一 schema。
7. **轨迹不变量未在编译出口生效（low）**：`DefaultDossierCompiler` 现在在 seal 前调用 `validateToolTrajectorySection`；并修正 validator 对同一 assistant message 内复用 callId、不同 call event seq 的误判。
8. **budget-overflow 与 host-contract 不符**：dossier 超预算现在在 `auto-then-user` 下经 `GateFailure('retryable-capability')` 下沉官方人工瀑布，`auto` 仍 unavailable。

### 3.3 CI

9. `actions/checkout` 的 `path` 必须在 `$GITHUB_WORKSPACE` 内：修正两个 `artifact-lane.yml` 的 `path: ../…`，改为三仓库平铺布局；修正 dsh-managed-agent workflow 的 `deepseek-ai/DeepSeek-Harness` 大小写。managed-agent `main` 漂移会由 reviewed source lock 挡下，不会静默升级。

### 3.4 文档同步

- `docs/implementation.md`：整篇更新到当前实现状态（alpha.1 基线、324 项测试、Profile smoke 证据、遗留 E2E）。
- `docs/integration.md`：测试计数 324；`profile:artifact-smoke` 的 env 说明改为实际的 `MANAGED_AGENT_ARTIFACT_DIR`；catalog 等价规则改为“按 `toolName → toolSchemaFingerprint` 集合一致（顺序可不同），PTC wire 为 `[run_code]`”。
- `docs/host-contract.md`：Storage Domain 命名更新为实际的 `approve_for_me`（facts）+ `afm_decision_records`（决策行）；trustEnvelope 当前因 environment projector 未接线而恒为 outside 的 fail-closed 状态；代码差距节更新。
- `docs/guardian-dossier.md`：Code Mode dispatch 已接入的过期说明更新。
- 根 `README.md`：测试计数 324。

## 4. 剩余风险与发布阻塞

1. **dsh-managed-agent 未提交干净 commit**：当前 `artifact.json.dirty: true`，且 `managed-agent-source.lock.json` 对应本地工作树。发布前必须提交已审查 commit，并以该 commit 的 clean tree digest 刷新 lock；CI 会按设计拒绝任何不匹配的 `main`。
2. **产品级 E2E 未执行**：真实 LLM Guardian 的 allow/deny/human_review、官方 Web approval panel、pending approval/Reviewer child 的彻底杀进程 cold-resume、污染/renew/deadline/卸载重载的故障注入与长程 soak。
3. **显式未接线能力**：trustEnvelope 快路径（`unconfined-composition` 下恒为 outside）、full case capture durable 后端（`caseCapture.mode: 'full'` 拒绝安装）、R4 完整规则矩阵与 target/side-effect matcher、未实现工具族的 exact semantic adapter。这些能力不应被描述为可用。

## 5. 过程记录

审查由直接代码审读、可复现命令验证与并行只读审查代理共同完成。并行审查代理中有一份 DSH 适配器/dossier 部分报告在中断前返回，其中 H-1/M-1/M-2/L-1/L-3/I-1/I-3 等发现均已逐条复核；已确认的缺口全部按第 3 节修复，未能确认或与代码不一致的条目以 fail-closed 现状写入第 4 节。
