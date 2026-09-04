# Pending 审批跨进程 cold-resume 验收用例规格

目标:验证 DSH 0.1.2-alpha.5 下,审批请求在 `approval/asked` 已持久化、answerer 尚未裁决时进程崩溃(SIGKILL),重启后:
1. session 可加载,repair 机制闭合孤儿 turn(合成 interrupted tool-result);
2. 孤儿 `approval/asked` 留在日志中且不触发 invariant 失败;
3. 副作用从未发生;
4. 同一 session 可 resume 并继续新 turn;
5. approve-for-me 插件重新武装(registerMachinePolicy 在位),且不会为孤儿请求补发任何 `approval/decided`。

## 已核实的 alpha.5 事实(设计依据)

- `ApprovalService.request()`(packages/interaction/user-approval/src/index.ts):先 `session.append('approval/asked', {id, toolName, callId?, reason?})`,再 `await decide()` 调 answerer。answerer 被调用时 asked 事件已提交。answerer 看不到 requestId,但可在 answerer 回调内读 `session.snapshotEvents()` 取最后一条 `approval/asked`。
- session repair(packages/core/session/src/repair.ts):reload 时对崩溃遗留的 open turn 追加合成关闭事件;pending tool call 补一条 isError 的 tool-result,文本以 "The tool call was interrupted" 开头;崩溃前事件完整保留。
- approval invariant(packages/interaction/user-approval/src/invariant.ts):日志末尾遗留未决 pending 不算失败;`approval/decided` 无匹配 asked 会失败。
- 恢复 API:`ctx.agents.resume({ resumeSessionId, agentOptions })`(packages/core/agent/src/index.ts, ResumeAgentOptions)。

## 隔离要求(硬约束)

- 全程使用 `mkdtempSync('/tmp/dsh-approve-pending-')` 下的一次性 DSH_HOME、CLI prefix、shim;绝不触碰 `~/.dsh`、当前运行中的 dsh 实例、宿主 checkout。
- CLI 从 npm 安装 `@deepseek-ai/dsh@0.1.2-alpha.5` 到一次性 prefix(复用 profile-artifact-smoke.mjs 的 installTargetCli 模式)。
- 不启动 web server、不占端口;两轮都是 CLI headless boot。

## 交付物

1. `scripts/profile-pending-resume-smoke.mjs`(新建):编排两阶段。
   - 校验 `.build/demo-kit/demo-kit.json` 与 `deployment-artifacts.lock.json` 一致、三 artifact sha256 匹配(复用 profile-artifact-smoke.mjs 的校验块)。
   - 安装 profile `approve-for-me-pending-smoke`(fork + managed-agent + probe + approve-for-me 四个 tarball,顺序同 artifact smoke)。
   - cordis.patch.yml 插件配置:mode `auto-then-user`、timeoutMs 5000、trustEnvelope disabled、reviewer: generation `pending-smoke-v1`、provider `profile-smoke-provider`、model `profile-smoke-model`、policyVersion `policy-v2`、toolsetVersion 1。**有意保留 policy-v2**(2026-09-04):本冒烟与 artifact smoke 一起充当旧政策的装载/行为回归,policy-v3 的验收由 quality smoke 承担。
   - Phase A(arm):env `DSH_APPROVE_FOR_ME_PROFILE_PROBE=<output>/probe-arm.json`、`DSH_APPROVE_FOR_ME_PROFILE_PROBE_PHASE=arm`、`DSH_APPROVE_FOR_ME_PROFILE_PROBE_SESSION=<固定 uuid>`。预期进程被 SIGKILL 杀死(execFileSync 抛错,signal SIGKILL — 这是成功路径,不是失败)。之后断言 probe-arm.json 含 `{phase:'armed', sessionId, requestId, callId}`。
   - Phase B(verify):同一 DSH_HOME,env PHASE=verify、同一 session id、marker `<output>/probe-verify.json`。预期进程正常退出(SIGTERM 自退,同现有 probe)。断言 probe-verify.json 各断言字段全为真(见下)。
   - 全部通过打印 `PASS pending approval cross-process cold-resume smoke`。
2. `tests/fixtures/profile-probe/index.mjs`(扩展,env 门控;`DSH_APPROVE_FOR_ME_PROFILE_PROBE_PHASE` 未设置时行为必须与现状逐字节等价,现有 profile:artifact-smoke 不得受影响):
   - PHASE=arm:
     - 场景:bash `{command: "printf 'pending\\n' > pending-side-effect.txt", description: 'Run pending resume smoke command', workdir: workspace}`;workspace = marker 所在目录。
     - adapter:Guardian review packet → `submit_approval_decision` decision=`human_review`(其余字段照抄现有 review 分支的构造);root agent 第 1 次调用 → bash 工具调用,后续 → 文本。
     - `tools/pre-execute` hook:description 含 `pending resume smoke command` → `{kind:'ask', reason:'Exercise pending approval cold-resume.'}`。
     - `approval/request` answerer(仅本 agent):从 `request.agent.session.snapshotEvents()` 取最后一条 `approval/asked`,断言其存在;写 `<marker>`(即 probe-arm.json)`{phase:'armed', sessionId, requestId: asked.data.id, callId: asked.data.callId ?? null}`;随后 `process.kill(process.pid, 'SIGKILL')`;永不 resolve(返回 pending promise)。
     - 创建 agent 用 `ctx.agents.create({ sessionId: <env 固定 uuid>, meta:{cwd: workspace}, agentOptions:{provider, model} })`;先发 `/approve-for-me` directive(格式照现有 runScenario,allow bash + 精确 arguments),驱动到 answerer 为止。
   - PHASE=verify:
     - 注册同一 adapter(provider/model 相同)。
     - `ctx.agents.resume({ resumeSessionId: <env session id>, agentOptions:{provider, model} })`。
     - 从 `agent.session.snapshotEvents()` 计算断言:
       - `orphanAsked`:存在恰好一条 `approval/asked` 无匹配 `approval/decided`,且其 id === probe-arm.json 的 requestId;
       - `repaired`:存在一条 `tool/result`(isError true)其文本含 `interrupted`,且 turn/start 数 === turn/end 数(turn 平衡);
       - `noLateDecision`:arm 阶段 requestId 在 verify 全程没有任何新 `approval/decided`(包括 resume 后插件重武装过程);
       - `rearmed`:`typeof ctx.approval?.registerMachinePolicy === 'function'`。
     - 副作用检查:workspace 下 `pending-side-effect.txt` 不存在 → `sideEffect: false`。
     - 继续性:向 resumed agent 发一条普通文本消息(照现有 send/waitForIdle),等待 idle → `continued: true`。
     - 写 probe-verify.json(全字段),`setTimeout(() => process.kill(process.pid, 'SIGTERM'), 25)`。
3. `package.json`:新增 script `"profile:pending-smoke": "node scripts/profile-pending-resume-smoke.mjs"`。

## 自检要求

- 运行 `npm run profile:pending-smoke` 必须 PASS;
- 运行 `npm run profile:artifact-smoke` 确认无回归;
- `npm run check` 全绿。
