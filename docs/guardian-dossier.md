# Guardian 案件卷宗接口与编译规范

> 状态：2026-08-27 设计草案；主 Agent／子代理归因边界已收敛。本文定义 `dsh-approve-for-me` 首期实验性案件卷宗的事实来源、逻辑结构、候选接口、编译规则和失败边界；对应代码尚未实现，文中的 TypeScript 是待实现契约，不是当前包已经导出的 API。
>
> 本规范只定义“向 Guardian 提供哪些事实以及如何确定性地编译这些事实”。Guardian 如何评估风险、判断用户授权和产生裁决，属于独立的 Reviewer policy／decision specification，不在本文定义。

## 1. 目标

首期卷宗采用**高召回、低预判、主体验证**策略：尽量完整地向 Guardian 还原主 Agent 为什么走到当前审批请求，而不是先由宿主实现一套语义相关性判断器。原生 owned 子代理及其后代的意图统一归属于主 Agent，但子代理内容不作为独立证据输入；主 Agent 发出的委托本身属于主轨迹并须完整保留。

固定逻辑顺序为：

```text
环境信息
→ 已生效的 AGENTS.md／CLAUDE.md 指令
→ 用户—主 Agent 交付链 + 主 Agent 委托包络
→ 当前 turn 的工具请求轨迹
→ 当前待审批请求的精确信息
```

首期实验需要回答：

- 该材料组合能否让 Guardian 正确理解用户要求及短指令的指代对象；
- 完整材料的大小和审批延迟是否可接受；
- 不同工具、权限增量和上下文长度下的 `allow`／`deny`／`human_review` 倾向如何；
- 哪个区块实际成为主要 token 成本；
- 后续是否有必要引入裁剪、full／delta 或额外事实。

## 2. DSH 插件原则

本项目首先是一个 DSH 插件，卷宗实现必须优先采用 DSH 正式服务和持久化约定。

### 2.1 两个持久事实来源

卷宗只依赖两个持久事实来源：

1. **父 DSH Session log**：对话、turn／step、消息、原生工具调用、Code Mode 嵌套 dispatch、工具结果、请求 header、Session 级策略覆盖和审批审计的规范事实来源；
2. **Approve-for-me Storage Domain sidecar**：补充 Session log 未持久化的执行期结构化事实，包括已解析的 `ActionSnapshot`、权限投影及其 projector 版本、部署默认值的本次解析结果，以及 shell `exitCode`、`sandbox.denied`、`enforcement`、`runnerFailed` 等 canonical 结果字段。

sidecar 中的动作投影不得独立证明“模型请求过这个动作”：每条记录必须反向绑定一个父 Session 中的正式请求事件，并校验 callId、工具名、参数投影和 `actionHash`。父日志给出请求存在性与原始内容；sidecar 只保存日志无法重建的已解析／运行期投影。两者任一缺失或冲突都失败关闭。

审批时取得的 live `ApprovalRequest`、`ToolExecution`、Agent 和 Session 对象只用于：

- 从同一个 `ApprovalRequest.agent` 一次性派生父 Agent／Session authority；
- 绑定当前案件并定位对应日志事件；
- 在执行期捕获即将丢失的结构化值；
- 校验 live Agent、Session、callId、工具名和动作哈希；
- 冻结本次快照。

它们不构成第三套持久台账。若自定义 `projectPermissions` 等投影函数参与 v1，它必须声明稳定的 `projectorId`，其结果连同 id 在审批前持久化；未命名、不可重放的投影不得产生 ready dossier。

### 2.2 本项目不扩展父 Session event schema

DSH 0.1.1-rc.2 的公共 invariant 机制可以支撑像 `tool-workflow/*` 这样由插件声明、追加并恢复校验的自定义 Session events；因此 Storage Domain 不是 DSH 能力缺失下的唯一方案。本文仍把“不新增 `approve-for-me/*` 父日志事件”定为本项目 v1 的兼容性与卸载安全策略：本插件不得直接修改 `$DSH_HOME/sessions` JSONL，也不让父 Session 的恢复依赖插件私有 event union／invariant。

补充事实统一通过官方 Storage Domain API 保存。sidecar 丢失或损坏不得破坏父 Session；需要但无法取得的事实必须导致失败关闭或人工下沉。未来若改用已注册 custom event，必须以新 dossier/source 版本明确迁移和卸载语义。

### 2.3 不重新鉴定 DSH 日志真实性

DSH Session log 是本项目的规范历史。卷宗编译器负责选择结构边界、保持顺序和呈现来源，不对正式日志事件另做真实性评分。

来源字段仍须保留，因为 Guardian 需要理解谁在什么位置说了什么；但编译器不得预先生成：

- `trusted: true/false`；
- `authorizationCapable`；
- `relevantToCurrentAction`；
- `thisMessageAuthorizesAction`。

这些都是 Guardian policy 的语义判断，不是卷宗编译职责。

### 2.4 主体归因与子代理边界

本规范采用 **principal／delegation-envelope** 模型：v1 只支持无 `parentSessionId`、且 exact live Agent 的有效委派深度 `max(session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0) === 0` 的主／根 Agent 作为案件主体。adapter 仍从当前 `approval/request.agent` 取得 exact live requester，但必须验证该 requester 就是上述主主体；任何 delegated／custom child 即使意外采用 `ask`，也返回 `unsupported-delegated-requester`，不得在缺失根用户链和创建委托的情况下编译 ready dossier。若未来要直接审批非根 Agent，必须升级协议并引入经认证的 ancestor delegation-envelope source，不能只读取 child Session。

由主主体创建的 owned 子代理及其后代只延伸主体已表达的事务意图，不获得、转移或创造额外用户授权。卷宗只读取主体 Session 与主体侧 sidecar：

- 收录主 Agent 发出的 `subagent`／`subagent_fork` 初始委托、`send_message` 后续委托，以及已声明为 delegation-capable 的 workflow／Ralph／扩展工具请求；
- 保留每次委托的精确父侧请求、顺序、最小结果状态和稳定 projector 身份；
- 不遍历 child Session，不读取 child transcript、reasoning、tool calls/results；
- 不把 foreground subagent tool result 正文、`source.kind == subagent-report` 的 report 内容或 `source.kind == subagent-settled` 的 closing message 投入 Guardian；
- 只保留父侧请求引用、类型化最小 outcome 和 schema-validated canonical tool value 中 projector 明确列出的 content-free receipt，例如 callId、child／run／job／message id、请求 event 和 acceptance；不得从 rendered result、report、settlement 或 child 输出 blocks 补提字段。原始 child 日志继续由 DSH 保存，供独立审计／取证，而不是审批裁决；
- 主 Agent 收到子输出后自己产生的 assistant 文本、后续委托和工具请求仍是主 Agent 轨迹，不因其可能受 child 影响而删除。

因此 Guardian 不判断“子代理为什么建议这样做”，只判断“主体当前申请的精确动作是否符合用户输入、主体既往交付和主体自己建立的委托包络”。子代理输出不能成为授权依据；主 Agent 代为执行是一个新的主体动作，必须按本次 `ActionSnapshot` 独立裁决。该边界是基于来源／角色的确定性投影，不是宿主对内容相关性的语义筛选。

DSH 工具注册表目前没有通用的“该工具会创建 Agent”语义标签。v1 必须由 adapter 对 exact live Agent scope 在该 ask 的有效执行工具集合（模型 `requestHeader.tools` 与 Code Mode 可 dispatch 工具的并集）生成闭集、版本化的 delegation classification catalog：每个 enabled tool instance 恰好标为 `delegation` 或 `ordinary`，前者还必须绑定稳定 projector。不得仅凭工具名正则猜测；任何 catalog 外、重复或无法明确分类的工具都返回 `unclassified-tool-instance`。新增 opaque 第三方工具必须先补充显式分类，ready dossier 才能继续声称完整。

## 3. 核心不变量

1. **快照语义**：卷宗绑定与当前 live request 唯一匹配的 `approval/asked` event seq；Guardian 推理期间不增量修改该卷宗。
2. **来源可追溯**：从 Session log 提取的每项材料都携带 event seq；sidecar 事实携带完整 Session 生命周期身份、请求 event seq 和 callId。
3. **动作精确**：当前待审批工具名、原始／规范化参数、已执行参数投影、请求权限和 `actionHash` 不得摘要或截断。
4. **无语义筛选**：首期不根据文本语义筛选用户消息、指令或当前 turn 工具请求。
5. **结果最小化**：历史工具轨迹不携带 stdout、stderr、文件内容、diff、工具结果正文或任意大 payload。
6. **交付可识别**：只有 DSH 正常完成 turn 的最终无工具调用 assistant 文本才可称为 Agent 交付。
7. **提权理由显式**：模型提供的 `description`、`sandbox_permissions` 和 `justification` 必须在当前审批区清楚呈现。
8. **父策略前提**：只有父 Session 的有效 approval policy 为 `ask` 时，DSH 才会调用 Guardian answerer；Reviewer child 自身继续固定为 `never`。
9. **失败关闭**：身份不匹配、审批事件关联不唯一、关键事实缺失、sidecar 冲突、动作哈希不一致或硬预算溢出均不得产生自动 allow。
10. **不改变 DSH 调度**：卷宗编译和 Guardian 审批位于当前工具执行流程内，不干预 Queue、Steer、Stop、并行池或 step 边界。
11. **跨平台协议**：卷宗接口不硬编码 WSL2；平台、是否存在 confining executor 和 enforcement 都作为不同环境事实。首期真实验收环境为 WSL2。
12. **父内容始终是数据**：parent system prompt、AGENTS、用户消息和 Agent 交付只能作为 `ApprovalReviewPacketV1` 内的数据经 Controller 投递；不得拼接进 Reviewer system prompt 或覆盖 Reviewer 固定 policy。
13. **请求与卷宗单一构造**：packet 只能由规范 constructor／parser 生成；重复出现的 parent、callId、action 和 hash 字段必须逐一相等并重新验算。
14. **后代只延伸意图**：owned 子代理及其后代归属于主体的委托包络，但不会增加主体的用户授权；任何主体代执行仍是新的主体动作。
15. **子输出不入卷宗**：child transcript、tool output、report 和 closing message 不进入 Guardian；不得从 child 输出重建 justification、动作参数或授权。
16. **委托请求精确保留**：主体发出的初始委托、后续 follow-up、agent workflow 和 interrupt 控制按父 Session 请求顺序保留精确参数与最小状态，不以摘要替代。
17. **委托分类闭集**：冻结工具目录中的每个 enabled tool instance 都必须在 versioned delegation classification catalog 中恰好出现一次，并明确标为 `delegation` 或 `ordinary`；delegation projector 缺失、分类冲突或存在未分类工具时失败关闭，不能靠名称启发式补造。
18. **v1 主体限于根 Agent**：live requester 必须没有 `parentSessionId`，且 header／runtime depth 取最大值后的有效委派深度必须为 `0`；非根 requester 即使触发 approval answerer 也不得产生 ready dossier。

## 4. 审批时序

主／根 Session 的有效 policy 必须为 `ask`，且 v1 拒绝任何带 `parentSessionId`，或 exact live Agent 的 header／runtime effective delegation depth 为正的 requester。原生工具调用和 Code Mode 嵌套 dispatch 分别以 `tool/call` 与 `tool/code-dispatch-start` 作为请求事实：

```text
父模型产生顶层 tool-call，或其 run_code 程序发起嵌套 dispatch
→ DSH 记录 tool/call，或 tool/code-dispatch-start
→ tools/pre-execute 捕获 ActionSnapshot + versioned projector identity
→ 工具申请临时扩大的 sandbox 权限
→ DSH 记录带内部 id 的 approval/asked
→ DSH approval service 调用本插件的 live approval/request answerer
→ adapter 从 request.agent 绑定 exact Agent/Session authority
→ 用 open turn + callId + toolName + reason 唯一关联尚未 decided 的 approval/asked
→ 以该 approval/asked.seq 冻结 throughSeq，并解析该 ask 的 environment
→ 在审批前持久化 execution projection + immutable approval snapshot
→ 读取 Session log + 校验 sidecar
→ 查找／首次创建／恢复 Managed Guardian
→ 创建绑定 Reviewer identity／deadline 的 ApprovalReviewRequest
→ 用唯一 constructor 编译并封装完整 ApprovalReviewPacketV1
→ arm decision channel
→ 经 Controller 私有通道投递 ApprovalReviewPacketV1
→ Guardian 通过唯一结构化决策工具返回结果
→ 宿主校验 identity／generation／actionHash／deadline
→ 映射为 DSH approval outcome
→ DSH 原生工具执行器决定是否执行动作
```

`ApprovalRequest` 本身不公开 `approval/asked.id` 或 event seq，因此不能直接声称已经绑定。关联算法必须在同一个 open turn 中按 callId、toolName 和 reason 查找与 live request 完全一致、尚无 `approval/decided` 配对的 ask；必须得到唯一候选，随后把候选的 id、seq 和时间写入卷宗。零个或多个候选均失败关闭。v1 还要求 live request 带 callId；无 callId 的通用 permission ask 下沉人工或返回 unavailable。

若父 Session 的有效 policy 为 `never`，DSH 会记录 `approval/asked`，直接记录 `approval/decided: rejected`，且不会派发 `approval/request` answerer；因此不会编译 Guardian dossier。该行为与 Reviewer child 固定为 `never` 是两个独立事实。

用户在审批期间发出的 Queue／Steer 输入尚未进入当前 step，不属于冻结卷宗；Stop 通过原生 AbortSignal 取消审批。并行执行产生的后续 Session 事件也不越过已匹配 ask 的 `throughSeq`。

## 5. 顶层候选接口

以下接口使用项目领域层已有的 `JsonValue`、`ActionSnapshot` 和 `ApprovalReviewRequest` 概念。实现时领域层不得 import DSH 类型。

```ts
interface ApprovalReviewPacketV1 {
  readonly version: 1
  readonly kind: 'approval-review-packet'
  readonly request: ApprovalReviewRequest
  readonly dossier: GuardianDossierV1
  readonly dossierHash: string
}

declare const sourceVerifiedDossierV1Brand: unique symbol

/** Module-private compiler result; the brand is never serialized. */
interface SourceVerifiedDossierV1 {
  readonly dossier: GuardianDossierV1
  readonly dossierHash: string
  readonly [sourceVerifiedDossierV1Brand]: true
}

interface ApprovalReviewPacketCodecV1 {
  create(input: {
    readonly request: ApprovalReviewRequest
    readonly verified: SourceVerifiedDossierV1
  }): ApprovalReviewPacketV1

  parse(input: unknown): {
    readonly packet: ApprovalReviewPacketV1
    readonly assurance: 'internal-consistency-only'
  }
}

interface GuardianDossierV1 {
  readonly version: 1
  readonly kind: 'guardian-dossier'
  readonly freeze: DossierFreezeV1
  readonly environment: EnvironmentSectionV1
  readonly instructions: InstructionSectionV1
  readonly interaction: InteractionSectionV1
  readonly currentTurnTools: ToolTrajectorySectionV1
  readonly pendingApproval: PendingApprovalSectionV1
  readonly completeness: DossierCompletenessV1
}

interface DossierFreezeV1 {
  readonly parent: SessionLifecycleIdentityV1
  readonly throughSeq: number
  readonly currentTurn: number
  readonly currentStep: number
  /** Time of the frozen approval/asked event, not the wall clock of recompilation. */
  readonly frozenAt: number
}

interface SessionLifecycleIdentityV1 {
  readonly sessionId: string
  readonly sessionFormatVersion: number
  readonly createdAt: number
  readonly cwd?: string
}

interface EventRefV1 {
  readonly seq: number
  readonly type: string
  readonly turn?: number
  readonly step?: number
}
```

`dossierHash` 必须复用仓库 `src/domain/json.ts` 的 `snapshotJson()`／`canonicalJson()` 和现有 protocol digest 约定，而不是另造“canonical JSON”：只接受无 cycle／hole 的 plain JSON；数字必须 finite 且不得为 `-0`；对象 key 按 JavaScript 字符串默认排序递归排列，数组保持原序，字符串／数字使用 `JSON.stringify` 词法且不做 Unicode normalization。所有 seq、turn、step、blockIndex、timestamp、byte count 等结构整数另行要求为非负 safe integer。

hash preimage 是下列含结尾 NUL 的 domain separator UTF-8 字节，紧接 canonical JSON UTF-8 字节，不加换行；结果编码为 `sha256:` + 64 位小写 hex。首期该 hash 用于可重建性、测试和审计，不替代既有 `actionHash`，也不自动扩张当前 `ApprovalDecision` 的授权语义。

```text
dsh-approve-for-me/guardian-dossier/v1\0
```

`ApprovalReviewPacketV1` 不允许对象字面量自由拼装，但必须区分两级保证，不能让 packet-only parser 冒充事实源验证器。

**Source-backed compiler／constructor** 持有 `ParentSessionFactSnapshotV1` 与 sidecar，负责：

1. 要求 live `request.callId` 存在，并验证 authority、根 requester、Session lifecycle 与 effective depth；
2. 唯一关联 request event／approval ask，验证 toolName、callId、reason、turn／step、`throughSeq`、execution projection、immutable approval snapshot 和 confinement；
3. 验证 effective tools、closed-world classification、event projection／argument semantics version，以及 durable receipt 与 request／result event 的绑定；
4. 从全部冻结 source attempts 计算完整 historical delegation set，逐项反查 event ref，并验证 current-turn set 与第四段严格双射，拒绝 missing／extra／duplicate；
5. 只有完成上述外部验证后才调用内部 `createApprovalReviewPacketV1()`。实现应以 module-private brand／不可伪造 constructor input 表示“source-verified dossier”，该 brand 不序列化，也不能由 parser 从 packet 恢复。

**Packet constructor／parser** 只保证序列化对象的内部规范一致性：

1. 验证所有版本 discriminator、exact keys、非负 safe integers、唯一严格递增 event seq／delegation order；若接收 raw JSON，必须在对象物化前拒绝 duplicate key，不能依赖 `JSON.parse` 的 last-key-wins；
2. 验证 `request.parentSessionId == dossier.freeze.parent.sessionId`、request／pending callId、toolName、action、reason 和 actionHash 的重复字段 canonical 相等；
3. 验证 environment／interaction 内部声明为根 requester，`principalSessionId` 等于 parent，`descendantsGrantAuthority === false`，`childOutputPolicy === 'exclude-direct-origin-v1'`；
4. 重算 actionHash、tool schema fingerprints、closed-world classification catalog fingerprint，验证 catalog 与 packet 内 `environment.effectiveTools` 集完全相等；
5. 仅对 packet 同时携带的当前 turn attempts 与 ledger entries重算严格双射，验证所有 entry／receipt 的内部 descriptor 约束；
6. 重新计算 `dossierHash`。

packet-only parser 无法证明历史 entry 真来自父 Session，也无法证明 ledger 对 source prefix 完整；其返回值必须标记为 `internal-consistency-only`，不能重新获得 compiler 的 source-verified brand。Controller 只投递本进程 source-backed compiler 直接产生的 packet；若未来允许跨进程接收 packet 后恢复 source assurance，必须增加外部可验证的 source-prefix commitment／proof 和相应 verifier input。任何层级的不一致都拒绝，不把冲突字段交给 Guardian 自行选择。

## 6. 第一段：环境信息

“完整环境信息”只指 **DSH 正式暴露、父 Agent 实际看到、且会影响动作或权限含义的环境**。不得读取或转发任意 `process.env`，不得额外扫描凭据、SSH 配置或宿主秘密。

```ts
interface EnvironmentSectionV1 {
  readonly session: {
    readonly id: string
    readonly formatVersion: number
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSessionId?: string
    readonly seedLength?: number
    readonly origin?: string
    readonly headerDelegationDepth?: number
    readonly runtimeSubagentDepth?: number
    readonly effectiveDelegationDepth: number
    readonly agentPreset?: string
  }
  readonly requestHeader: {
    readonly config: JsonValue
    readonly adapterDefaults?: JsonValue
    readonly system?: string
    readonly tools: readonly JsonValue[]
  }
  readonly requestContext?: {
    readonly provider: string
    readonly model: string
    readonly contextWindow?: number
  }
  readonly effectiveTools: readonly EffectiveToolInstanceV1[]
  readonly runtimeContexts: readonly LoggedContextMessageV1[]
  readonly execution: ExecutionEnvironmentProjectionV1
}

type ExecutionEnvironmentProjectionV1 = {
  readonly version: 1
  readonly platform: string
  readonly commandFamily?: 'bash' | 'powershell' | 'other'
  /** Ready dossier construction additionally requires this value to be `ask`. */
  readonly approvalPolicy: 'ask' | 'never'
  readonly confinement: ConfinementProjectionV1
}

type ConfinementProjectionV1 =
  | {
      /** No confining executor is composed; this is not danger-full-access. */
      readonly kind: 'unconfined-composition'
    }
  | {
      readonly kind: 'sandbox-policy'
      readonly workspaceRoot: string
      readonly standingMode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly lastObservedEnforcement?: 'full' | 'partial'
    }

interface EffectiveToolInstanceV1 {
  readonly toolName: string
  readonly toolSchemaFingerprint: string
  readonly callableFrom: readonly ('model-tool-call' | 'code-dispatch')[]
}

interface LoggedContextMessageV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly source: JsonValue
  readonly content: readonly JsonValue[]
}
```

### 6.1 提取规则

- `session` 的持久字段来自父 Session header；`runtimeSubagentDepth` 来自 exact live `request.agent.options.subagentDepth`，effective depth 取 header／runtime 最大值并写入 immutable approval snapshot；
- `requestHeader` 使用当前 step 对应的最新完整 `request/header`，字段是 DSH 的 `config`／`adapterDefaults`／`system`／`tools`；
- `requestContext` 使用当前 route 对应的最新 `request/context`；
- `system` 和 `requestHeader.tools` 保留父模型本次请求实际看到的版本；`effectiveTools` 由 exact live Agent scope 冻结模型调用与 Code Mode dispatch 的并集，tool name 必须唯一，每个 schema 以项目 canonical digest 绑定 classification catalog 的 `toolSchemaFingerprint`；
- `effectiveTools`、event projection policy 和完整 classification catalog 与本次 ask 的 immutable approval snapshot 一起持久化；历史重建不得用后来 profile 的工具集替换；
- `runtimeContexts` 收录当前 surface 中 DSH 生成的 runtime snapshot 类上下文，但排除下一段单独呈现的 `agent-instructions`；
- approval policy 使用 DSH 正式 resolver 的当前有效值；ready dossier 必须为 `ask`；
- `ctx.shell.sandboxMode === undefined` 等“未组合 confining executor”事实映射为 `unconfined-composition`，绝不能伪装成 `danger-full-access`；只有正式 sandbox policy resolver 提供的值才进入 `sandbox-policy`；
- platform、命令族、当前解析出的默认策略及实际 enforcement 来自 DSH live composition，并在该 ask 的 immutable approval snapshot 中冻结，不根据路径字符串猜测；
- `lastObservedEnforcement` 只是最近一次可关联执行事实，不得伪装成当前待执行动作已经获得的 enforcement 保证；
- 如果有效 policy／sandbox mode 只来自部署默认值而不在 Session event 中，则重建必须使用该 ask 审批前持久化的 immutable environment snapshot；不能拿重建时的新 profile 默认值替换旧值。

首期保留完整 parent system prompt 和完整工具 schema 集，用于测量真实成本。若实验显示它们成本过高，后续版本再决定改为结构化白名单或目标工具 schema；v1 编译器不得静默删减。

## 7. 第二段：已生效项目指令

DSH 的 agent-instructions 插件会将 `AGENTS.md`、`CLAUDE.md` 及 local overlay 作为带来源信息的模型可见消息写入 Session。卷宗必须复用这些已记录内容，不在审批时重新读取磁盘。

```ts
interface InstructionSectionV1 {
  readonly messages: readonly InstructionMessageV1[]
}

interface InstructionMessageV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly source: {
    readonly kind: string
    readonly form: 'instructions'
    readonly baseline?: boolean
    readonly baselineIdentity?: string
    readonly changes?: readonly JsonValue[]
  }
  readonly content: readonly JsonValue[]
}
```

### 7.1 提取规则

- 只读取冻结 revision 的有序 surface 中仍然生效的 instruction 消息；
- 保留完整模型可见内容、scope／path／digest 等来源元数据和顺序；
- 同时支持 DSH 默认候选 `AGENTS.md`、`CLAUDE.md` 及其 local overlays；
- 文件在审批期间发生变化，不改变已冻结卷宗；
- 无 instructions 插件或没有指令文件时，返回空数组，不伪造默认内容；
- 编译器不解释某条项目指令是否构成用户授权。

## 8. 第三段：用户—主 Agent 交付链与委托包络

只提供全部直接用户消息而不提供前一轮主 Agent 交付，会使“继续”“就这么做”“按你的方案来”等输入失去指代对象；只看主 Agent 最终提权动作而不保留它此前发出的委托，又会丢失该动作所属的事务范围。因此第三段同时提供按 DSH turn 组织的用户—主 Agent 交付链，以及按父 Session 请求顺序组织的 principal delegation ledger。

```ts
interface InteractionSectionV1 {
  readonly turns: readonly InteractionTurnV1[]
  readonly delegations: PrincipalDelegationLedgerV1
}

interface PrincipalDelegationLedgerV1 {
  readonly model: 'principal-extension-v1'
  readonly principalSessionId: string
  /** Descendants inherit task attribution, never user authority. */
  readonly descendantsGrantAuthority: false
  readonly childOutputPolicy: 'exclude-direct-origin-v1'
  readonly classificationCatalog: DelegationToolClassificationCatalogV1
  readonly entries: readonly PrincipalDelegationEntryV1[]
}

interface DelegationToolClassificationCatalogV1 {
  readonly version: 1
  readonly eventProjectionPolicyId: 'dsh-session-facts-v1'
  readonly argumentSemanticsId: string
  readonly fingerprint: string
  /** Exact closed-world classification of every instance in environment.effectiveTools. */
  readonly descriptors: readonly DelegationToolDescriptorV1[]
}

type DelegationToolDescriptorV1 =
  | {
      readonly classification: 'ordinary'
      readonly toolName: string
      readonly toolSchemaFingerprint: string
      readonly classificationId: string
    }
  | {
      readonly classification: 'delegation'
      readonly projectorId: string
      readonly toolName: string
      readonly toolSchemaFingerprint: string
      readonly operation: 'start' | 'followup' | 'orchestrate' | 'interrupt' | 'extension'
      readonly receiptPolicy:
        | { readonly kind: 'none' }
        | {
            readonly kind: 'required-on-completed'
            readonly receiptKinds: readonly PrincipalDelegationReceiptV1['kind'][]
          }
      /** Stable JSON configuration for a renamed/provider-bound tool and its typed safe receipt. */
      readonly configuration?: JsonValue
    }

interface PrincipalDelegationEntryV1 {
  readonly projectorId: string
  /** Explicit cross-turn total order: [turn, requestEventSeq, requestSubindex]. */
  readonly order: readonly [turn: number, requestEventSeq: number, requestSubindex: number]
  /** Exact parent-side request plus content-free minimal outcome. */
  readonly attempt: ToolAttemptV1
  readonly operation: PrincipalDelegationOperationV1
  /** Optional safe receipt from exact principal identity + schema-validated canonical tool value, never rendered text. */
  readonly receipt?: PrincipalDelegationReceiptV1
}

type PrincipalDelegationReceiptV1 =
  | {
      readonly kind: 'continuable-child-started'
      readonly childSessionId: string
      readonly directParentSessionId: string
    }
  | {
      readonly kind: 'foreground-run-settled'
      readonly runId: string
      readonly directParentSessionId: string
    }
  | {
      readonly kind: 'background-job-started'
      readonly jobId: string
      readonly ownerSessionId: string
    }
  | {
      readonly kind: 'followup-accepted'
      readonly targetChildSessionId: string
      readonly messageId: string
    }
  | {
      readonly kind: 'interrupt-accepted'
      readonly targetAgentId: string
      /** DSH acceptance is not proof that the target existed or stopped. */
      readonly accepted: true
    }

type PrincipalDelegationOperationV1 =
  | {
      readonly kind: 'start'
      readonly context: 'fresh' | 'parent-completed-turns' | 'provider-defined'
    }
  | {
      readonly kind: 'followup'
      readonly targetChildSessionId: string
    }
  | {
      readonly kind: 'orchestrate'
      readonly family: 'workflow' | 'ralph' | 'provider-defined'
    }
  | {
      readonly kind: 'interrupt'
      readonly targetAgentId: string
    }
  | {
      readonly kind: 'extension'
      readonly family: string
      readonly operation: string
    }

interface InteractionTurnV1 {
  readonly turn: number
  readonly directUserMessages: readonly DirectUserMessageV1[]
  readonly delivery?: AgentDeliveryV1
  readonly end?: TurnEndSummaryV1
}

interface DirectUserMessageV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly content: readonly JsonValue[]
  readonly surfaceState: 'visible' | 'superseded'
}

interface AgentDeliveryV1 {
  readonly event: EventRefV1
  readonly messageId: string
  readonly textBlocks: readonly string[]
}

type TurnEndSummaryV1 =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'error'; readonly code?: string }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }
  | {
      /** DSH TurnEndReasonMap is plugin-extensible; preserve unfamiliar JSON verbatim. */
      readonly kind: 'extension'
      readonly reason: JsonValue
    }
```

### 8.1 直接用户消息

直接用户消息必须满足：

```text
event.type == user/message
message.source.kind == user
```

规则：

- 收录冻结 revision 前全部直接用户消息，不按语义相关性筛选；
- 保持 event seq 和 turn 顺序；
- 保留全部 content blocks；
- 插件注入、goal continuation、tool result、recall、notice、snapshot 和 agent-instructions 不冒充直接用户消息；
- raw log 中存在但不再位于当前 surface 的直接用户消息仍可保留为历史事实，但必须标记 `superseded`，不得与当前可见输入混淆。

### 8.2 Agent 交付识别

一个 assistant 消息只有同时满足以下条件才称为该 turn 的交付：

1. 对应 turn 有 `turn/end.reason.kind == 'completed'`；
2. 它是该 turn 最后一个 `assistant/message`；
3. 消息未标记 `interrupted`；
4. 消息不包含 `tool-call` block；
5. 只提取面向用户的 text blocks，不提取 reasoning、raw chunks 或工具调用；
6. 至少存在一个非空 text block，否则不生成空交付。

边界行为：

- `aborted`、`blocked`、`error`、`max-tokens`、crash `interrupted` 及未知 extension reason 的 turn 不生成虚假的 Agent 交付，只保留完整 turn 状态；
- 当前尚未结束的 turn 不生成交付；
- 因 concludes-turn 工具结束、最后 assistant 消息仍包含 tool-call 的 completed turn 不生成交付；
- 自动 continuation turn 即使没有直接用户消息，只要存在合格最终交付，也按原 turn 位置保留。

Agent 交付只用于恢复对话指代和 Agent 已向用户陈述的方案或结果；它仍明确标记为 assistant 内容，是否足以支持授权由 Guardian 判断。

### 8.3 委托包络提取

`PrincipalDelegationLedgerV1` 收录冻结点前、由主体 Session 发出的全部已声明 delegation-capable 工具请求，包括失败、取消、尚未启动和 pending 请求；请求是否成功不改变主 Agent 曾表达该委托意图的事实。entry 使用与第四段相同的 `ToolAttemptV1`，因此 native 调用保留模型产生的 `rawArguments`，Code Mode 保留 DSH 记录的 normalized `arguments`，结果仍只显示最小状态。

规则：

- classification catalog 与冻结 enabled tool instance 集合必须一一对应：同名缺失、重复 descriptor、额外 descriptor 或工具 schema／配置与 fingerprint 不一致都失败关闭；`ordinary` 是带稳定 `classificationId` 的显式版本化结论，不是“未命中 projector”的默认值；`argumentSemanticsId` 绑定本目标 DSH 对 native raw arguments 与 Code Mode normalized arguments 的解释版本；
- v1 为避免给历史 entry 套用后来工具语义，要求冻结父 Session prefix 内的有效工具分类保持不变：每个历史 `request/header.tools` 和已启动 execution 的 `toolClassification.classificationCatalogFingerprint` 都必须与本次 immutable approval snapshot catalog 兼容／相等；工具增删、同名 schema 漂移、classification／projector 变化都返回 `delegation-catalog-mismatch`。未来支持 per-step catalogs 必须升级 dossier 版本；
- `delegation` descriptor 必须绑定 exact tool instance name、稳定 `projectorId`、操作类别和解释 renamed／provider-bound instance 及 typed safe receipt 所需的规范配置；catalog fingerprint 纳入 dossier hash；
- stock `subagent` 映射为 `start/fresh`，`subagent_fork` 映射为 `start/parent-completed-turns`，`send_message` 映射为 `followup`，`interrupt_agent` 映射为 `interrupt`；workflow／Ralph 和外部 provider 只有存在明确 projector 时才映射为 `orchestrate`／`provider-defined`；
- `description`、`prompt`、`message`、workflow script／args、Ralph objective 等事务内容不复制到另一套摘要字段；Guardian 直接读取 `attempt.request` 中的精确父侧参数，避免两个 payload 漂移；
- `targetChildSessionId`／`targetAgentId` 只从经过 schema 验证的父请求参数投影，不能从 child report 文本猜测；schema-validated canonical tool value 可以投影 content-free receipt：continuable child id、foreground run id、background job id、follow-up message id 或 interrupt acceptance，输出正文必须先丢弃；
- descriptor 的 `receiptPolicy: required-on-completed` 是强约束：`attempt.outcome.kind === 'completed'` 时必须存在且只存在一个允许 kind 的 durable receipt，缺失、额外或 kind 不符均 `missing-required-delegation-receipt`／conflict；非 completed outcome 不伪造成功 receipt，`receiptPolicy: none` 禁止 entry 携带 receipt；
- stock start receipt 由已冻结 tool descriptor + exact 主体调用 + canonical result value 证明 parent-side ownership。成功的 `send_message` 又由 DSH direct-parent authorization 证明目标可跟进；`interrupt_agent { accepted: true }` 只证明请求被接受，不证明目标存在、已停止或属于直接 child；
- entries 的 `order` 固定为 `[turn, requestEventSeq, requestSubindex]`，三个分量都是非负 safe integer，并按数字字典序严格递增；同一 request ref 只能出现一次。当前 turn 中由 classification catalog 判定为 delegation 的第四段 attempt 必须与第三段 entry 构成双射，且 request／outcome canonical 相等；历史 entry 也必须逐项反查 source event ref；
- nested descendants 不递归展开；整棵后代树只受主主体已表达的事务包络约束，后代内部再委托不会扩大该包络；
- direct child-origin payload 不进入 dossier：parent `user/message` 的 `subagent-report/relay` 与 `subagent-settled/notice` 被 source projection 替换为无正文 exclusion record；`send_message` 的 child-side `coordinator/relay` 不在父 Session，父侧只保留该工具调用和 safe receipt；
- foreground child output、workflow aggregate output 和通过 `job_output` 取得的 child 正文同样在 source projection 边界丢弃。主 Agent 随后自己写出的 assistant 内容、follow-up 和工具请求照常保留；编译器不尝试识别或删除其中可能转述的 child 内容；
- stock top-level `workflow` 可额外校验父日志中的 `tool-workflow/run-start`、`agent-start(childId)`、`agent-end(status)` 和 `run-end` 元数据；Code Mode nested workflow 不记录这些事件，Ralph 直接使用 workflow engine、父日志也没有 per-round `tool-workflow/*` ledger，因此二者只按父工具请求／最小 outcome 建立包络，不伪造子拓扑。

任一 enabled tool 未分类、delegation projector 缺失、projection／receipt 与请求或 canonical value 冲突、source filter 版本不匹配，均返回 `incomplete`；不得把未知工具静默视为 ordinary。

## 9. 第四段：当前 turn 工具请求轨迹

该段只回答两类事实：模型在当前 turn 发出了哪些顶层 tool-call，以及模型生成的 Code Mode 程序实际启动了哪些嵌套 dispatch；随后给出每个请求截至冻结点可持久重建的最小执行结果。

```ts
interface ToolTrajectorySectionV1 {
  readonly turn: number
  readonly excludedPendingRequest: ToolRequestKeyV1
  readonly attempts: readonly ToolAttemptV1[]
}

interface ToolRequestKeyV1 {
  readonly callId: string
  /** tool/call.seq or tool/code-dispatch-start.seq */
  readonly requestEventSeq: number
}

interface ToolAttemptV1 {
  readonly request: ToolRequestRefV1
  readonly outcome: ToolAttemptOutcomeV1
}

type ToolRequestRefV1 = NativeToolRequestRefV1 | CodeDispatchRequestRefV1

interface NativeToolRequestRefV1 {
  readonly kind: 'model-tool-call'
  /** assistant/message containing the exact model-issued block. */
  readonly issuedIn: EventRefV1
  readonly blockIndex: number
  readonly callId: string
  readonly toolName: string
  /** Exact lexical JSON string produced by the model; never replaced by reserialization. */
  readonly rawArguments: string
  /** Matching durable tool/call, including synthetic aborted-before-dispatch pairs. */
  readonly callEvent?: EventRefV1
}

interface CodeDispatchRequestRefV1 {
  readonly kind: 'code-dispatch'
  /** Exact tool/code-dispatch-start event; this event does mean the nested pipeline was entered. */
  readonly dispatchStart: EventRefV1
  readonly rootCallId: string
  readonly parentCallId: string
  readonly callId: string
  readonly toolName: string
  /** JSON-normalized arguments recorded by DSH before nested dispatch. */
  readonly arguments: JsonValue
}

interface ProcessTailV1 {
  readonly exitCode: number | null
  readonly signal: string | null
}

type ToolAttemptOutcomeV1 =
  | { readonly kind: 'not-started'; readonly reason: 'queued' | 'aborted-before-dispatch' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'background-launched' }
  | {
      readonly kind: 'approval-not-granted'
      readonly outcome: 'rejected' | 'cancelled' | 'unavailable'
      readonly effectivePolicy: 'ask' | 'never'
    }
  | { readonly kind: 'tool-error'; readonly code?: string }
  | {
      readonly kind: 'sandbox-unavailable'
      readonly mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly code: string
    }
  | {
      readonly kind: 'runner-failed'
      readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly enforcement?: 'full' | 'partial'
      readonly process?: ProcessTailV1
    }
  | {
      readonly kind: 'sandbox-denied'
      readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
      readonly enforcement?: 'full' | 'partial'
      /** Present when a process ran far enough to expose a terminal state. */
      readonly process?: ProcessTailV1
    }
  | { readonly kind: 'timed-out'; readonly process: ProcessTailV1 }
  | { readonly kind: 'aborted'; readonly code?: string }
  | { readonly kind: 'process-signalled'; readonly signal: string; readonly exitCode: number | null }
  | { readonly kind: 'process-exited'; readonly exitCode: number }
```

### 9.1 收录范围与顺序

- 起点是当前 `turn/start`，终点是唯一关联的当前 `approval/asked.seq`；
- 顶层请求从各 `assistant/message` 的 tool-call blocks 重建，按 assistant event seq + block index 保持模型顺序；这能包含已经由模型发出、但因并行池容量或前序 barrier 尚未产生 `tool/call` 的请求；
- 对已经有 durable call event 的顶层请求，必须匹配同 callId 的 `tool/call`，并验证工具名和 `rawArguments` 逐字相等；不相等即失败关闭。注意 DSH 也会为完全未进入工具管线的取消调用写入 synthetic `tool/call` + `TOOL_ABORTED_BEFORE_DISPATCH`，因此 `callEvent` 本身不证明 pipeline started；
- Code Mode 嵌套请求从 `tool/code-dispatch-start` 读取，按 event seq 排序，并通过 `parentCallId` 绑定当前 turn 内的 `run_code` 父调用；其终态由同 `subCallId` 的 `tool/code-dispatch` 给出；
- 两类请求合并成数组时使用稳定总序：native key 为 `[issuedIn.seq, 0, blockIndex]`，Code Mode key 为 `[dispatchStart.seq, 1, 0]`，按数字字典序排列。它表示请求被 DSH 观察到的顺序；native 实际进入 pipeline 由 execution sidecar／结果分类证明，Code Mode 则由 `dispatchStart` 证明；
- 当前正在审批的 request 按 callId + request event seq 从轨迹中排除，由第五段完整呈现；其 `run_code` 父调用或其他 sibling 仍照常出现；
- 尚无 `callEvent` 的模型调用标记 `not-started: queued`；DSH 写入 synthetic `tool/call` + `TOOL_ABORTED_BEFORE_DISPATCH` 时标记 `not-started: aborted-before-dispatch`；
- 已有 start、但在 `throughSeq` 内没有匹配终态的调用标记 `pending`。DSH 并行调度按模型顺序提交结果，因此它可能已经在进程内结算、却尚无可重建的 durable result；卷宗不得把这种未提交状态猜成成功或失败；
- native request 永远保留模型产生的原始参数字符串。可选解析值不得替换它：JSON 解析会丢失空白、数字词法和重复 key，非法 JSON 又会被 DSH 作为字符串交给执行管线；
- Code Mode 的参数没有模型原始 JSON 字符串，其正式请求事实就是 DSH 在 dispatch 前记录的 JSON-normalized `arguments`。

因此本节不再笼统声称只有 `tool/call` 才代表“模型请求”，也不把 Code Mode 嵌套调用误装成顶层模型 tool-call。

### 9.2 结果最小化

不得向 Guardian 传递历史工具的：

- stdout／stderr；
- ToolResultMessage 正文；
- 文件内容；
- diff；
- spill path；
- 任意 tool-private `meta`；
- 冗长错误消息。

允许携带的结果事实只有上面的有类型状态和必要小字段。`tool/result.message.isError` 足以区分普通 `completed`／`tool-error`，但 shell／sandbox 等工具族必须结合已持久化 canonical sidecar，不能解析模型可见文本来猜状态。

### 9.3 结果分类规则

结果分类保持 DSH 的事实差异，不把所有“看起来没成功”的情形压成一个 `failed`：

1. 审批未授权且动作未 dispatch → `approval-not-granted`；
2. 工具明确报告 `SANDBOX_UNAVAILABLE` → `sandbox-unavailable`；
3. canonical sandbox facts 报告 runner failure → `runner-failed`；
4. canonical sandbox facts 报告 denial → `sandbox-denied`，并在存在时附带最小 process tail；
5. 前台进程依次保留 timeout、abort、signal 或 exit code；非零 exit code 是 `process-exited` 事实，不伪装成 DSH ToolExecution transport error；
6. bash 后台调用只在原 callId 下记录 `background-launched`。最终 exit／sandbox facts 属于 job 生命周期和后续 `job_*` 调用，除非未来引入独立 jobId sidecar，否则不得倒填为原调用已完成；
7. 非进程工具的 `isError: false` → `completed`，`isError: true` → `tool-error`；
8. 无 durable result → `pending`。

`sandbox-denied` 不表示整个命令从未启动、此前步骤没有副作用或状态已经回滚。`background-launched` 只表示 job 发布成功。所有更强的风险或成功含义都留给 Guardian policy。

## 10. 第五段：当前待审批请求

当前审批区是不可裁剪的核心，并与现有 `ApprovalReviewRequest.action`、`actionHash` 和 identity envelope 保持一致。

```ts
interface PendingApprovalSectionV1 {
  readonly request: ToolRequestRefV1
  readonly approvalAsked: EventRefV1
  readonly approvalRequestId: string
  readonly callId: string
  readonly toolName: string
  /** Exact arguments and permission projection seen by the approval protocol. */
  readonly action: ActionSnapshot
  readonly actionHash: string
  readonly projectorId: string
  readonly confinement: ConfinementProjectionV1
  readonly requestedSandboxMode?: 'workspace-write' | 'danger-full-access'
  readonly description?: string
  readonly justification?: string
  readonly approvalReason?: string
  /** Ordered factual candidates only; none is asserted to be retryOf this request. */
  readonly earlierSandboxDenials: readonly {
    readonly callId: string
    readonly requestEvent: EventRefV1
  }[]
}
```

### 10.1 当前请求与提权说明

`request` 必须已经进入审批所处的工具管线：native request 必须有 `callEvent: tool/call` 且存在同 request event 绑定的 pre-execute action projection，Code Mode request 必须来自 `dispatchStart: tool/code-dispatch-start`。synthetic aborted-before-dispatch native pair 不可能成为当前审批请求。callId 和工具名必须同时匹配 live `ApprovalRequest`、`approval/asked`、approval snapshot、execution sidecar 及 `ApprovalReviewRequest`。

对 DSH shell／filesystem 等沙箱升级请求：

- `description` 来自请求参数，说明动作做什么；native 请求仍以 `rawArguments` 保留其模型原文；
- `requestedSandboxMode` 来自已执行 `ActionSnapshot` 中的正式 `sandbox_permissions`／权限投影；
- `justification` 来自同一 action 参数，说明为什么该精确动作需要更宽权限；
- `approvalReason` 来自唯一关联的 DSH `approval/asked.reason`；当前 DSH 通常将其派生为 `escalate sandbox to <mode>: <justification>`；
- 编译器必须以 DSH 的参数解析规则验证 raw／normalized request、已执行 action、权限投影和 approval reason 不矛盾；
- 渲染给 Guardian 时原始 justification 只展开一次，DSH 派生 reason 在内容相同时以 provenance／结构化字段表示，避免重复占用上下文。

### 10.2 更早的 sandbox denial

DSH 没有持久 `retryOf` 关系，编译器不得根据“参数看起来相同”制造一条精确前驱边。`earlierSandboxDenials` 只列出当前 turn、冻结点之前已经确认的所有 sandbox-denied 请求，按 request event seq 排序，并通过 ref 指回第四段的完整请求和结果。

该列表不声明其中任一项与当前动作等价，也不声称当前提权是一次合法重试。“是否同一动作”“升级是否必要”“请求是否最窄”全部由 Guardian 根据原始请求、denial 事实和 justification 判断。未来若工具或 sidecar 提供正式 `retryOf`／fingerprint 协议，必须以新版本显式加入。

## 11. 编译端口

建议在应用层定义不依赖 DSH 类型的最窄端口，在 `src/dsh/` 中实现 adapter。source snapshot 是冻结时刻的内存值，不单独持久化。

```ts
interface PrincipalSessionIdentityV1 extends SessionLifecycleIdentityV1 {
  readonly parentSessionId?: string
  readonly headerDelegationDepth?: number
  readonly runtimeSubagentDepth?: number
  /** max(headerDelegationDepth ?? 0, runtimeSubagentDepth ?? 0) captured from the exact live Agent. */
  readonly effectiveDelegationDepth: number
}

interface ParentSessionFactSnapshotV1 {
  readonly version: 1
  readonly session: PrincipalSessionIdentityV1
  readonly eventProjection: {
    readonly policyId: 'dsh-session-facts-v1'
    readonly classificationCatalog: DelegationToolClassificationCatalogV1
  }
  readonly approvalBinding: {
    readonly event: EventRefV1
    readonly approvalRequestId: string
    readonly callId: string
    readonly toolName: string
    readonly reason?: string
  }
  /** Always approvalBinding.event.seq; callers cannot choose an arbitrary later revision. */
  readonly throughSeq: number
  readonly events: readonly SessionFactEventV1[]
  /** Deterministic index derived only from executionFacts[].delegationReceipt. */
  readonly delegationReceipts: readonly DelegationReceiptFactRecordV1[]
  readonly executionFacts: readonly ToolExecutionFactRecordV1[]
  readonly approvalSnapshots: readonly ApprovalSnapshotRecordV1[]
}

interface SessionFactEventEnvelopeV1 {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: JsonValue
  /** Derived annotation; not part of the original SessionEvent envelope. */
  readonly surfaceState?: 'visible' | 'superseded'
}

type SessionFactEventV1 =
  | (SessionFactEventEnvelopeV1 & {
      readonly retention: 'included'
      readonly data: JsonValue
    })
  | (SessionFactEventEnvelopeV1 & {
      readonly retention: 'excluded-content'
      readonly exclusion:
        | 'child-origin-message'
        | 'tool-result-content'
        | 'delegation-result-content'
        | 'job-output-content'
      readonly source?: {
        readonly kind: string
        readonly form?: string
        readonly senderSessionId?: string
      }
      /** Measurement only; no child/tool content or digest is retained. */
      readonly originalBytes?: number
    })

interface DelegationReceiptFactRecordV1 {
  readonly session: SessionLifecycleIdentityV1
  readonly requestEventSeq: number
  readonly resultEvent: EventRefV1
  readonly callId: string
  readonly classificationCatalogFingerprint: string
  readonly projectorId: string
  readonly receipt: PrincipalDelegationReceiptV1
}

interface ParentSessionFactSource<Parent> {
  bindAndSnapshot(input: {
    /** Must have been derived from this exact live ApprovalRequest.agent once. */
    readonly authority: ParentAuthority<Parent, string>
    readonly liveRequest: {
      readonly callId: string
      readonly toolName: string
      readonly reason?: string
    }
    readonly signal?: AbortSignal
  }): Promise<ParentSessionFactSnapshotV1>
}

interface ExecutionFactRepository {
  get(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly callId: string
    readonly requestEventSeq: number
  }): Promise<ToolExecutionFactRecordV1 | undefined>

  put(record: ToolExecutionFactRecordV1): Promise<void>
}

interface ApprovalSnapshotRepository {
  get(input: {
    readonly session: SessionLifecycleIdentityV1
    readonly approvalRequestId: string
    readonly approvalAskedSeq: number
  }): Promise<ApprovalSnapshotRecordV1 | undefined>

  create(record: ApprovalSnapshotRecordV1): Promise<'created' | 'identical'>
}

interface PrincipalDelegationProjector {
  readonly catalog: DelegationToolClassificationCatalogV1

  project(input: {
    readonly principalSessionId: string
    readonly attempt: ToolAttemptV1
    readonly descriptor: Extract<DelegationToolDescriptorV1, { readonly classification: 'delegation' }>
    readonly receipt?: DelegationReceiptFactRecordV1
  }):
    | {
        readonly kind: 'delegation'
        readonly entry: PrincipalDelegationEntryV1
      }
    | {
        readonly kind: 'invalid'
        readonly reason:
          | 'missing-projector'
          | 'malformed-request'
          | 'catalog-mismatch'
          | 'receipt-mismatch'
          | 'topology-mismatch'
      }
}

interface GuardianDossierCompilerDependencies {
  readonly delegationProjector: PrincipalDelegationProjector
}

interface GuardianDossierCompiler {
  compile(input: {
    readonly request: ApprovalReviewRequest
    readonly facts: ParentSessionFactSnapshotV1
    readonly signal?: AbortSignal
  }): DossierCompilationResultV1
}

type DossierCompilationResultV1 =
  | {
      readonly kind: 'ready'
      readonly packet: ApprovalReviewPacketV1
      readonly metrics: DossierMetricsV1
    }
  | {
      readonly kind: 'incomplete'
      readonly reason:
        | 'missing-current-request-event'
        | 'missing-approval-ask'
        | 'ambiguous-approval-ask'
        | 'missing-call-id'
        | 'parent-policy-not-ask'
        | 'unsupported-delegated-requester'
        | 'authority-mismatch'
        | 'action-mismatch'
        | 'session-identity-mismatch'
        | 'missing-required-projection'
        | 'missing-required-execution-fact'
        | 'unclassified-tool-instance'
        | 'missing-delegation-projector'
        | 'missing-required-delegation-receipt'
        | 'delegation-projection-failed'
        | 'delegation-catalog-mismatch'
        | 'event-projection-policy-mismatch'
        | 'delegation-topology-mismatch'
        | 'sidecar-conflict'
        | 'budget-overflow'
        | 'aborted'
    }
```

`ParentSessionFactSource` 的 DSH adapter 必须直接接收 waterfall 回调携带的 live `ApprovalRequest`，并一次性构造 authority：`request.agent === authority.live`、`request.agent.session` 是被快照的 exact Session、`agent.id === session.id === authority.sessionId`。不得从裸 sessionId 重新查找另一个 live Agent，也不得允许调用方另传任意 root／Session 组合。v1 随后必须从 exact live Agent 同时读取 Session header depth 与 `agent.options.subagentDepth`，计算两者最大值，并验证没有 `parentSessionId` 且 effective depth 为 `0`；这些值在 approval snapshot 中冻结，失败即 `unsupported-delegated-requester`。

`ParentSessionFactSnapshotV1` 不是第三份持久记录，也不再是 raw `data` 的无条件 lossless 副本。adapter 必须先只解析 event envelope、message source 和已冻结工具分类，再决定是否复制正文：纳入卷宗的事实保持 lossless DSH-neutral 投影；child-origin message、工具结果／delegation result／job output 正文在进入 snapshot 对象前替换为 typed `excluded-content` record。底层 JSONL reader 必然会反序列化包含记录，因此本规范保证的是“不在 source snapshot 中保留、不投递 Guardian”，而不是声称文件字节从未被读取。filter policy id 与 catalog fingerprint 都必须随 snapshot 冻结。`delegationReceipts` 只由 durable execution records 的 receipt 字段投影；冷恢复不得从持久化 rendered tool result 反向解析。

compiler 必须是确定性的纯转换：同一冻结 Session log、同一 versioned sidecar、同一 event projection policy 和同一规范配置产生相同 dossier 和 hash。这里的可重建性依赖 sidecar 已在审批前保存 execution action projection 与该 ask 的 immutable environment snapshot；若当时未保存，则只能报告 incomplete，不能用当前运行默认值补写历史。

`GuardianDossierCompilerDependencies.delegationProjector` 由 composition root 显式注入，不从全局 registry 临时发现。其 closed-world catalog 必须在冻结前规范化，并与 source snapshot catalog 及 `environment.effectiveTools` 一一对应；compiler 将 catalog 原样写入第三段，对每个主体工具 attempt 先取唯一 classification，再仅对 `delegation` 调用 `project()`；`ordinary` attempt 不进入 ledger。未分类／重复分类、delegation projector 缺失、entry／safe receipt 与输入不一致，或 event projection／argument semantics id 不匹配都属于 incomplete。projector 不读取 child Session，也不接收已排除正文。

建议 catalog fingerprint domain separator：

```text
dsh-approve-for-me/delegation-tool-classification/v1\0
```

该 fingerprint 使用与 `dossierHash` 相同的 UTF-8、`canonicalJson()`、`sha256:<lowerhex>` 规则，输入是不含 `fingerprint` 自身、按 `toolName` 排序后的 catalog core。descriptor `toolName` 集必须与冻结 enabled tools 集完全相等。`toolSchemaFingerprint` 对工具的规范 schema 使用 domain `dsh-approve-for-me/tool-schema/v1\0` 和同一 digest 规则。

## 12. Sidecar 候选记录

Storage Domain 首期使用两个不同生命周期的表：per-execution 记录保存 pre-execute action 与最终结果；immutable per-approval snapshot 保存某一次 `approval/asked` 真正采用的环境。这样同一 ToolExecution 顺序发起多次审批时不会覆盖较早案件。

```ts
interface ToolExecutionFactRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly request: {
    readonly kind: 'model-tool-call' | 'code-dispatch'
    readonly eventSeq: number
    readonly eventType: 'tool/call' | 'tool/code-dispatch-start'
    readonly callId: string
    readonly toolName: string
    readonly parentCallId?: string
  }
  readonly toolClassification: {
    /** v1 requires one unchanged catalog across the frozen parent prefix. */
    readonly classificationCatalogFingerprint: string
    readonly descriptor: DelegationToolDescriptorV1
  }
  readonly projection: {
    /** Fixed built-in id or a caller-supplied stable, versioned action projector id. */
    readonly projectorId: string
    /** Exact value captured when this execution entered tools/pre-execute. */
    readonly action: ActionSnapshot
    readonly actionHash: string
    readonly observedAt: number
  }
  readonly result?: {
    readonly eventSeq: number
    readonly eventType: 'tool/result' | 'tool/code-dispatch'
  }
  /** Content-free receipt persisted at durable result join when the descriptor requires one. */
  readonly delegationReceipt?: {
    readonly classificationCatalogFingerprint: string
    readonly projectorId: string
    readonly receipt: PrincipalDelegationReceiptV1
  }
  readonly outcome: ToolAttemptOutcomeV1
  readonly updatedAt: number
}

interface ApprovalSnapshotRecordV1 {
  readonly version: 1
  readonly session: SessionLifecycleIdentityV1
  readonly approval: {
    readonly requestId: string
    readonly askedEventSeq: number
    readonly callId: string
    readonly toolName: string
    readonly reason?: string
  }
  readonly execution: {
    readonly requestEventSeq: number
    readonly projectorId: string
    readonly actionHash: string
  }
  /** Resolved at bind time for this exact ask, not copied from pre-execute time. */
  readonly environment: ExecutionEnvironmentProjectionV1
  readonly dossierProjection: {
    readonly eventProjectionPolicyId: 'dsh-session-facts-v1'
    readonly requesterDepth: {
      readonly parentSessionId?: string
      readonly headerDelegationDepth?: number
      readonly runtimeSubagentDepth?: number
      readonly effectiveDelegationDepth: number
    }
    readonly effectiveTools: readonly EffectiveToolInstanceV1[]
    readonly classificationCatalog: DelegationToolClassificationCatalogV1
  }
  readonly observedAt: number
}
```

`ToolExecutionFactRecordV1` 不再单列一个可与 `outcome` 矛盾的 `sandbox` 对象；sandbox、runner、process 和 background 事实通过互斥 outcome variants 表示。`projection.action` 是执行管线看见的已解析值，而 native 模型原始 `rawArguments` 仍只来自 Session log。对 receipt-bearing delegation，result join 在丢弃输出正文前只提取 descriptor 明确列出的 content-free receipt，并与 request／result event 一起持久化在同一 execution record；冷恢复不重读 excluded result content。`ApprovalSnapshotRecordV1` 不复制 action 正文，但以 projectorId + actionHash 不可变地绑定 execution record，并冻结本次 ask 的 effective tool set、closed-world classification catalog 与 source projection policy。

### 12.1 Storage Domain 规则

- 实现阶段必须显式依赖并注入 DSH `storageDomain` service；未组合该官方服务时插件不得回退到私有 JSON 文件，自动审批保持不可用／下沉人工；
- 使用 `ctx.storageDomain.open(...)`、`defineDomain(...)`、`domainTable(...)` 和 Zod record schema；
- domain／table／unit 名必须匹配 `^[a-z][a-z0-9_]*$`；候选 domain 名为 `approve_for_me`，format version 为 `1`，包含 `executions` 与 `approval_snapshots` 两张表；
- Storage Domain table key 是单个字符串，不是假想的多列主键。execution key 使用 `e1_` + `base64url(UTF8(canonicalJson([sessionId, sessionFormatVersion, createdAt, cwd ?? null, callId, requestEventSeq])))`；approval key 使用 `a1_` + `base64url(UTF8(canonicalJson([sessionId, sessionFormatVersion, createdAt, cwd ?? null, approvalRequestId, approvalAskedSeq])))`；JSON 数组结构和可逆 base64url 避免字段拼接碰撞；
- 只保存 lossless JSON。`tools/pre-execute` 先在进程内保留不可变 action projection；遇到 approval ask 时必须立即持久化 pending execution record，无审批的调用可在 durable result join 时直接创建 terminal record；
- execution record 可用 Storage Domain 的整记录原子覆盖语义从 pending 更新为 terminal，但 `session`／`request`／`toolClassification`／`projection` 前缀必须 canonical 相等；terminal join 可以一次性增加 `result`、`outcome` 和 descriptor 允许的 `delegationReceipt`，之后任何变化均为 conflict；
- approval snapshot 是 immutable／create-once：相同 key 的字节等价重试可幂等成功，任何不同内容都视为 conflict，永不被同 callId 的后续 ask 覆盖；
- 读取时必须逐字段复核完整 Session 生命周期、request／ask event seq、callId、event type、工具名、projectorId 和 actionHash，不能只相信 table key 或 bare sessionId；
- 对应 `tool/call`／`tool/code-dispatch-start` 必须已经存在并可关联。execution sidecar 中的 action 必须能与 raw／normalized 请求按 DSH 执行参数规则核对，sidecar 不能成为动作存在性的唯一事实来源；
- 关联 live ask 后、调用 Guardian 前，adapter 必须先确保 execution projection 已持久化，再为该 `approvalRequestId + approvalAskedSeq` 写 immutable approval snapshot。environment、header／runtime effective delegation depth、effective tool set、闭集分类及 source projection policy 在这一 bind 点按冻结 event prefix 与 exact live Agent scope 解析；ready snapshot 的 policy 必须为 `ask`，工具集合不得遗漏 Code Mode dispatch surface；
- 同一 callId 的第二次或后续 ask 复用不可变 action projection，但写入新的 approval snapshot，因此每次 ask 的 policy／sandbox／platform 解析结果都可独立重建；
- 终态 execution record 只有在对应 `tool/result`／`tool/code-dispatch` 已提交后才能携带 `result.eventSeq`；
- 插件卸载、sidecar 损坏或旧 format version 不得阻止父 Session 恢复，只能使自动审批或后续重建失败关闭。

### 12.2 两阶段 result join 与 durability

DSH 的 `tools/result` 会在 agent loop 追加 durable result event 之前暴露 canonical value，而 `tools/result` 和 `session/event` 都是 fire-and-forget observer；Session log 与 Storage Domain 之间也没有跨存储事务。因此 adapter 必须显式实现两阶段 join：

```text
tools/result(exec, canonicalResult)
→ 写入进程内 unmatched-observation map（不是待完成 Promise）
   key = SessionLifecycleIdentity + callId + requestEventSeq
→ 同 Session 的 session/event(tool/result | tool/code-dispatch) 到达
→ 以 callId/subCallId 和 request source 关系唯一 join
→ 同步把“已提交 result seq + 最小 canonical outcome”的写任务放入串行队列
→ Storage Domain 原子创建 terminal execution record，或覆盖 canonical 相等的 pending record
```

约束：

- `tools/result` listener 必须在返回或做任何 await 前同步 snapshot canonical value 并插入 unmatched map；native durable result 可能紧接着在同一调用栈追加；但该阶段不得提前把终态写入 sidecar，否则 sidecar 可能声称存在一个尚未提交的 Session result；
- `session/event` listener 在做任何 await 之前必须同步登记待写 Promise，尽管 listener 自身的返回值不会被 Session append 等待；
- `session/flush` 只等待该 Session 在 flush 边界前已经入队的 Storage Domain 写任务；它不得等待“未来也许会出现”的 matching result event，因此不会被 unmatched observation 永久阻塞；
- unmatched observation 保留为非阻塞内存状态以允许稍后 event join；到 enclosing `turn/end`、`session/disposed` 或插件 dispose 仍未匹配时，记录结构化 warning／metric 后 quarantine 并移除。插件 dispose 先停止新捕获，再 quarantine unmatched entries，最后 drain 已入队写任务；
- Code Mode 使用 `subCallId` 与 `tool/code-dispatch` join，不能硬编码为原生 `tool/result`；
- 如果 canonical result 已观察但 durable result event 的 shaping／append 失败，execution record 不获得虚假终态；后续卷宗按日志显示 `pending`，或在该工具族必须依赖缺失 canonical 事实时报告 incomplete；
- 结果提交后、sidecar 写入前进程崩溃仍存在不可消除的 crash gap。恢复时缺失记录按失败关闭；不得解析 ToolResultMessage 文本补造 shell facts；
- 未能唯一 join、重复但内容冲突的 canonical observation、或 result seq 越过 dossier `throughSeq` 都视为 sidecar conflict／在该冻结点仍为 `pending`。

首期不在 sidecar 复制用户消息、assistant 消息、native raw 工具参数、工具输出、AGENTS 内容或完整卷宗。

## 13. 完整性、预算和实验指标

### 13.1 完整性接口

```ts
interface DossierCompletenessV1 {
  readonly sourceThroughSeq: number
  readonly complete: true
  readonly omissions: readonly []
}

interface DossierMetricsV1 {
  readonly dossierVersion: 1
  readonly delegationClassificationCatalogFingerprint: string
  readonly bytes: number
  readonly characters: number
  readonly estimatedTokens?: number
  readonly sections: readonly {
    readonly name: 'environment' | 'instructions' | 'interaction' | 'currentTurnTools' | 'pendingApproval'
    readonly bytes: number
    readonly characters: number
    readonly estimatedTokens?: number
  }[]
}
```

首期 ready dossier 不允许静默省略材料，因此 `complete` 只能是 `true`。一旦需要裁剪，必须先定义新版本的可见 omission／budget 语义；不得继续声称是完整 v1。

### 13.2 硬预算

完整材料仍受 Reviewer 模型 context window 的物理限制。编译器必须预留：

- Reviewer 固定 policy；
- 决策工具 schema；
- 模型输出预算；
- provider 必要 framing。

如果完整 v1 无法放入剩余窗口：

```text
DossierCompilationResult.kind = incomplete
reason = budget-overflow
```

编译器只返回 `incomplete: budget-overflow`，不得产生 packet。调用方必须失败关闭；`auto`／`auto-then-user` 的具体拒绝或人工下沉映射由 coordinator policy 规范定义，不属于本文接口。首期不得由宿主临时总结用户消息或静默截去最旧内容。

### 13.3 编译指标与下游实验联表

compiler 自身建议只记录不含完整敏感 payload 的指标：

- 各区块 bytes／characters／token estimate；
- delegation entries 按 operation／projector 的数量，以及被来源规则排除的 child report／settlement／tool-result content 数量（不记录正文）；
- 编译耗时与 budget-overflow、sidecar 缺失、关联歧义和失败关闭频率；
- dossier version、freeze seq、hash、source projection／argument semantics version 和 delegation classification catalog fingerprint。

为了验证首期材料的效率和审批倾向，下游 Reviewer／coordinator 可以按 `dossierHash` 另行联表：首次创建／cold resume、投递和模型裁决耗时，risk、userAuthorization、decision 分布，以及按工具族、standing mode、requested mode、enforcement 和同 Session 审批序号的分布。这些是本文接口的外部消费者指标，不改变 dossier compiler 的职责，也不在本规范定义 decision mapping。

完整卷宗默认不重复写入 telemetry 或 sidecar。只要冻结父 Session 与 versioned sidecar 仍存在，就能按版本重建；若任何必要 projection 从未落盘，则必须承认该历史样本不可重建。

## 14. 隐私和模型边界

高召回 v1 会把以下父会话材料发送给配置的 Reviewer 模型：

- parent system prompt 和工具 schemas；
- 完整生效项目指令；
- 全部直接用户消息；
- 既往正常 turn 的最终主 Agent 交付；
- 主 Agent 发出的精确子代理／workflow／Ralph 初始委托和后续控制请求；
- 当前 turn 的精确工具请求；
- 当前审批动作和提权理由。

因此部署者必须把 Reviewer 模型 route 视为能接触父会话敏感内容和主 Agent 委托正文的处理方。高召回实验还会发送带 `superseded` 标记的旧直接用户消息；若 DSH 产品把 surface 移除／替换承诺为内容删除而非历史修订，该行为在进入生产前必须重新评审，不能仅凭状态标签继续发送。插件不得额外读取 process environment、凭据文件、child Session 或历史工具输出正文；审计默认只保存 hash 和大小指标。

## 15. 首期不包含的能力

以下事项不属于 v1 卷宗编译：

- Guardian 自主读取文件、执行 shell、访问网络或调用其他 Agent；
- 宿主对用户消息做语义相关性筛选；
- 宿主预先判定风险、授权、必要性或最小权限；
- 当前 turn 以前的完整工具输出或完整 Agent 工作轨迹；
- child Session 遍历、child transcript／report／closing output，或基于 child 内容的 prompt-injection／证据真实性分析；
- 独立的历史人工批准区。当前 DSH `approval/decided` 不含 answerer 身份，不能把任意 `allowed-once` 默认称为人工批准；
- full／delta transport；逻辑 dossier 始终是完整快照，首期先评测 full delivery；
- Reviewer policy、风险 taxonomy、授权 assessment 和最终 decision mapping；
- 专用 Web UI 或审批期间输入框行为变更。

## 16. 测试与退出条件

实现该规范至少需要证明：

1. 相同冻结 Session + versioned sidecar + 规范配置产生字节稳定的 `dossierHash`；
2. 不同 Session 生命周期身份、request event seq 或 approval asked seq 不能交叉读取 sidecar，两类复合 key 编码无字段拼接碰撞；
3. live `ApprovalRequest.agent`、authority、Agent id 和 exact Session 任一不一致时失败关闭；
4. 同 open turn 中 ask 缺失或关联不唯一时失败关闭，匹配成功时 `throughSeq` 精确等于该 `approval/asked.seq`；
5. 父 policy `never` 只产生 DSH 原生 rejected audit，不调用 Guardian；父 `ask` 与 Reviewer child `never` 不混淆；
6. 所有直接用户消息按 seq 进入交付链，插件注入和 `subagent-report`／`subagent-settled` 不冒充直接用户；
7. “主 Agent 提议 → 用户回复继续”的指代链保持完整；
8. 只有正常 completed turn 的最终无 tool-call 文本成为主 Agent 交付；
9. aborted／blocked／error／max-tokens／interrupted／extension／当前 turn 不产生虚假交付，未知 extension reason 原样保留；
10. 当前生效 AGENTS／CLAUDE 内容来自 Session，而不是审批时磁盘重读；
11. 顶层 tool-call 从 assistant block 全量重建，尚未启动的并行 sibling 明确为 queued；
12. native `rawArguments` 逐字保留，空白、重复 key、非法 JSON 和执行参数投影不会互相冒充；
13. Code Mode 的 `tool/code-dispatch-start`／`tool/code-dispatch` 能按 subCallId 进入轨迹或第五段，并绑定其 `run_code` 父调用；
14. 当前 turn 轨迹保留全部请求和顺序，但不泄露结果正文、meta、diff 或 spill path；
15. shell 非零 exit、timeout、signal、abort、sandbox denial、sandbox unavailable、runner failure、审批未授权和 durable pending 得到不同事实状态；
16. 后台 bash 只标记 `background-launched`，不会把后来 job 终态倒填到原 callId；
17. 未组合 sandbox executor 显示为 `unconfined-composition`，不显示为 `danger-full-access`；
18. 当前待审批 action、permissions、description、justification 和 approval reason 完整且互相一致；
19. 当前待审批 request 不在历史轨迹中重复；更早 denial 只作为无 `retryOf` 声明的有序事实列出；
20. execution projection 与 immutable approval snapshot 都在 Guardian 调用前持久化；同一 callId 的连续两次 ask 产生不同 snapshot，较早环境不会被覆盖；
21. `tools/result` canonical value 只有与 durable result event join 后才写终态；缺失 event 的 observation 不阻塞 `session/flush`／dispose，并在 turn／session 生命周期终点被 quarantine；
22. `session/flush` 和 dispose 只 drain 已入队的串行写任务，模拟 write crash gap 时编译失败关闭；
23. 自定义权限投影没有稳定 `projectorId`、execution action projection／approval environment snapshot 缺失或 profile 默认值后来变化时，不会用当前值伪造历史；
24. source-backed compiler 对照 frozen facts 拒绝伪造／遗漏 historical event ref；packet codec 用项目 `canonicalJson()` + UTF-8 domain + `sha256:<lowerhex>` fixture 重算 actionHash、classification catalog fingerprint 与 dossierHash，并拒绝 packet 内 parent、callId、action、reason 或 projector 的交叉不一致；
25. budget overflow 不产生隐式裁剪、packet 或自动 allow；
26. WSL2 + workspace-write 验收通过，同时领域接口没有平台硬编码；卸载插件或删除 sidecar 后，父 DSH Session 仍可正常恢复；
27. stock `subagent`／`subagent_fork`／`send_message`／`interrupt_agent` 以及显式启用的 workflow／Ralph projector 生成稳定有序的 delegation ledger；
28. classification catalog 与 enabled tool instances 闭集相等；历史 request header／execution classification 与当前 immutable catalog 一致，任一中途工具增删、schema／projector 漂移均失败关闭；renamed／provider-bound 工具只按 exact descriptor 投影，不按名称正则猜测；
29. delegation entry 保留 native raw arguments／Code Mode normalized arguments 和最小 outcome，不另造可能漂移的 prompt／message 摘要；
30. 当前 turn 的 expected delegation set 与 ledger entries 按 request ref 严格双射，missing／extra／duplicate 或第三、四段任一 canonical 字段漂移都被 packet parser 拒绝；
31. `subagent-report`／`subagent-settled`、foreground child result、workflow aggregate output 和 `job_output` 正文在 fact-source projection 边界变成 typed exclusion record，source snapshot 与 packet 都不保留正文；
32. schema-validated canonical result 在 durable result join 时只产生已声明的 content-free receipt 并写入 execution record；`required-on-completed` 缺失／wrong-kind、冷恢复重解析 rendered text、receipt／ownership 冲突均失败关闭，interrupt acceptance 不冒充目标存在或 stop status；
33. nested descendants 不递归读取，`descendantsGrantAuthority` 始终为 `false`，任何 child 输出都不能扩大用户授权；
34. 主 Agent 在收到 child 输出后自己产生的 assistant 文本、follow-up 和工具动作仍按主体轨迹进入卷宗；
35. live requester 只要带 `parentSessionId`，或 `max(headerDelegationDepth, runtimeSubagentDepth) > 0`，即使 policy 为 `ask` 也返回 `unsupported-delegated-requester`；
36. 所有结构整数、event seq、delegation order 和对象 exact keys 经对抗测试；负数、unsafe integer、重复／乱序 seq、unknown key 和 raw JSON duplicate key 都不能解析；
37. source projection policy／argument semantics version 或 catalog fingerprint 不一致时失败关闭，历史 snapshot 不用新解析器静默重解释；
38. source-kind fixture 精确覆盖 `subagent-report/relay`、`subagent-settled/notice` 和 child-side `coordinator/relay`；top-level workflow 元事件可校验，Code Mode workflow 与 Ralph 不伪造不存在的 per-child ledger；
39. packet-only parser 只能返回 `internal-consistency-only`，伪造 hash 自洽的 historical entry 不能获得 module-private source-verified brand；只有携带 frozen facts 的 compiler 能验证 source completeness。

## 17. 后续待评测问题

首期真实样本和指标形成后，再讨论：

- 是否需要把完整 parent system prompt 改成结构化环境白名单；
- 是否需要把全部工具 schemas 缩减为可用工具目录 + 当前工具 schema；
- 用户—主 Agent 交付链与委托包络是否需要确定性预算；
- 当前 turn 是否足以解释审批，还是要增加前一 turn 的工具状态；
- 是否需要单独记录可验证来源的人工批准历史；
- 持久 Reviewer 的后续请求采用 full、delta 还是定期 full；
- sidecar 的 fork 继承、Session 删除回收和导出策略；
- 是否需要 jobId-keyed 生命周期 sidecar，把后台启动与后续终态显式关联；
- 是否需要把 child output provenance 作为独立风险信号；若需要，必须升级 dossier 版本，不能静默改变 `childOutputPolicy: exclude-direct-origin-v1`；
- 是否有任何场景值得增加目的受限的只读调查能力。

以上变化必须以新版本或明确兼容规则进入规范，不能在 v1 编译器中静默改变材料语义。
