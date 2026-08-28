# approval-gate（裁决执行器 v2）

本体插件在 patched `dsh-user-approval` 提供的机器决策槽内运行的裁决执行器。这里只放纯领域端口；DSH 适配和 Guardian 编排继续放在 `src/dsh/`、`src/application/`、`src/reviewer/`。

计划模块：

| 文件 | 职责 |
|---|---|
| `catalog.ts` | 工具审批行为闭集分类：`ordinary` / `gate-ask` / `body-escalation`，未知失败关闭 |
| `trust-envelope.ts` | 确定性信任包络：工具族、请求模式、workspace 边界、justification 要求 |
| `breaker.ts` | 精确 `actionHash` 拒绝熔断（同 lifecycle/turn/user frontier） |
| `sealed-decision.ts` | pre-review 密封裁决：绑定 requestId/callId/actionHash/generation/deadline，answerer 只重放 |
| `machine-policy.ts` | `MachineApprovalPolicy` 适配器：校验 → 快路径 → breaker → Guardian → 模式映射 |

当前阶段先落类型与端口，实现在 patch 包与依赖插件接入后逐步填充。
