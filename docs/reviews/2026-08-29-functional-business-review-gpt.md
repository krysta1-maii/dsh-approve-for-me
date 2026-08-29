# dsh-approve-for-me 功能与业务审查报告

> 审查对象：`ef10764f81dc3fa3b5f5f3235f6e55e6d890862a`（`dsv4pro/feat/guardian-gate`）  
> 审查日期：2026-08-29  
> 审查范围：业务目标、审批主流程、角色与状态边界、失败与人工兜底、配置兑现程度、测试对真实业务场景的证明力  
> 非重点：密码学算法、散列实现选型、一般安全加固和代码风格  
> **作者：GPT（AI 生成）**

## 1. 执行摘要

当前仓库已经形成一套结构清楚、能够通过单元测试和构建的审批运行骨架，包括动作捕获、Managed Reviewer、per-parent 串行、一次性决策通道、machine-policy patch、GatePipeline 和若干未来持久化／卷宗组件。

但从业务产品角度看，当前实现仍应定义为：

> **可运行的审批协议与组件骨架，而不是已经闭环的自动审批产品。**

最关键的阻断不是 SHA256 或其他安全细节，而是以下业务语义尚未成立：

1. `auto-then-user` 的人工下沉可能先被遗留自动 answerer 再审一次，第二次甚至可以自动 allow；
2. 另一些自动能力故障又会直接变成 `unavailable`，根本到不了人工审批；
3. Reviewer 当前没有父会话用户需求、指令链和完整权限变化材料，却仍存在自动 allow 路径；
4. root/child、turn、直接用户 frontier 等决定审批作用域的事实被硬编码；
5. trust envelope、durable decision record、case capture、Reviewer 轮换等已暴露的配置或组件尚未接入真实组合根；
6. 170 项测试全部通过，但测试环境仍是 DSH 0.1.1-rc.2，并未证明目标 0.1.2 fork + Profile + Web 全链成立。

因此，现阶段不建议继续优先打磨密码学、格式或一般防御性细节。应先消除双自动裁决路径，建立可靠人工兜底，再接入足够的业务事实和真实持久化边界。

## 2. 审查方法与验证结果

本次审查覆盖：

- 根 `README.md`；
- `docs/consensus.md`、`host-contract.md`、`guardian-dossier.md`、`implementation.md`、`integration.md`、`reviewer-roadmap.md`；
- `src/plugin.ts` 组合根；
- action capture、machine-policy adapter、legacy approval answerer；
- GatePipeline、cache/breaker、sealed disposition、decision record；
- ReviewCoordinator、Reviewer provider、policy 和 decision tool；
- dossier、fact repository、record storage 和 case capture 的现有实现；
- 根测试套件及 patch overlay 测试边界。

本地验证结果：

- `npm run check`：通过；
- 28 个测试文件、170 项测试：全部通过；
- TypeScript typecheck：通过；
- build：通过；
- `npm ls @deepseek-ai/dsh-user-approval @deepseek-ai/dsh-tools @deepseek-ai/dsh-agent dsh-managed-agent --depth=0`：以 `ELSPROBLEMS` 退出，因为 `package.json` 要求 0.1.2-alpha.1，而 lockfile／实际安装仍是 0.1.1-rc.2；
- 仓库在审查过程中保持未修改。

## 3. 当前实际业务流程

当前运行路径可概括为：

1. `installApproveForMe()` 规范化配置，创建 decision channel、action capture、Managed Reviewer provider、Reviewer directory、per-parent lanes 和 coordinator；
2. `tools/pre-execute` 按 exact Agent + callId 捕获工具名和完整参数，`tools/result` 释放 capture；
3. 插件同时注册 patched machine policy 和旧 `approval/request` prepend answerer；
4. 未配置 `toolCatalog` 时，machine policy 一律 `delegate`，旧 answerer 直接调用 Guardian；
5. 配置 `toolCatalog` 时，adapter 根据 capture 计算 action identity、注册临时 Gate facts，再进入 `DefaultGatePipeline`；
6. Gate 实际依次处理：callId/facts/root/classification → deny breaker → trust envelope → allow cache → sealed replay → Guardian review → decision record/cache/breaker → outcome；
7. Reviewer child 固定 provider/model，关闭普通工具，只暴露结构化 decision tool；
8. Reviewer 当前收到的是动作请求 JSON，而不是完整父会话 dossier；
9. `allow` 映射为 `allowed-once`，`deny` 映射为 `rejected`，`human_review` 在 `auto` 下拒绝、在 `auto-then-user` 下 delegate。

上述第 3、4、8、9 点组合后，形成了当前最重要的业务缺陷。

## 4. 做得较好的部分

以下能力已经具备良好的实现基础：

- Domain/Application/DSH adapter/Reviewer 分层清晰；
- exact live Agent 作为 parent authority，没有简单依靠裸 sessionId 重新授予控制；
- DecisionChannel 具备一次性结果、deadline、abort、迟到结果和 tombstone 语义；
- per-parent 串行、跨 parent 并行的基础抽象已经存在；
- Reviewer provider 固定模型路由、system prompt、toolset、approval policy 和 sandbox mode；
- Reviewer 只能通过 scoped decision tool 提交结构化结果；
- machine-policy patch 明确位于 `never` 之后、交互式 waterfall 之前；
- 代码与文档多数位置明确承认当前不是产品级实现，没有把未完成能力完全包装成已完成能力；
- 单元测试对纯逻辑组件、协议解析和多个失败分支覆盖较充分。

这些基础可以保留，后续主要工作应集中在组合根和真实业务事实接线，而不是推倒重来。

## 5. 主要发现

### P0-1：人工下沉会被遗留 answerer 再次自动裁决

**位置**

- `src/plugin.ts:80`
- `src/plugin.ts:127-129`
- `src/plugin.ts:187-190`
- `src/dsh/approval-answerer.ts:29-47`
- `patch/dsh-user-approval/overlay/src/index.ts:313-321`

**现象**

真实 Gate 启用后，插件仍无条件注册旧的 prepend `approval/request` answerer。机器策略返回 `delegate` 后，patched ApprovalService 会进入 waterfall，但首先命中的仍然是本插件自己的旧 answerer。它会再次调用同一个 Reviewer coordinator。

**触发场景**

- Guardian 第一次返回 `human_review`；
- 工具未分类；
- Gate facts 缺失；
- decision record 暂时 unavailable；
- 其他被 Gate 映射为 delegate 的可人工恢复情况。

**业务影响**

- “需要人工”可能被第二次 Reviewer 结果反转为自动 allow；
- 一个审批请求产生两次模型调用和两次等待；
- Web 人工审批可能永远收不到请求；
- closed-world Gate 可以被旧 action-only answerer 绕开。

**建议**

真实 Gate 激活时，不再注册旧自动 answerer，或将其降级为纯 `next()` 透传。所有 machine-policy `delegate` 必须直接进入官方人工链。

### P0-2：`auto-then-user` 的另一部分失败路径又无法到达人工

**位置**

- `src/plugin.ts:134-142`
- `src/dsh/machine-policy-adapter.ts:58-80`
- `src/application/gate-pipeline.ts:176-198`
- `src/dsh/approval-answerer.ts:45-48`

**现象**

`resolveActionHash` 在缺 callId、capture 丢失或 snapshot 不可用时会在 Gate 前抛错。patched ApprovalService 会把 machine-policy 异常归一为 `unavailable`，而不是进入 waterfall。

Reviewer provider、delivery、model 或 pre-review 失败也缺少“可人工恢复异常 → delegate”的明确分类。

**业务影响**

`auto-then-user` 当前两头都不可靠：

- Gate 正常 delegate 时，可能被旧自动 answerer 截获；
- 自动能力抛错时，又可能直接 unavailable，人工兜底不可达。

**建议**

建立业务失败分类：

- 身份、绑定或事实冲突 → `unavailable/rejected`，禁止下沉；
- 自动能力暂时不可用 → `delegate`；
- Guardian 明确 `human_review` → `delegate`；
- abort → `cancelled`；
- delegate 后不得再次进入自动 Reviewer。

### P0-3：Reviewer 没有完成授权判断所需的业务材料

**位置**

- `src/domain/protocol.ts:62-74`
- `src/domain/protocol.ts:354-362`
- `src/reviewer/policy.ts:46-52`
- `src/dsh/action-capture.ts:13-25`
- `src/plugin.ts:54-62`

**现象**

Reviewer 当前主要看到：工具名、参数、reason、action identity、Reviewer/parent identity 和 deadline。它看不到：

- 用户原始需求和后续更改；
- 当前生效的 AGENTS.md／CLAUDE.md；
- 主 Agent 的交付链和当前 turn 工具轨迹；
- 主 Agent 发出的委托包络；
- 完整、结构化的权限变化；
- 其他用于判断“用户是否授权此动作”的父会话事实。

Loader 路径也没有提供 `projectPermissions`，因此生产配置不能依靠该程序化 port 补足权限事实。

**业务影响**

Reviewer policy 要求判断用户授权，但输入不足以完成这个任务。实际结果只能是：

- 大量 deny/human_review，导致产品不可用；或
- 根据动作表面信息猜测授权，导致业务判断不可靠。

**建议**

在任何 Guardian 自动 allow 前，先接入 source-backed parent facts、完整 dossier 和权限投影。此前应将 action-only Reviewer 限制为实验模式，或只允许产出 deny/human_review。

### P0-4：请求角色和 cache/breaker 作用域由硬编码事实决定

**位置**

- `src/plugin.ts:153-168`
- `src/application/gate-pipeline.ts:137-160`

**现象**

组合根写死：

```ts
turn: 0
directUserFrontierSeq: 0
rootRequester: true
directChildOrigin: false
```

**业务影响**

- delegated/custom child 请求会被当作 root principal；
- 某动作在旧 turn 被允许后，可能跨新的用户消息继续命中 allow-cache；
- 某动作曾被拒绝后，即使用户后来明确授权，也可能继续命中 deny breaker；
- 当前实现无法兑现“新直接用户消息推动授权语境变化”的业务语义。

**建议**

从真实 Session lifecycle、turn/step、parentSessionId、delegationDepth 和直接用户消息 event seq 投影这些字段，并围绕用户 frontier 建立 cache/breaker 失效测试。

### P1-1：trust envelope 是可配置但不可达的运行路径

**位置**

- `src/plugin.ts:82-83`
- `src/plugin.ts:112-120`
- `src/plugin.ts:147-172`
- `src/application/gate-pipeline.ts:149-158`

**现象**

插件创建了 trust-envelope evaluator，但注册 Gate facts 时没有提供 `trustEnvelope` input。Pipeline 只在该字段存在时才评估。

**业务影响**

用户可以成功配置 `trustEnvelope.enabled: true`，但任何动作都不会命中“0 次 LLM、0 次人工”的快速路径。长程无人值守目标尚未实现。

**建议**

实现真实 tool-family projection，将 effective/requested mode、workspace root、targets 和 justification 放入一次冻结的 Gate facts。

### P1-2：工具目录漂移校验没有读取真实运行时工具

**位置**

- `src/plugin.ts:143-146`
- `src/application/tool-classifier.ts:12-27`

**现象**

组合根从配置 descriptor 读取 schema fingerprint，再交给 classifier 与同一个 descriptor 比较。没有读取 exact live Agent tool scope 的实际 schema。

此外，Pipeline 当前只使用 `classified/unclassified/catalog-mismatch`，没有真正利用 `ordinary/gate-ask/body-escalation` 的分类差异组织执行路径。

**业务影响**

- 配置过期或实际工具变化时，真实 `catalog-mismatch` 不会出现；
- 分类目录目前更像启用开关，而不是能够证明真实工具行为的业务目录。

**建议**

在挂载或 Agent scope 物化时冻结真实 effective tool catalog，并对 body escalation、pre-execute ask 和 ordinary 三类分别建立端到端场景。

### P1-3：自动 allow 依赖的是内存记录，不是已接入的 durable record

**位置**

- `src/plugin.ts:87-88`
- `src/application/decision-record.ts:7-12`
- `src/application/gate-pipeline.ts:149-198`

**现象**

组合根固定使用 `InMemoryGateDecisionRecordStore`。该 store 返回 confirmed 后，Gate 即可自动 allow。已有 file/storage 风格组件没有接入插件。

**业务影响**

- 进程重启后最小决策记录丢失；
- 无法从正式持久化源重建业务历史；
- Storage 不可用、冲突和重启场景没有进入真实授权边界；
- 现有实现不满足文档声明的“自动 allow 前最小记录 durable”。

**建议**

接入真实 Storage Domain adapter，并保证只有 create-once durable success 才能产生 automatic allow。冲突不得 delegate，临时 unavailable 只能进入明确的人工恢复路径。

### P1-4：`timeoutMs` 不是一次业务请求的总时限

**位置**

- `src/application/review-coordinator.ts:81-127`

**现象**

请求先等待 per-parent lane，再执行 directory list/create，之后才设置 issuedAt/deadline。污染轮换重试时又重新获得一份完整 timeout。

**业务影响**

配置 30 秒不代表用户最多等待 30 秒。同 parent 排队、child ensure、delivery 或 contamination retry 都可能把总等待时间显著拉长。

**建议**

在进入 lane 前建立唯一 Review Run deadline，并把剩余预算传递给排队、list/create、deliver、retry 和 decision channel。轮换不得延长总 deadline。

### P1-5：启动失败和卸载路径没有完整业务生命周期

**位置**

- `src/plugin.ts:64-69`
- `src/plugin.ts:176-185`
- `src/plugin.ts:193-200`

**现象**

- Managed Reviewer provider 先注册，之后才检查 patched `registerMachinePolicy` 是否存在；
- 缺 fork 时抛错前没有显式回滚 provider registration；
- dispose 先等待 lanes drain，再 dispose decision channel，pending review 可能等待完整 timeout；
- 当前没有完整 starting/ready/failed/draining/disposed 状态机。

**业务影响**

失败挂载后重试或 HMR 可能遇到半挂载 contribution；卸载可能长时间阻塞，迟到结果和新请求的边界依赖调用时序。

**建议**

所有前置能力先验证再注册 contribution；注册过程使用显式回滚栈；卸载先停止接收新工作并取消 pending，再等待有限时间 drain。

### P1-6：绿测环境不是目标运行时

**位置**

- `package.json:42-50`
- `package.json:63-71`
- `package-lock.json:13-21`
- `package-lock.json:31-41`
- `package-lock.json:319-335`
- `vitest.config.ts:5-11`
- `tests/adapters/plugin.test.ts:43-49`
- `tests/adapters/plugin.test.ts:162-166`

**现象**

- `package.json` 要求 0.1.2-alpha.1；
- lockfile 和本地 node_modules 仍锁定 0.1.1-rc.2；
- 根 Vitest 明确排除 `patch/**`；
- 插件测试伪造 `registerMachinePolicy`；
- catalog 测试直接调用 policy，没有经过真实 ApprovalService waterfall；
- 真实 0.1.2 Profile/Web 尚未验收。

**业务影响**

170 项绿测证明组件级逻辑较稳定，但没有证明：

```text
approval/asked
→ machine policy
→ delegate/claim
→ official waterfall/UI
→ approval/decided
→ tool execution
```

这条真实业务链成立。

**建议**

增加一个锁定目标版本的安装与 Profile 验收层，至少覆盖首次审批、Reviewer 复用、human_review、自动能力不可用、Web 人工审批、重启和卸载。

### P2-1：`maxReviewsPerChild` 是无效配置

**位置**

- `src/config.ts:178-197`
- `src/plugin.ts:72-79`
- `src/application/reviewer-directory.ts:28-63`

**现象与影响**

配置会被解析和返回，但没有传给任何运行组件，也没有 review 计数或轮换逻辑。Reviewer child 会无限复用，除非被判定为 contaminated。

**建议**

明确计数的持久化语义，并验证 max=N 时第 N+1 次 review 轮换 child，reload 后计数行为保持一致。

### P2-2：`caseCapture` 配置没有运行时消费者

**位置**

- `src/config.ts:198-200`
- `src/application/case-capture.ts`
- `src/plugin.ts`

**现象与影响**

`caseCapture: full` 可以通过配置校验，但组合根没有构造 sink 或生成 artifact。使用者会认为已启用完整案例留存，实际没有产物。

**建议**

在配置未接线前拒绝 `full` 或明确标记 experimental/no-op；接线后覆盖 quota、TTL、GC、重启和 parent deletion 场景。

### P2-3：Dossier compiler 把不完整 dossier 标成 ready

**位置**

- `src/application/dossier-compiler.ts:62-98`
- `tests/application/dossier-compiler.test.ts:80-88`

**现象**

Compiler 构造的 dossier 明确包含：

```ts
completeness: {
  ready: false,
  missing: ['instructions', 'interaction', 'delegations']
}
```

但随后仍返回 `kind: 'ready'` 并施加 source-verified brand。测试也固定了这一行为。

**业务影响**

当前插件尚未接入该 compiler，因此这是 latent bug；但一旦接入，缺少关键业务材料的 dossier 可能被上层误认为可自动审查。

**建议**

只要 `completeness.ready !== true`，compiler 必须返回 `kind: 'incomplete'`。source-verified 只能说明来源校验通过，不能替代业务材料完整性。

## 6. 测试缺口与建议验收场景

### 6.1 必须新增的 P0 集成测试

1. 使用真实 patched ApprovalService 发起 ask；
2. Gate 第一次返回 `human_review`；
3. 断言 Reviewer 只调用一次；
4. 断言旧自动 answerer 不再认领；
5. 断言 UI/human answerer 收到原请求并决定最终结果。

同一测试还应覆盖：

- unclassified；
- facts missing；
- durable record unavailable；
- provider unavailable；
- delivery failure；
- model error；
- missing callId；
- missing capture。

### 6.2 角色与 cache/breaker 场景

- root Agent 发起 ask；
- direct child 发起 ask；
- 同 action 在同 turn 重复；
- 同 action 在新 turn 重复；
- 用户新增直接消息后再次执行同 action；
- 用户从未授权变为明确授权后重试原动作。

断言 child 请求失败关闭，cache/breaker 只在正确 frontier 内复用。

### 6.3 Reviewer 业务判断场景

构造三条真实父 Session 历史：

1. 用户明确授权当前动作；
2. 用户没有授权；
3. 用户授权前后存在冲突或撤回。

断言完整 dossier 实际进入 Reviewer，而不是由测试 fake 直接返回 allow。

### 6.4 trust envelope 场景

- 包络内动作：0 次 Reviewer、0 次人工、直接 allowed-once；
- 包络外动作：进入 Guardian；
- target、mode、workspace 或 justification 变化：重新评估，不沿用旧结果。

### 6.5 总 deadline 与生命周期场景

- 第一个同-parent review 占用 lane，第二个使用短 timeout；
- list/create/deliver 分别卡住；
- contamination 触发 rotate；
- pending review 时卸载插件；
- 缺 fork 挂载失败后补齐并 remount。

断言从 ask 开始的总时限不被任何步骤重置，卸载有限时间完成且无遗留 contribution。

### 6.6 真实目标环境场景

在干净目录中：

1. 安装锁定的 stock DSH 0.1.2-alpha.1；
2. 用本仓库 fork tarball 替换 `dsh-user-approval`；
3. 安装 `dsh-managed-agent`；
4. 安装本插件；
5. 启动真实 Profile/Web；
6. 验证 asked → machine policy → decided → tool/UI 全链；
7. 验证 cold resume、HMR、Stop 和人工审批面板。

## 7. 推荐施工顺序

### 第一阶段：修复审批组合

1. 移除真实 Gate 与 legacy auto-answerer 的双重自动裁决；
2. 让 machine `delegate` 直接到人工链；
3. 建立可人工恢复错误与不可恢复冲突的明确分类；
4. 用真实 patched ApprovalService 写端到端测试。

### 第二阶段：补足 Reviewer 的业务材料

1. 接入 root-principal Session fact source；
2. 投影用户消息、指令、主 Agent 交付链、delegation envelope 和当前 turn 工具轨迹；
3. 投影真实请求权限、workspace、target、mode 和 justification；
4. 不完整 dossier 一律不得产生自动 allow。

### 第三阶段：接入真实 Gate 事实和状态

1. 去掉 root/child、turn/frontier 硬编码；
2. 冻结真实 effective tool catalog；
3. 打通 trust envelope；
4. 修正 cache/breaker 的失效边界；
5. 实现单一总 deadline。

### 第四阶段：完成持久化与生命周期

1. 接入 durable decision record；
2. 接入 case capture 或暂时拒绝无效配置；
3. 实现 maxReviewsPerChild；
4. 完成 starting/ready/failed/draining/disposed；
5. 验证 reload、cold resume、HMR 和卸载。

### 第五阶段：真实产品验收

1. 修正 lockfile 和目标依赖；
2. 把 fork overlay 测试纳入独立 CI；
3. 在真实 0.1.2 Profile/Web 上验收；
4. 最后再建设完整风险 taxonomy、授权 policy、指标和长期 soak。

## 8. 发布判断

| 维度 | 当前判断 |
|---|---|
| 协议与分层骨架 | 基本成立 |
| Managed Reviewer 运行骨架 | 基本成立，真实 Profile/cold resume 待验收 |
| machine-policy patch | 结构成立，目标运行时全链待验收 |
| 人工兜底 | 不成立，存在重复自动审查与不可达两类问题 |
| 用户授权判断 | 不成立，Reviewer 缺父会话业务材料 |
| trust envelope | 未接通 |
| cache/breaker 业务作用域 | 不成立，关键 facts 硬编码 |
| durable decision record | 未接通 |
| case capture / Reviewer 轮换 | 配置存在但无运行效果 |
| 自动审批产品就绪 | 否 |

最终建议：

> 当前版本可以继续作为协议、组合和纯逻辑组件的开发基线，但不应作为成熟自动审批产品启用。下一步首先修复审批组合和人工兜底，再补足 Reviewer 业务证据；不应优先投入 SHA256、一般安全加固或低价值代码细节。

---

**报告署名：GPT（AI 生成）**
