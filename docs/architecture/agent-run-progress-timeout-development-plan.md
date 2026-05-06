# AgentRun 进度轮询与超时治理开发计划

## 1. 背景

当前 `generate_outline_preview` 在 60 章细纲场景中出现过两类问题：

1. 旧的 120s 外层 Tool 超时会先于内部 LLM 调用结束触发，导致错误被统一包装为“工具执行超时”，日志中 `model/tokenUsage/llmCallCount` 不可诊断。
2. 将外层超时提升到 500s 后，慢 LLM 请求仍可能拖住整个同步 `/api/agent-runs/plan` HTTP 请求，最终在 500s 外层超时处失败，用户只能看到长时间等待和 500。

这说明问题不只是“超时时间不够”，而是执行模型需要从“同步请求 + Executor 外层统一超时”升级为“异步 AgentRun + Step/Phase 进度轮询 + 内层能力超时 + 系统 watchdog 兜底”。

## 2. 目标

- 用户能看到具体执行到哪一步、哪一个阶段，而不是只看到 `running`。
- Tool 内部 LLM 调用由 Tool 自己的 `timeoutMs` 控制，超时时返回明确的 `LLM_TIMEOUT` 或业务 fallback。
- Executor 不再用统一 500s `Promise.race` 作为常规业务超时来源。
- AgentRun/AgentStep 支持轮询查看进度、阶段、耗时、deadline、最近 heartbeat 和错误码。
- 外层兜底只处理真正挂死：Promise 不返回、进程异常、DB 等待无响应、代码 bug 等。
- Plan/Act 长任务不阻塞 HTTP 请求；接口快速返回 `agentRunId`，前端轮询状态。

## 3. 非目标

- 不在本阶段重做所有 Tool 的业务逻辑。
- 不引入分布式任务队列作为首要依赖；先在 API 内实现可观测的异步执行与 watchdog。
- 不把所有长任务都改为流式输出；轮询先满足进度可见和超时判定。
- 不让前端单独决定失败状态；前端负责观察，最终状态变更仍由后端写入。

## 4. 核心决策

### 4.1 去除 Executor 统一业务超时

当前不理想模式：

```ts
await Promise.race([
  tool.run(args, context),
  timeout(500_000, '工具执行超时'),
]);
```

问题：

- Executor 不知道 Tool 内部卡在 LLM、DB、JSON 解析、fallback 还是其他阶段。
- 外层错误会掩盖内部 LLM 错误，导致观测成本高。
- 当内部 LLM 有 retry 时，外层可能在第二轮请求中间截断，形成“不知道模型是否调用过”的日志。

目标模式：

```ts
await trace.updateStepPhase(runId, stepNo, {
  phase: 'calling_llm',
  timeoutAt: now + llmTimeoutMs,
});

await llm.chatJson(messages, {
  timeoutMs: llmTimeoutMs,
  retries: 0,
});
```

Tool 的阶段和内部 timeout 决定业务错误；Executor 只负责步骤编排、Policy、Schema、Trace 和取消检查。

### 4.2 外层 watchdog 保留为系统级兜底

外层兜底不再是每个 Tool 的常规 `500s` 业务超时，而是后台 watchdog：

```text
如果 step.status = running
并且 now > step.deadlineAt
并且 heartbeatAt 长时间未更新
=> 标记 step failed
=> errorCode = TOOL_STUCK_TIMEOUT 或 TOOL_PHASE_TIMEOUT
=> 释放 run lease
=> Run 进入 failed / waiting_review / retryable failed
```

这类错误表示系统执行卡死，而不是正常 LLM 超时。

### 4.3 轮询是观察层，deadline 是判定层

前端或 Agent 轮询应该看到：

```text
AgentRun planning
  step 1 inspect_project_context succeeded
  step 2 generate_outline_preview running
    phase calling_llm
    elapsed 63s / timeout 90s
```

如果超过 deadline：

```text
step 2 failed
errorCode LLM_TIMEOUT
message generate_outline_preview 内部 LLM 调用超时
```

轮询负责展示“卡在哪一步”，后端根据 `timeoutAt/deadlineAt/heartbeatAt` 负责判死、清理状态和允许重试。

## 5. 数据模型改造

### 5.1 AgentStep 增强字段

建议在 `AgentStep` 增加以下字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `phase` | `String?` | 当前阶段，如 `preparing_context/calling_llm/parsing_json/fallback_generating/validating/persisting`。 |
| `phaseMessage` | `String?` | 用户可读阶段说明。 |
| `progressCurrent` | `Int?` | 当前进度值，可选。 |
| `progressTotal` | `Int?` | 总进度值，可选。 |
| `startedAt` | `DateTime?` | 步骤实际开始时间。 |
| `heartbeatAt` | `DateTime?` | 最近进度/心跳更新时间。 |
| `timeoutAt` | `DateTime?` | 当前阶段的业务超时点。 |
| `deadlineAt` | `DateTime?` | 整个步骤的系统兜底 deadline。 |
| `errorCode` | `String?` | 结构化错误码。 |
| `errorDetail` | `Json?` | 结构化错误详情。 |

现有 `input/output/metadata/status` 保留；`executionCost` 继续放 metadata，或者后续单独抽字段。

### 5.2 AgentRun 增强字段

建议在 `AgentRun` 增加或派生以下字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `currentStepNo` | `Int?` | 当前步骤号。 |
| `currentTool` | `String?` | 当前工具名。 |
| `currentPhase` | `String?` | 当前阶段。 |
| `heartbeatAt` | `DateTime?` | 最近执行心跳。 |
| `leaseExpiresAt` | `DateTime?` | 执行租约过期时间。 |
| `deadlineAt` | `DateTime?` | 整个 Run 的系统级 deadline。 |

如果不想扩表过多，`current*` 可从最新 running step 派生；P0 至少落地 Step 级字段。

## 6. 后端执行模型

### 6.1 `/plan` 异步化

当前模式：

```text
POST /api/agent-runs/plan
  -> 创建 Run
  -> 同步 Planner
  -> 同步执行 Plan 阶段预览 Tool
  -> 返回完整结果
```

目标模式：

```text
POST /api/agent-runs/plan
  -> 创建 Run(status=planning)
  -> 启动后台执行
  -> 立即返回 { agentRunId, status }

GET /api/agent-runs/:id
  -> 返回 Run + Plan + Steps + Artifacts
```

P0 可先保留兼容响应字段，但接口不再等待长预览 Tool 完成。

### 6.2 TraceService 增强

新增方法：

```ts
startStep(agentRunId, stepNo, data)
updateStepPhase(agentRunId, stepNo, phasePatch)
heartbeatStep(agentRunId, stepNo, patch?)
finishStep(agentRunId, stepNo, output, metadata)
failStep(agentRunId, stepNo, observation, metadata)
```

`updateStepPhase()` 需要同时更新：

- `AgentStep.phase`
- `AgentStep.phaseMessage`
- `AgentStep.timeoutAt`
- `AgentStep.heartbeatAt`
- `AgentRun.currentStepNo/currentTool/currentPhase/heartbeatAt`

### 6.3 ToolContext 增强

在 `ToolContext` 中注入进度能力：

```ts
interface ToolContext {
  ...
  updateProgress?: (patch: ToolProgressPatch) => Promise<void>;
  heartbeat?: (patch?: ToolProgressPatch) => Promise<void>;
  signal?: AbortSignal;
}
```

`ToolProgressPatch`：

```ts
interface ToolProgressPatch {
  phase?: string;
  phaseMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}
```

### 6.4 LLM Gateway 错误语义

`LlmGatewayService` 应将 `AbortSignal.timeout()` 或 provider timeout 转为明确错误：

```ts
class LlmTimeoutError extends Error {
  code = 'LLM_TIMEOUT';
  appStep?: string;
  timeoutMs: number;
}
```

Executor Observation 分类新增：

```text
LLM_TIMEOUT
LLM_PROVIDER_ERROR
LLM_JSON_INVALID
TOOL_PHASE_TIMEOUT
TOOL_STUCK_TIMEOUT
RUN_DEADLINE_EXCEEDED
```

## 7. Watchdog 设计

### 7.1 P0：进程内 watchdog

先在 API 内实现定时扫描，避免引入新服务：

```text
每 10s 扫描：
  AgentStep where status=running and timeoutAt < now
  AgentRun where status in planning/acting and deadlineAt < now
```

处理策略：

- 如果 step.phase 是 `calling_llm` 且 timeoutAt 到期，标记 `LLM_TIMEOUT`。
- 如果 step heartbeat 长时间未更新，标记 `TOOL_STUCK_TIMEOUT`。
- 如果 Run deadline 到期，标记 `RUN_DEADLINE_EXCEEDED`。
- 释放 `leaseExpiresAt` 或将 Run 状态置为 `failed`。

注意：如果同一进程内 Promise 后续又返回，`finishStep` 必须做状态条件更新，避免把 failed 覆盖为 succeeded。

### 7.2 P1：可恢复执行租约

当前已有 Act lease 思路，可扩展到 Plan 预览执行：

```text
planning/acting run 获取 lease
后台执行定期续租
watchdog 只处理 lease 过期且 heartbeat 停滞的 run
```

### 7.3 P2：独立 worker/queue

如果 API 进程内后台任务不够稳定，再迁移到队列：

- BullMQ / Redis job
- DB-backed job runner
- 独立 Agent executor process

本阶段先不强依赖。

## 8. 前端轮询体验

### 8.1 useAgentRun 轮询

前端创建计划后：

```text
createPlan()
  -> 返回 agentRunId
  -> startPolling(agentRunId)
  -> 每 1-2s 拉取 Run
  -> 终态停止轮询
```

终态：

```text
succeeded
failed
cancelled
waiting_approval
waiting_review
```

### 8.2 时间线展示

Timeline 不只展示 Step 状态，还展示当前 phase：

```text
2. 生成卷 1 细纲
   running · calling_llm · 63s / 90s
   正在请求模型生成章节预览
```

失败时：

```text
failed · LLM_TIMEOUT
模型在 90s 内未返回，已生成确定性骨架 / 或建议重试
```

### 8.3 Artifact 增量展示

如果 Tool 支持 fallback 或阶段性输出：

- `outline_preview` 可在 fallback 后立即出现。
- `outline_validation_report` 后续成功后追加。
- 长任务期间先展示“已完成上下文巡检，正在生成预览”。

## 9. Tool 改造规范

### 9.1 LLM Tool

每个 LLM Tool 必须声明：

```ts
llmTimeoutMs
llmRetries
fallbackPolicy
phaseName
```

示例：

```ts
await context.updateProgress?.({
  phase: 'calling_llm',
  phaseMessage: '正在生成卷章节预览',
  timeoutMs: 90_000,
});

try {
  const response = await llm.chatJson(..., { timeoutMs: 90_000, retries: 0 });
} catch (error) {
  if (isLlmTimeout(error)) return fallbackPreview(...);
  throw error;
}
```

### 9.2 DB Tool

DB Tool 应在关键查询前后打 heartbeat：

```text
preparing_query
reading_existing_assets
building_write_preview
```

DB 等待不应由 LLM timeout 处理，应由 phase timeout 或 stuck watchdog 处理。

### 9.3 写入 Tool

写入 Tool 保持审批边界：

- 进入 `persisting` phase 前检查 `approved=true`。
- 写入事务内尽量短。
- 写入成功后再更新 progress。
- 如果 watchdog 已将 Step 标记 failed，后续事务提交前必须检测 Run/Step 是否仍可写。

## 10. 分阶段实施计划

### P0：观测字段与内层 LLM 超时语义（已完成）

后端：

- Prisma 增加 `AgentStep.phase/phaseMessage/heartbeatAt/timeoutAt/deadlineAt/errorCode/errorDetail`。
- `AgentTraceService` 增加 `updateStepPhase/heartbeatStep`。
- `ToolContext` 注入 `updateProgress/heartbeat`。
- `LlmGatewayService` 输出 `LlmTimeoutError`。
- `generate_outline_preview` 使用 `calling_llm` phase 和 `90s` 内层 timeout；保留确定性 fallback。

前端：

- Timeline 展示 `phase/phaseMessage/elapsed/timeoutAt`。
- 轮询时展示当前 step phase。

测试：

- LLM timeout 被分类为 `LLM_TIMEOUT`。
- `generate_outline_preview` 超时不会产生外层 `工具执行超时`。
- running step 能返回 phase 和 timeoutAt。

完成记录（2026-05-06）：

- 已在 Prisma `AgentStep` 增加 `phase/phaseMessage/progressCurrent/progressTotal/heartbeatAt/timeoutAt/deadlineAt/errorCode/errorDetail`，在 `AgentRun` 增加 `currentStepNo/currentTool/currentPhase/heartbeatAt/leaseExpiresAt/deadlineAt`。
- `AgentTraceService` 已支持 `updateStepPhase()`、`heartbeatStep()`，`startStep()` 写入 `startedAt/heartbeatAt/deadlineAt`，`finishStep/failStep/reviewStep` 使用 running 条件更新并写入错误码。
- `ToolContext` 已注入 `updateProgress/heartbeat/signal` 预留字段，Executor 不再用 Tool 级 `Promise.race` 作为常规业务超时。
- `LlmGatewayService` 已输出 `LlmTimeoutError(code=LLM_TIMEOUT, appStep, timeoutMs)`，并补充 `LLM_PROVIDER_ERROR/LLM_JSON_INVALID` 结构化错误。
- `generate_outline_preview` 已在 `calling_llm` 前写 phase，LLM 调用使用 `timeoutMs=90_000/retries=0`，超时后生成确定性 fallback，并补齐目标章节数。

### P1：Plan/Act 异步化与轮询闭环（已完成 Plan 主链路）

后端：

- `/agent-runs/plan` 创建 Run 后立即返回。
- 后台执行 Planner 和 Plan 阶段只读预览。
- `/agent-runs/:id` 返回最新 step phase 和 artifacts。
- `finishStep/failStep` 使用条件更新，避免终态被后台迟到结果覆盖。

前端：

- `createPlan()` 返回后自动轮询。
- 创建计划按钮显示“已开始规划”，不阻塞等待所有预览。
- 终态或等待审批时停止轮询。

测试：

- `/plan` 在长 Tool 未完成时快速返回。
- 轮询最终看到 `waiting_approval` 和预览 Artifact。
- 取消 Run 后后台迟到结果不能覆盖 `cancelled`。

完成记录（2026-05-06）：

- `/agent-runs/plan` 已改为创建 `AgentRun(status=planning)` 后快速返回 `{ agentRunId, id, status }`，后台继续执行 Planner 和 Plan 预览 Tool。
- `GET /agent-runs/:id` 继续返回 Run + 最新 Plan + Steps + Artifacts；新 phase、heartbeat、timeout/deadline 字段随 Prisma 聚合响应返回。
- Runtime 的 Plan/Act 完成、失败、waiting_review 和 observation/replan 写入已使用状态条件更新，避免 cancelled/failed/succeeded 被迟到结果覆盖。
- 前端 `useAgentRun` 已在 createPlan/refresh/act/retry/replan/clarification 后自动轮询活跃 Run，每 1.5s 拉取，终态或 waiting 状态停止。
- Agent 任务窗口和 Timeline 已展示 step phase、phaseMessage、elapsed、timeoutAt、errorCode，并对 watchdog stuck 错误显示“系统检测到步骤卡住”。

备注：本轮重点完成 `/plan` 长任务异步化；`act/retry/replan` 已接入轮询与防迟到覆盖，但 HTTP 快速返回可继续作为后续薄切片强化。

### P2：Watchdog 与 stuck step 处理（已完成）

后端：

- 新增 `AgentRunWatchdogService`。
- 定时扫描超时 phase、stuck heartbeat、过期 lease。
- 标记 `TOOL_PHASE_TIMEOUT/TOOL_STUCK_TIMEOUT/RUN_DEADLINE_EXCEEDED`。
- 释放 Run lease 并允许 retry/replan。

前端：

- 对 watchdog 错误展示“系统检测到步骤卡住”。
- 提供重试/重新规划入口。

测试：

- heartbeat 停滞后 watchdog 标记 failed。
- phase timeout 后错误码正确。
- 后台 Promise 迟到不能改回 succeeded。

完成记录（2026-05-06）：

- 新增 `AgentRunWatchdogService`，API 进程内每 10s 扫描 running Step 和 active Run。
- `timeoutAt < now` 的 running Step 标记为 `TOOL_PHASE_TIMEOUT`；heartbeat 停滞标记为 `TOOL_STUCK_TIMEOUT`；Run `deadlineAt < now` 标记为 `RUN_DEADLINE_EXCEEDED`。
- Watchdog 标记失败时写入 `AgentStep.errorCode/errorDetail/output`，同步将 Run 置为 `failed`、释放 `leaseExpiresAt` 并写入 `output.latestObservation`。
- `finishStep/finishRun` 路径已用条件更新和终态检查防止后台 Promise 迟到覆盖。

### P3：Tool 全量进度标准化（主链路已完成）

覆盖工具：

- `generate_import_*_preview`
- `build_import_preview`
- `write_chapter`
- `polish_chapter`
- `ai_quality_review`
- `generate_worldbuilding_preview`
- `generate_story_bible_preview`
- `scene_card` 相关预览工具

验收：

- 所有 LLM Tool 都有 `calling_llm` phase、内部 timeout 和明确错误码。
- 所有长 DB/写入 Tool 都有至少一个 heartbeat。
- Agent Timeline 不再出现无阶段的长时间 `running`。

完成记录（2026-05-06）：

- `generate_import_*_preview`、`build_import_preview`、`generate_worldbuilding_preview`、`generate_story_bible_preview`、`generate_scene_cards_preview` 已在进入 LLM 前写入 `calling_llm` phase，并使用各自 Tool 内部 `timeoutMs/retries`。带 retry 的 Tool 会把 Step phase timeout 设置为 retry-aware 总预算，避免 watchdog 在合法第二次尝试期间误判 stuck。
- `write_chapter` 已把进度回调传入 `GenerateChapterService`，Timeline 可看到 `preparing_context`、`preflight`、`retrieving_context`、`calling_llm`、`validating`、`persisting`。
- `polish_chapter` 已把进度回调传入 `PolishChapterService`，Timeline 可看到读取草稿、`calling_llm`、`persisting`。
- `ai_quality_review` 已把进度回调传入 `AiQualityReviewService`，Timeline 可看到读取草稿/上下文、`calling_llm`、`validating`、`persisting`；复用已有报告时会写入可见 heartbeat。
- `AgentTraceService.updateStepPhase()` 在进入无 `timeoutMs` 的新 phase 时会清理上一阶段 `timeoutAt`，避免旧 LLM timeout 掩盖后续校验/写入阶段的 stuck 检测。
- `AgentRunWatchdogService` 的 heartbeat-stale 扫描已排除仍处于未到期 `timeoutAt` 的阶段，避免长 LLM 请求在自己的 phase timeout 内被误判为 `TOOL_STUCK_TIMEOUT`。
- 新增测试覆盖 P3 导入大纲预览 `calling_llm` 进度、章节写作/润色进度回调传递、watchdog 不误杀未到期长 LLM phase。

补充覆盖（2026-05-06）：

- `generate_guided_step_preview` 已写入 `preparing_context -> calling_llm -> validating`，内部 LLM 仍使用 `timeoutMs=120_000/retries=1`，Step phase timeout 使用 retry-aware 总预算。
- `generate_continuity_preview` 已写入 `calling_llm -> validating`，内部 LLM 使用 `timeoutMs=120_000/retries=1`；`persist_continuity_changes` 已写入 `validating/persisting`，并在写入或 dry-run 完成后 heartbeat。
- `auto_repair_chapter` 已把进度回调传入 `ChapterAutoRepairService`，Timeline 可看到 `preparing_context`、`calling_llm`、`validating`、`persisting`；内部 LLM 使用 `timeoutMs=180_000/retries=1`。
- `write_chapter_series` 已按章节写入批量进度 heartbeat，并把 `ToolContext` 进度回调传入每章 `GenerateChapterService`，因此批量写作可继续显示单章生成的 `calling_llm/persisting` 细节。

## 11. 验收用例

| 用例 | 期望 |
|---|---|
| 用户请求“卷 1 细纲，目标 60 章节” | `/plan` 快速返回 Run；轮询看到 `inspect_project_context -> generate_outline_preview/calling_llm`；90s 内 LLM 成功或 fallback；不出现外层 500s 超时。 |
| LLM provider 不返回 | Step 失败或 fallback，错误为 `LLM_TIMEOUT`，Run 不挂死。 |
| Tool Promise 永不返回 | watchdog 根据 heartbeat/deadline 标记 `TOOL_STUCK_TIMEOUT`。 |
| 用户中途取消 | Run 进入 `cancelled`；后台迟到结果不能覆盖终态。 |
| 真实写入 Tool 长事务 | Timeline 显示 `persisting`；如果事务失败，错误来源为写入阶段，不是 LLM timeout。 |
| 前端刷新页面 | 可通过 Run history 恢复当前 Run 和具体 phase。 |

## 12. 风险与应对

| 风险 | 应对 |
|---|---|
| API 内后台任务在进程重启时丢失 | P0/P1 先解决可观测与轮询；P2 用 watchdog 将过期 running Run 标记为可重试；P3 再评估队列化。 |
| 后台 Promise 迟到覆盖 failed/cancelled | 所有 `finishStep/finishRun` 使用条件更新，只允许从 running/planning/acting 进入成功态。 |
| 前端误判超时 | 前端只展示，不直接写失败；判定由后端 deadline/watchdog 完成。 |
| phase 字段过多变混乱 | 建立固定枚举建议，Tool 可扩展但前端只识别常用 phase，其余展示原文。 |
| Tool 内部忘记 heartbeat | P3 建立 LLM Tool/DB Tool 改造清单，并在测试中覆盖长任务 phase。 |
| 异步 `/plan` 改动影响现有调用方 | P1 提供兼容字段，前端优先按 `agentRunId` 轮询；必要时短期保留同步模式开关。 |

## 13. 完成定义

本专项完成时应满足：

1. `/api/agent-runs/plan` 不再因为长预览 Tool 阻塞数百秒。
2. 用户能看到当前执行步骤、phase、耗时和 deadline。
3. LLM 超时显示为 `LLM_TIMEOUT`，不会被 Executor 外层 `工具执行超时` 掩盖。
4. 外层兜底由 watchdog 处理真正 stuck 的 Step/Run。
5. 取消、失败、重试和重新规划不会被后台迟到结果覆盖。
6. 至少 `generate_outline_preview`、导入预览、章节生成三类长 LLM Tool 完成 phase/timeout 标准化。

## 14. 当前验证记录

2026-05-06 已完成并验证：

- `pnpm exec prisma generate --schema apps/api/prisma/schema.prisma`：通过。
- `pnpm --dir apps/api test:agent`：通过，203 项。
- `pnpm --dir apps/api build`：通过。
- `pnpm --dir apps/web build`：通过。
- `docker compose down && docker compose up -d --build`：通过；启动日志确认迁移 `202605060002_agent_run_progress_timeout` 已应用，API/Web 容器正常运行。
- Browser Use 打开 `http://localhost:3002`：通过；工作台、历史 Run、Agent Timeline 区域可见，浏览器 error console 为 0。

数据库迁移方式：

- 新增迁移目录：`apps/api/prisma/migrations/202605060002_agent_run_progress_timeout/`。
- 部署或本地升级时执行根目录 `pnpm db:migrate`，或等价的 `pnpm exec prisma migrate deploy --schema apps/api/prisma/schema.prisma`。

P3 后续建议：

- 继续把同一进度规范扩展到更低频的长任务，例如更多纯 DB 持久化 Tool、事实抽取、记忆重建、AI 记忆复核和导入后批量清理链路。
- 若 API 进程内后台任务在生产上仍有可恢复性压力，再评估 DB-backed job runner 或 BullMQ/Redis worker；当前专项仍保持不引入队列技术栈。
