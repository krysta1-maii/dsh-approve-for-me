# 实现状态与后续接入

## 当前里程碑

仓库已经具备独立可构建、可测试的审批协议核心，不依赖尚未实现的 `managed` subagent API。

### 模块

| 文件 | 职责 |
|---|---|
| `src/json.ts` | lossless JSON snapshot、递归冻结、canonical JSON |
| `src/protocol.ts` | providerData、ActionSnapshot、Request／Decision、hash 和结果映射 |
| `src/broker.ts` | 一次性 pending result、身份校验、timeout／abort 和 tombstone |
| `src/capture.ts` | exact Agent + call id 的工具动作捕获关联 |
| `src/manager.ts` | Reviewer singleton、per-parent 串行和 Managed Controller 窄端口 |
| `src/answerer.ts` | DSH approval waterfall 的纯 fail-closed answerer 逻辑 |
| `src/index.ts` | 公共导出 |

### 验证

```bash
npm run typecheck
npm test
npm run build
```

当前测试覆盖 5 个测试文件、37 个用例。

## 为什么还没有真实插件入口

DSH `0.1.1-rc.2` 当前没有以下 API：

- `mode: 'managed'`；
- `ctx.subagents.registerManagedProvider()`；
- provider Controller 的 `create/list/deliver/interrupt`。

因此仓库只定义结构对齐的 `ManagedReviewerController` port，不声明合并、不伪造包导出，也不使用 continuable subagent 兼容实现。

## 基础插件可用后的接入顺序

1. **Managed adapter**
   - 注册 `dsh-approve-for-me/reviewer`；
   - 用 Cordis effect 持有 registration disposer；
   - 将真实 Controller 包装成 `ManagedReviewerController<Agent>`。

2. **Reviewer materializer**
   - runtime parse providerData；
   - 安装明确模型和 `installModelSelection`；
   - complete prompt + runtime-context suppression；
   - inherited tools restriction；
   - 注册 scoped decision tool；
   - 设置 approval `never` 和 sandbox `read-only`。

3. **动作捕获**
   - 在 `tools/pre-execute` 保存 exact Agent、call id、工具名和 frozen arguments；
   - 从参数和执行环境提取 requested permissions；
   - 在 `tools/result`、abort 和 scope teardown 后清理。

4. **Approval answerer**
   - 监听 `approval/request` waterfall；
   - 原样使用 `req.agent`；
   - 调用当前 `createApprovalAnswerer()`；
   - `human_review` 通过 `next()` 转人工。

5. **结果工具**
   - 将 raw payload 和实际 child Session id 交给 `submitDecision()`；
   - 只返回 acknowledgement；
   - 不在工具内执行审批副作用。

6. **集成测试**
   - create → deliver → tool result；
   - 同 Session cold-resume；
   - parent／provider teardown；
   - HMR re-register；
   - provider unavailable；
   - Web read-only 节点。

## 当前未执行的操作

本项目尚未安装或挂载到任何 DSH profile，也未修改当前运行中的 Web GUI。只有在用户后续明确要求后才进行安装、挂载和 GUI 验证。
