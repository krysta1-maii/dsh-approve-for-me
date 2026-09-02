# deepseek-harness (dsh-v0.1.2-alpha.2 → dsh-v0.1.2-alpha.5) 兼容性分析报告

> **复核状态（2026-09-03）**：本报告初稿由 agy(gemini-3.8-flash)生成，全部关键结论已经人工逐条对 git tag 核实无误；核实中发现的两处补充见文末「附录 A」。
>
> **目标组件**：`dsh-approve-for-me` (当前锁定在 DSH `dsh-v0.1.2-alpha.2`)  
> **上游对比**：`deepseek-harness` 标签 `dsh-v0.1.2-alpha.2` (`0a53fb5`) → `dsh-v0.1.2-alpha.5` (`db6bdc3`)  
> **报告日期**：2026-09-03  
> **报告路径**：`dsh-approve-for-me/docs/compat-alpha5-analysis.md`

---

## 1. 核心结论摘要

1. **阻塞性破坏来自 `packages/core/session`**：  
   在上游提交 `5660f44d29` ("perf(session): separate indexed and snapshot log reads") 中，`Session.prototype.events` getter 被**彻底移除**，替换为 `session.snapshotEvents()` 与 `session.eventAt(seq)`。  
   `dsh-approve-for-me` 在鉴权绑定校验、投影桥（bridge）、有效工具目录解析、父会话事实采集等核心路径上严重依赖 `session.events`。在 alpha.5 运行时下，所有这些访问均返回 `undefined`，导致审批流程抛出 `GateFailure('integrity', ...)` 故障关闭，整套审批机制**完全无法工作**。

2. **官方 `dsh-user-approval` 在 alpha.5 仍未原生支持所需能力**：  
   alpha.5 **既未提供** `ApprovalRequestEvent.requestId`，**也未提供** `ApprovalService.registerMachinePolicy()` 独占机器策略槽位。`dsh-approve-for-me` 依然必须维护该 fork patch。

3. **User-Approval Fork Patch 无法无修改平移，需完成针对 alpha.5 的适配**：  
   原 patch 的 overlay 基于 alpha.2 编写，内部直接调用了已删除的 `session.events` 以及已废弃删除的顶层导出函数 `effectiveApprovalPolicy`。若直接将原 overlay 套用至 alpha.5，测试与构建将运行时崩溃。需要将 patch 重构适配至 alpha.5 的会话读取机制。

4. **除 session 与 user-approval 外，其余 9 个包导入符号及服务保持完全兼容**：  
   `dsh-agent`、`dsh-tools`、`dsh-llm`、`dsh-subagent`、`dsh-sandbox-policy`、`dsh-system-prompt`、`dsh-storage` 等包导出的符号及运行时接口均无破坏性变更。

---

## 2. 消费面现状与影响总览矩阵

| 包名 (`@deepseek-ai/...`) | 消费点 | alpha.2→alpha.5 API 破坏性变更 | 严重度 | 关键影响描述 |
|---|---|---|---|---|
| **`dsh-session`** | `SessionId` (导入); `session.events` (属性访问) | **有 (重大破坏)**：`Session.prototype.events` 被删除；`SessionHeader.seedLength` 被移除改为 `isSeeded`；引入 `SessionSeq` 品牌数字 | **阻塞** | `session.events` 变为 `undefined`，导致 `validateLiveApprovalBinding`、`execution-projection-bridge`、`parent-session-fact-source` 全部崩溃或静默失效 |
| **`dsh-user-approval`** | `ApprovalOutcome`, `setApprovalPolicy` (导入); `ctx.approval` (服务); Fork Patch | **有 (需适配)**：删除顶层函数 `effectiveApprovalPolicy`；内部 `hasOpenTurn` 签名变动；原生**未提供** machine policy 与 requestId | **阻塞 (Patch 需适配)** | 导入符号无影响；但现有 alpha.2 patch overlay 代码因调用 `session.events` 在 alpha.5 编译/运行时崩溃，必须适配重构 |
| **`dsh-agent`** | `Agent`, `AgentSetup`, `ModelSelection`, `installModelSelection` | **无** (类型与函数签名完全兼容；仅内部 `TurnBoundaryProjection` 与 `CreateAgentOptions` 改动) | **无影响** | 所消费的 4 个导出符号均可直接使用 |
| **`dsh-tools`** | `ObjectJsonSchema`, `PostToolDecision`, `PreToolDecision`, `ToolDefinition`, `ToolExecution`, `ToolExecutionResult`; `ctx.tools.schemas` | **无** (仅注释变动与内部 invariant 调整) | **无影响** | 所有导出类型与 `ctx.tools.schemas(agent)` 保持兼容 |
| **`dsh-system-prompt`** | `PromptSection` | **无** (仅版本号递增) | **无影响** | 类型定义完全一致 |
| **`dsh-llm`** | `ContentBlock`, `LlmModelInfo`, `LlmProviderInfo`, `LlmResolvedModelInfo`, `ReasoningEffortId`; `ctx.llm.*` | **无** (仅版本号递增) | **无影响** | 符号与 Provider/Model Catalog 接口完全一致 |
| **`dsh-subagent`** | `delegationDepthOf` | **无** (内部文件重构，`depth.ts` 及其导出完全未变) | **无影响** | `delegationDepthOf(agent)` 签名与行为完全一致 |
| **`dsh-sandbox`** | (仅 peerDependencies 声明) | **无** (移除了无用的 `./invariant` 占位入口) | **无影响** | 不影响插件 |
| **`dsh-sandbox-policy`** | `setSandboxMode` | **无** (内部 invariant 适配，公开函数未变) | **无影响** | `setSandboxMode(session, mode)` 正常可用 |
| **`dsh-storage`** | (存储枢纽底层) | **无** (移除 `./invariant`；扩展 `KvUnit.backupRecord` 与 `compatibleVersions`) | **无影响** | 向后兼容扩充 |
| **`dsh-storage-domain`** | (存储领域设施) | **无** (扩展 `compatibleVersions` 与 `invalidRecords: 'backup-and-skip'`) | **无影响** | 向后兼容扩充 |

---

## 3. 分包详细变更与兼容性分析

### 3.1 `packages/core/session` (`@deepseek-ai/dsh-session`)

#### (a) alpha.2 → alpha.5 API 变更
1. **`Session.prototype.events` getter 被彻底移除**：
   - 上游为了消除不必要的大数组快照拷贝与 O(N) 重复遍历，将日志访问拆分为：
     - `session.snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[]`
     - `session.ownEvents(): readonly SessionEvent[]`
     - `session.eventAt(seq: SessionSeq): SessionEvent | undefined`
     - `session.seq: SessionLogOffset` (类型品牌化，表示当前日志长度)
   - 旧代码访问 `session.events` 将直接得到 `undefined`。
2. **`SessionHeader` 结构变更**：
   - 删除了 `seedLength?: number` 属性；
   - 增加了 `isSeeded: boolean` 属性；
   - 继承前缀长度不再作为 Header 字段序列化，而是作为 `Session` 实例内部状态 `inheritedEventCount`，由创建或还原参数 `CreateSessionOptions.inheritedEventCount` / `RestoredSessionOptions.inheritedEventCount` 传入。
3. **品牌数值类型引入**：
   - 引入 `SessionSeq`、`SessionLogOffset`、`OptionalSessionSeq`、`SessionSeqCursor`；
   - `SessionEvent.seq` 的类型由普通 `number` 改为 `SessionSeq`；
   - `SessionEvent.sourceEventSeqs` 改为 `SessionSeq[]`。
4. **持久化后端变更**：
   - 移除了 SQLite 持久化后端，收敛至 jsonl。

#### (b) 影响的消费点
- **导入符号**：`SessionId` 保持原样，签名无变化。
- **运行时核心对象**：`dsh-approve-for-me` 源码中以下文件重度依赖 `session.events`：
  - `src/plugin.ts:96-102` (`validateLiveApprovalBinding`):
    ```ts
    if (sessionId.length === 0 || agentId !== sessionId || session.header?.id !== sessionId || !Array.isArray(session.events)) {
      throw new GateFailure('integrity', 'approval ask is not bound to an exact live Agent/Session')
    }
    const asked = session.events.filter(...)
    ```
    此处 `!Array.isArray(session.events)` 必然为 `true`，导致所有审批请求抛出完整性错误，直接失败。
  - `src/dsh/execution-projection-bridge.ts`:
    - 第 176 行：`if (... || !Array.isArray(session.events)) return`，导致投影桥静默丢弃执行事实。
    - 第 44、181、306、386、432、445、508、513 行：全部直接从 `session.events` 取数组进行索引或 filter。
  - `src/dsh/effective-tool-catalog.ts:133`:
    - `const events = (exec.agent?.session as unknown as SessionLike | undefined)?.events`
    - 取不到 events 导致无法定位 `request/header`，无法解析工具 schemas。
  - `src/dsh/parent-session-fact-source.ts:164-166`:
    - `const events = bound.session.events`
    - `!Array.isArray(events)` 导致 `snapshot()` 直接返回 `undefined`，无法构建事实包。

#### (c) 严重度
**阻塞** (Blocking)。如果不修改代码兼容 `snapshotEvents()`，插件在 alpha.5 上完全无法运行。

---

### 3.2 `packages/interaction/user-approval` (`@deepseek-ai/dsh-user-approval`)

#### (a) alpha.2 → alpha.5 API 变更
1. **删除顶层导出函数**：
   - 删除了 `export function effectiveApprovalPolicy(events: readonly SessionEvent[]): ApprovalPolicy | undefined`。
   - 官方改为在 `ApprovalService.prototype.overrideOf(session: Session)` 中通过 `session.eventAt` 倒序扫描获取。
2. **私有辅助函数 `hasOpenTurn` 签名变动**：
   - 从 `hasOpenTurn(events: readonly SessionEvent[])` 变为 `hasOpenTurn(session: Session)`，内部改用 `session.eventAt(SessionSeq(seq))`。
3. **`ApprovalService.prototype.request`**：
   - 入参保持 `ApprovalRequest`，调用 `hasOpenTurn(session)` 进行校验。
4. **原生能力缺失**：
   - 依然没有为 `ApprovalRequestEvent` 添加 `requestId` 字段。
   - 依然没有在 `ApprovalService` 中提供 `registerMachinePolicy` 或等价的独占机器策略扩展点。

#### (b) 影响的消费点
- **导入符号**：`ApprovalOutcome` 与 `setApprovalPolicy` 未变，无影响。
- **运行时服务**：`ctx.approval` 上的核心方法存在，但缺少 `registerMachinePolicy`。
- **Fork Patch**：插件依赖的 `patch/dsh-user-approval/overlay/` 源码基于 alpha.2，内部调用了 `hasOpenTurn(session.events)` 与 `effectiveApprovalPolicy(session.events)`，在 alpha.5 下会导致构建测试及运行崩溃。

#### (c) 严重度
- 官方包符号：**无影响**。
- Fork Patch 机制：**阻塞** (必须更新 overlay 适配 alpha.5)。

---

### 3.3 `packages/core/agent` (`@deepseek-ai/dsh-agent`)

#### (a) alpha.2 → alpha.5 API 变更
1. `src/types.ts`：`TurnBoundaryProjection` 中的序列号类型从 `number | null` 改为 `OptionalSessionSeq`，`lastStepBoundary.seq` 改为 `SessionSeq`。
2. `src/index.ts`：`CreateAgentOptions` 中的 `meta.seedLength?: number` 被移除，改为 `meta.isSeeded?: boolean`，并在顶层增加了 `inheritedEventCount?: SessionLogOffset`。
3. `Agent` 接口定义、`AgentSetup` 类型、`ModelSelection` 接口、`installModelSelection` 函数均未发生破坏性修改。

#### (b) 影响的消费点
- 消费符号：`Agent`, `AgentSetup`, `ModelSelection`, `installModelSelection` 导入及用法均不受破坏。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.4 `packages/core/tools` (`@deepseek-ai/dsh-tools`)

#### (a) alpha.2 → alpha.5 API 变更
- `src/index.ts` 仅更新了一处注释（line 1128）。
- `src/invariant.ts` 内部改用 `session.snapshotEvents()`。
- 没有删除任何公开导出符号，没有改名，没有修改方法签名。

#### (b) 影响的消费点
- 导入符号：`ObjectJsonSchema`, `PostToolDecision`, `PreToolDecision`, `ToolDefinition`, `ToolExecution`, `ToolExecutionResult` 完全不受影响。
- 运行时服务：`ctx.tools.schemas(agent)` 签名及行为完全一致。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.5 `packages/core/system-prompt` (`@deepseek-ai/dsh-system-prompt`)

#### (a) alpha.2 → alpha.5 API 变更
- 仅 `package.json` 版本号从 `0.1.2-alpha.2` 递增到 `0.1.2-alpha.5`，`src/` 无任何代码改动。

#### (b) 影响的消费点
- 导入符号：`PromptSection` 完全不受影响。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.6 `packages/llm/llm` (`@deepseek-ai/dsh-llm`)

#### (a) alpha.2 → alpha.5 API 变更
- 仅 `package.json` 版本号递增，`src/` 源码无任何改动。

#### (b) 影响的消费点
- 导入符号：`ContentBlock`, `LlmModelInfo`, `LlmProviderInfo`, `LlmResolvedModelInfo`, `ReasoningEffortId` 均不受影响。
- 运行时服务：`ctx.llm.listProviders()`, `ctx.llm.listModels()`, `ctx.llm.resolveModelInfo()` 行为一致。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.7 `packages/subagent/subagent` (`@deepseek-ai/dsh-subagent`)

#### (a) alpha.2 → alpha.5 API 变更
- 删除了未公开使用的内部文件 `src/activation-setup-registry.ts`，增加了 `src/internal.ts`。
- `src/depth.ts` 中的 `delegationDepthOf(agent: Agent): number` 实现未变，并在 `src/index.ts` 中继续公开导出。
- 子代理列表解析与会话投影逻辑适配了 `SessionSeq` 与 `isSeeded`。

#### (b) 影响的消费点
- 导入符号：`delegationDepthOf` 签名与行为完全一致。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.8 `packages/sandbox/sandbox` (`@deepseek-ai/dsh-sandbox`)

#### (a) alpha.2 → alpha.5 API 变更
- 删除了空的占位文件 `src/invariant.ts`，并从 `package.json` 中移除了子路径导出 `./invariant`。
- 其他无变动。

#### (b) 影响的消费点
- `dsh-approve-for-me` 未从该包导入符号（仅在 peerDependencies 中声明），不受影响。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.9 `packages/sandbox/sandbox-policy` (`@deepseek-ai/dsh-sandbox-policy`)

#### (a) alpha.2 → alpha.5 API 变更
- `src/invariant.ts` 内部改用 `session.snapshotEvents()`。
- 公开导出的 `setSandboxMode(session: Session, mode: SandboxMode): void` 签名及实现完全一致。

#### (b) 影响的消费点
- 导入符号：`setSandboxMode` 完全不受影响。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.10 `packages/storage/storage` (`@deepseek-ai/dsh-storage`)

#### (a) alpha.2 → alpha.5 API 变更
- 删除了空的 `./invariant` 导出。
- `KvUnit` 接口增加了可选方法 `backupRecord?(table: string, key: string): Promise<string>`。
- `KvUnitDescriptor` 增加了可选配置 `compatibleVersions?: readonly number[]`。

#### (b) 影响的消费点
- 无破坏性变动，均为向后兼容扩展。

#### (c) 严重度
**无影响** (No impact)。

---

### 3.11 `packages/storage/storage-domain` (`@deepseek-ai/dsh-storage-domain`)

#### (a) alpha.2 → alpha.5 API 变更
- `DomainSpec` 增加了可选字段 `compatibleVersions?: readonly number[]` 与 `invalidRecords?: 'backup-and-skip'`。
- `DomainFacility.prototype.open` 支持了脏数据备份隔离跳过机制。

#### (b) 影响的消费点
- 无破坏性变动，现有领域表模型完全向后兼容。

#### (c) 严重度
**无影响** (No impact)。

---

## 4. User-Approval Patch 差异与平移建议

### 4.1 上游差异评估
官方 `@deepseek-ai/dsh-user-approval` 在 `alpha.2` 到 `alpha.5` 的修改集中于 **适配底层 session 日志 API 变更**：
1. `src/index.ts`：删除了 `effectiveApprovalPolicy` 导出；`hasOpenTurn` 和 `overrideOf` 改用 `session.eventAt` 倒序遍历；`request()` 改用 `hasOpenTurn(session)`。
2. `src/invariant.ts`：改用 `session.snapshotEvents()` 遍历。
3. `src/types.ts`：**完全无变更**。

### 4.2 原生等价能力判断
- **`ApprovalRequestEvent.requestId`**：官方 alpha.5 **未提供**。`ApprovalService.request()` 依然在内部生成 `ApprovalRequestId` 后只写入 session log，派发给 waterfall 的 `ApprovalRequestEvent` 依然不含 `requestId`。
- **`ApprovalService.registerMachinePolicy`**：官方 alpha.5 **未提供**。依然只有 `ctx.waterfall('approval/request', ...)` 和基于 session 的 `never` 策略。
- **结论**：**无法废弃 patch，必须继续维护 fork patch**。

### 4.3 Patch 平移适配方案

原 patch 位于 `dsh-approve-for-me/patch/dsh-user-approval/`。平移至 alpha.5 需做以下改动：

#### 1. `overlay/src/types.ts`
- 直接沿用现有 overlay 内容即可。包含：
  - `MachineApprovalDecision = ApprovalOutcome | 'delegate'`
  - `MachineApprovalPolicy` 接口
  - `ApprovalRequestEvent.requestId?: ApprovalRequestId`
- 该文件与 alpha.5 的官方 `types.ts` 完全无冲突。

#### 2. `overlay/src/index.ts`
- **必须以 alpha.5 的 `src/index.ts` 为基线重做注入**，不能直接使用 alpha.2 的旧 overlay。
- 关键重做步骤：
  1. 保留 alpha.5 的 `hasOpenTurn(session: Session)` 与内部基于 `session.eventAt` 的实现。
  2. 保留 alpha.5 的 `overrideOf(session: Session)` 内部基于 `session.eventAt` 的实现。
  3. 类定义中注入私有成员：
     ```ts
     private machinePolicy?: { readonly id: string; readonly policy: MachineApprovalPolicy }
     ```
  4. 注入 `registerMachinePolicy` 方法：
     ```ts
     registerMachinePolicy(policy: MachineApprovalPolicy): () => void {
       if (this.machinePolicy !== undefined) {
         throw new Error(`machine approval policy slot is already owned by "${this.machinePolicy.id}"`)
       }
       const entry = { id: policy.id, policy }
       this.machinePolicy = entry
       return () => {
         if (this.machinePolicy === entry) this.machinePolicy = undefined
       }
     }
     ```
  5. 在 `request(req: ApprovalRequest)` 中，将生成的 `id` 注入到 `decide` 调用中：
     ```ts
     const outcome = await this.decide({ ...req, requestId: id }, session)
     ```
  6. 在 `decide(req: ApprovalRequest, session: Session)` 中，在 `this.effectivePolicy(session) === 'never'` 校验之后，进入 waterfall 之前，执行 machine policy 裁决：
     ```ts
     const entry = this.machinePolicy
     if (entry !== undefined) {
       const decision: MachineApprovalDecision = await entry.policy.decide(req)
       if (decision !== 'delegate') return OUTCOMES.includes(decision) ? decision : 'unavailable'
     }
     ```

#### 3. `overlay/src/invariant.ts`
- 使用 alpha.5 官方的 `src/invariant.ts`（包含 `session.snapshotEvents()`），无需保留旧版 `session.events`。

#### 4. `overlay/tests/approval-machine-policy.spec.ts`
- 将测试中的 mock `fakeAgent` 更新为 alpha.5 的会话读取契约：
  ```ts
  function fakeAgent(seed = [{ type: 'turn/start' }, { type: 'user/message' }]) {
    const appended: Array<{ type: string; data: Record<string, unknown> }> = []
    const events = [...seed]
    const agent = {
      session: {
        get seq() { return events.length },
        eventAt: (seq: number) => events[seq],
        snapshotEvents: () => Object.freeze([...events]),
        append: (type: string, data: Record<string, unknown>) => {
          const event = { type, data }
          events.push(event)
          appended.push(event)
          return event as unknown as SessionEvent
        },
      },
    } as unknown as Agent
    return { agent, appended }
  }
  ```

#### 5. 配置文件与构建校验脚本更新
- `patch/dsh-user-approval/upstream.json`：
  - `"upstreamVersion"`: `"0.1.2-alpha.5"`
  - `"upstreamTag"`: `"dsh-v0.1.2-alpha.5"`
  - `"upstreamCommit"`: `"db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5"`
  - `"patchVersion"`: 递增或保持
- `package.json`：
  - 将所有 `@deepseek-ai/*` 的 `peerDependencies` 与 `devDependencies` 从 `0.1.2-alpha.2` 升级至 `0.1.2-alpha.5`。
  - 构建目标产物更新为 `dsh-user-approval-afm-0.1.2-alpha.5.tgz`。
- `pnpm-workspace.yaml`：
  - 更新 overrides 与 minimumReleaseAgeExclude 的版本。

---

## 5. `dsh-approve-for-me` 插件源码迁移改造清单

为了彻底解决由 `session.events` 移除引起的运行时阻塞问题，插件本体需进行以下代码重构：

1. **引入统一的会话事件安全提取辅助函数**：
   在 `src/dsh/` 下提供统一的 helper（如 `extractSessionEvents(session)`）：
   ```ts
   export function extractSessionEvents(session: unknown): readonly EventLike[] | undefined {
     if (!session || typeof session !== 'object') return undefined
     const candidate = session as { snapshotEvents?: () => readonly EventLike[]; events?: readonly EventLike[] }
     if (typeof candidate.snapshotEvents === 'function') {
       return candidate.snapshotEvents()
     }
     if (Array.isArray(candidate.events)) {
       return candidate.events
     }
     return undefined
   }
   ```
2. **改造 `src/plugin.ts`**：
   在 `validateLiveApprovalBinding` 中使用上述辅助函数，支持 `snapshotEvents()`，解除 `!Array.isArray(session.events)` 的硬编码拦截。
3. **改造 `src/dsh/execution-projection-bridge.ts`**：
   在第 44、176、181、306、386、432、445、508、513 行使用辅助函数或 `snapshotEvents()`，并在 `SessionLike` 接口中增加 `snapshotEvents?: () => readonly EventLike[]`。
4. **改造 `src/dsh/effective-tool-catalog.ts`**：
   第 133 行改用辅助函数读取快照事件。
5. **改造 `src/dsh/parent-session-fact-source.ts`**：
   第 164 行改用辅助函数读取快照事件。
6. **更新单元测试与 Fixtures**：
   更新 `tests/adapters/*.test.ts` 中构造的模拟 `agent.session`，使其具备 `snapshotEvents()` 与 `eventAt()` 方法。

---

## 附录 A：人工复核补充（2026-09-03）

1. **`session.events` 消费点核实**：`src/plugin.ts:96,99`、`src/dsh/execution-projection-bridge.ts:44,165,176,181,301+`、`src/dsh/effective-tool-catalog.ts:133`、`src/dsh/parent-session-fact-source.ts:164` 全部确认直接访问 `session.events`，alpha.5 下返回 `undefined`（Session 类已无该成员，仅存 `snapshotEvents()`/`eventAt(seq)`/`seq`），本插件在 alpha.5 上**阻塞**。
2. **fork overlay 核实**：`patch/dsh-user-approval/overlay/src/index.ts:249,285` 调用 `hasOpenTurn(session.events)` 与 `effectiveApprovalPolicy(session.events)`、`overlay/src/invariant.ts:67` 遍历 `session.events`——三者都建立在 alpha.2 的 Session API 上， overlay 无法直接落到 alpha.5 源码；但 alpha.5 上游 `types.ts` 零变更，`overlay/src/types.ts` 可原样沿用。
3. **alpha.5 原生能力核实**：`git grep registerMachinePolicy dsh-v0.1.2-alpha.5` 与 `git grep requestId …/user-approval/src` 均无命中，patch 不能废弃，确认。
4. **alpha.5 tag commit 核实**：`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`，正确。
5. **基线状态**：本仓库在当前 alpha.2 锁定下 `npm run check` 全绿（42 文件 / 330 测试，2026-09-03 复跑）。

### 附录 A.1：`dsh-managed-agent`（三件套之一）alpha.5 表面核对

| 消费点 | alpha.5 状态 | 影响 |
|---|---|---|
| `sessionQuery.readSession(id).events` | 保留（返回 `SessionLogSnapshot{ session, inheritedEventCount, events }`） | 无 |
| `Session.deriveMessages()` | 保留（`packages/core/session/src/index.ts:790`） | 无 |
| `ProjectionDefinition.init` | 签名扩为 `init(header, inheritedEventCount)`；managed-agent 的零参 `init()` 在 TS 结构化类型下仍可赋值，运行期多传参数被忽略 | 无（向后兼容扩展） |
| `AgentOptions`/`PreStepDecision`/`ToolRestriction`/`SubagentProvider`/`MessageId`/`UserMessage`/`JsonValue`/`SessionId` | 全部仍存在 | 无 |
| `dsh-api-session-controller/client`、`dsh-client-ui-{conversation,renderer,session}/client`（含 `ComposerChainProps`） | 子路径导出均在 | 无 |

结论：managed-agent 在本次核对范围内**未发现阻塞项**，但其锁定面更宽（含 UI 包），升级时仍需与 approve-for-me 同步重锁并重跑 profile smoke。

### 附录 A.2：升级路径要点（不在本次核对范围内执行）

- fork 重建：`upstream.json` 指向 `dsh-v0.1.2-alpha.5`(`db6bdc3`)，以 alpha.5 的 `src/index.ts`/`src/invariant.ts` 为底座重打 patch，`types.ts` overlay 沿用。
- 插件本体：4 个文件共 10+ 处 `session.events` 访问改为 `snapshotEvents()`（建议同时更新 `SessionLike` 结构类型）。
- 版本墙：`package.json` peer/devDeps、`pnpm-workspace.yaml` overrides + `minimumReleaseAgeExclude`、三个 `verify:*` 脚本内嵌的 tarball 文件名全部从 alpha.2 换到 alpha.5。
- `deployment-artifacts.lock.json` 三件套的 sha256、commit、tree 需全部重建后再跑 `profile:artifact-smoke` 真实 Profile 验收。
- 注意：alpha.5 已删除 `session-persistence-sqlite` 后端（收敛 jsonl），既有 Profile 的存储迁移需单独评估。
