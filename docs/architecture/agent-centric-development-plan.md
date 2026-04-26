# Agent-Centric 同步后端开发计划

## 1. 目标

> 开发进度同步（2026-04-26）：已完成 Agent-Centric MVP 后端基建第一批落地，包含 Agent 数据模型、AgentRun 基础 API、LLM Gateway、ToolRegistry、SkillRegistry、RuleEngine、Runtime / Planner / Executor / Policy / Trace，以及 `echo_report` mock Tool 的同步 Plan → Approval → Act 闭环。阶段 2-4 已继续补强：LLM Gateway 新增 JSON 解析入口；Executor 支持步骤审批范围、变量引用解析、Tool 单步超时、高风险 `waiting_review` 中断、失败重试时复用已成功步骤输出，并支持 Plan 阶段只读预览步骤执行；本轮修正 Runtime 异步等待 Planner，并增强 LLM JSON 解析，支持截取带说明文本的 JSON 候选。阶段 5 已继续接入 `chapter_write` 主链路，新增 `resolve_chapter`、`collect_chapter_context`、`write_chapter`、`postprocess_chapter`、`fact_validation`、`extract_chapter_facts`、`rebuild_memory`、`review_memory`、`report_result` Tools，并让章节写作目标生成“写作 → 后处理 → 校验 → 事实抽取 → 记忆重建 → 记忆复核 → 汇总”的结构化 Plan。阶段 6 已落地 `outline_design` 与 `project_import_preview` 主链路，并新增 `validate_outline` / `validate_imported_assets` 写入前只读校验；Plan 阶段现在会提前执行无副作用预览链路并生成大纲、导入、章节上下文等 AgentArtifact，Act 成功后继续拆分校验报告和写入结果。阶段 7 已继续迁移：新增 API 内 `PostProcessChapterService` 最小确定性后处理，复用 `ValidationService.runFactRules()` 作为 `FactValidationService` 过渡能力，新增 API 内 `MemoryRebuildService` 确定性过渡实现，新增 `PolishChapterService` + `polish_chapter` Tool，将章节润色主能力迁入 API；继续新增 `FactExtractorService` 与 `MemoryReviewService`，把 Worker 的摘要、剧情事件/角色状态/伏笔抽取和待确认记忆审计迁入 API；已新增 `RetrievalService`、`PromptBuilderService`、`GenerateChapterService` 与 `ChapterAutoRepairService` + `auto_repair_chapter` Tool，把 Worker 的章节生成 PromptBuilder/Retrieval/LLM 草稿写入主链路和最多一轮有界自动修复迁入 API；旧生成/润色/memory rebuild HTTP 入口已切换为 API 内同步服务链路，删除 Redis 生成队列服务对 Worker internal route 的调用，并移除 LLM 配置变更时通知 Worker reload 的逻辑；本轮新增 `EmbeddingGatewayService`、`MemoryWriterService`，`MemoryRebuildService` 改为通过 MemoryWriter 生成章节摘要和关键场景记忆并尽量附加 embedding，`RetrievalService` 支持 embedding 向量相似度优先、失败降级关键词召回。阶段 8 已增强前端 Agent Workspace：新增 `useAgentRun.retry/replan` 与工作台“失败重试 / 重新规划”操作，Artifact 预览新增章节上下文、润色结果、事实抽取、记忆复核和有界自动修复摘要，历史 Run 可继续恢复最近任务；已补充多版本 Plan 标签、Artifact 去重和步骤级审批勾选；本轮继续补充 Plan 版本差异摘要、长 Artifact 搜索/折叠和审批风险提示。阶段 9 已继续清理 Worker 依赖：`.env.example` 移除 Worker 专用变量并新增 `EMBEDDING_*`，根 `package.json` 移除 `dev:worker`，README 更新为 Web + API 单体启动、API 内 embedding/MemoryWriter 召回链路说明。Planner 已接入 LLM JSON Plan 输出，并以确定性 baseline 作为 schema 参考；当前策略是在 LLM/修复失败时拒绝降级执行低质量 baseline。

> 开发进度同步（2026-04-27 补充）：已开始推进剩余 P0/P1 项。`BaseTool` 新增轻量 `inputSchema` / `outputSchema` 契约字段，Executor 在 Tool 执行前后进行统一 Schema 校验，并先为 `resolve_chapter`、`write_chapter`、`persist_outline`、`persist_project_assets` 等关键写入/入口工具补充契约；Planner 失败新增结构化 `planner_diagnostics` Artifact 与 AgentRun.output 诊断回写，便于前端和排障脚本展示失败阶段、LLM 调用预算和 baseline 摘要。

> 开发进度同步（2026-04-27 剩余项推进）：已按 P0-P3 制定并落地第一批收敛开发。P0：20 个 Agent Tool 已全部声明轻量 `inputSchema` / `outputSchema`，Executor 统一执行前后契约校验。P1：`RuleEngineService` 新增结构化 Policy 配置，`maxSteps` / `maxLlmCalls` 不再散落硬编码，`AgentPolicyService` 已统一识别高风险、破坏性副作用、事实层写入和删除类副作用，并要求 Act 二次确认；前端 Agent Workspace 的确认执行会显式提交 `confirmation.confirmHighRisk=true`。P2：补齐 `POST /agent-runs/:id/approve-step`，用于记录步骤级审批范围，现有 `/act` 仍负责实际同步执行。P3：阶段 9 继续保持“Worker 仅历史参考”的收敛方向，前端组件拆分确认保持当前可运行形态，后续再按 `AgentPlanView` / `AgentTimeline` / `AgentArtifactPreview` / `AgentResultReport` 独立文件拆分。已通过 `pnpm --dir apps/api build` 与 `pnpm --dir apps/web build`。

> 开发进度同步（2026-04-27）：阶段 7 的 P0-P3 增强项已落地。P0 已补生成前 preflight、召回质量诊断/阻断和 embedding / pgvector 失败时的关键词降级，避免低质量上下文继续写库或因向量服务异常导致主链路硬失败；P1 已新增正式 `MemoryChunk.embeddingVector` pgvector 列、HNSW 索引迁移、`RetrievalService` pgvector SQL 检索切换，以及支持 `cursor` 续跑和 `force` 重算的批量 embedding backfill；P2 已新增单次召回评测指标 `recallAt10` / `precisionAt10` / `mrr` 和批量 benchmark API；P3 已新增 `chapter_generation_quality_report` AgentArtifact，并在 Agent Workspace 中提供“生成前与召回质量报告”摘要卡片。已通过 `pnpm --dir apps/api build` 与 `pnpm --dir apps/web build`。

## 当前开发进度快照（2026-04-27）

| 阶段 | 状态 | 说明 |
|---|---|---|
| 阶段 1：Agent 数据模型与 API 基础 | 基本完成 | AgentRun / AgentPlan / AgentStep / AgentArtifact / AgentApproval 模型和基础 API 已落地。 |
| 阶段 2：LLM Gateway 迁移到 API | MVP 完成并已补强 | 已支持 OpenAI-compatible chat、路由配置、超时、重试、tools 字段预留和 `chatJson<T>()` JSON 解析入口；本轮新增 `EmbeddingGatewayService` 和 `embedding`/`agent_planner` 路由步骤。 |
| 阶段 3：Agent Runtime / ToolRegistry / Policy / Executor | MVP 完成并已补强 | Runtime / Planner / Executor / Policy / Trace / ToolRegistry 已可运行；Executor 已支持步骤审批范围、变量引用、Tool 超时、高风险 `waiting_review`、Plan 阶段只读预览执行和失败重试复用成功步骤输出；本轮补齐全部 Tool Schema 契约校验，并把 maxSteps、maxLlmCalls、二次确认、事实层/删除类副作用保护统一下沉到 Rule/Policy。 |
| 阶段 4：Agent 同步执行闭环 | MVP 完成并已补强 | Plan / Approval / Act 同步闭环已跑通，步骤会写入 AgentStep，失败会更新 AgentRun.error；已新增 `retry`、`replan` 与 `approve-step` API，支持失败重试、同一 Run 内新增计划版本和独立记录步骤级审批范围。 |
| 阶段 5：接入 chapter_write | 主链路已补齐后处理/校验/有界修复/事实抽取/记忆回写 | 已支持 `resolve_chapter → collect_chapter_context → write_chapter → postprocess_chapter → fact_validation → auto_repair_chapter → extract_chapter_facts → rebuild_memory → review_memory → report_result`，可以生成草稿、执行轻量后处理、运行确定性事实校验、最多一轮自动修复、抽取剧情事件/角色状态/伏笔、重建自动章节记忆、复核待确认记忆并汇总报告。 |
| 阶段 6：project_import_preview / outline_design | 主链路已开始并补充校验与 Artifact 拆分 | outline_design 已新增 `inspect_project_context`、`generate_outline_preview`、`validate_outline`、`persist_outline` Tools；project_import_preview 已新增 `analyze_source_text`、`build_import_preview`、`validate_imported_assets`、`persist_project_assets` Tools，支持文案分析、导入预览、写入前只读校验和审批后写入项目资料/角色/设定/卷/章节；Runtime 已在 Plan 阶段提前生成预览类 Artifact，并在 Act 成功后生成写入结果等细分 Artifact。 |
| 阶段 7：逐步迁移 Worker Pipeline 到 API Service | 主链路已不再依赖 Worker，MemoryWriter/embedding 召回已迁入 API 并补强质量门禁 | 已新增 API 内 `PostProcessChapterService`、`ValidationService.runFactRules()` 过渡校验、`MemoryRebuildService`、`PolishChapterService`、`FactExtractorService`、`MemoryReviewService`、`RetrievalService`、`PromptBuilderService`、`GenerateChapterService` 和 `ChapterAutoRepairService`；`write_chapter` 已改为调用 API 内生成主链路；旧生成/润色/memory rebuild HTTP 入口已改为 API 内同步执行，删除 `GenerationQueueService` Worker dispatch，并移除 LLM 配置变更通知 Worker reload；`MemoryWriterService` 与 `EmbeddingGatewayService` 已迁入 API，记忆重建可生成章节摘要/关键场景多 chunk 并附加 embedding；本轮新增生成前 preflight、召回质量诊断与阻断、embedding/pgvector 失败关键词降级、正式 `embeddingVector` pgvector 列与 HNSW 索引迁移、支持 cursor/force 的批量 embedding backfill，以及单次/批量召回 benchmark API。 |
| 阶段 8：前端 Agent Workspace | 基础入口已落地并增强失败恢复/Artifact/历史/审批/质量报告体验 | 已新增 `apps/web/hooks/useAgentRun.ts` 与 `apps/web/components/agent/AgentWorkspace.tsx`，接入侧边栏“Agent 工作台”和主页视图，支持输入目标、生成计划、展示风险/步骤/Artifact、确认执行、取消、刷新、失败重试和重新规划；ArtifactPanel 已支持按 artifactType 展示大纲、校验报告、项目资料、角色、设定、写入结果、草稿、润色结果、章节上下文、事实抽取、自动修复、记忆重建和记忆复核摘要卡片；工作台左侧已新增项目内历史 Run 列表，可选择最近 Run 恢复详情；已新增多版本 Plan 标签、Artifact 去重和步骤级审批勾选；本轮补充 Plan 版本差异摘要、Artifact 搜索和原始 JSON 二级折叠，并在需审批步骤上展示写入风险提示；新增 `chapter_generation_quality_report` 生成前与召回质量报告卡片；审批台文案已明确“确认执行”同时作为高风险/事实覆盖/删除类副作用二次确认。组件当前仍以 `AgentWorkspace.tsx` 聚合为主，后续再按设计拆分为独立视图组件。已通过 `pnpm --dir apps/web build`。 |
| 阶段 9：清理 Worker 依赖与文档更新 | 持续推进 | `.env.example` 已移除 `WORKER_PORT` / `WORKER_BASE_URL` 并新增 `EMBEDDING_*`；README 已改为 Web + API 单体启动、API 内 MemoryWriter/embedding 召回说明，并说明 Worker 仅作为历史参考；根 `package.json` 已移除 `dev:worker`；代码层已清除 API 对 Worker internal route 的主链路调用。 |

当前建议下一步：继续细化各 Tool 的 JSON Schema 到更强字段级约束，补充 Policy/Rule 单元测试和端到端审批用例；继续阶段 9 收敛旧 Worker 参考代码、验证脚本和历史架构文档；在真实数据上运行 pgvector migration、embedding backfill 与召回 benchmark，沉淀默认质量阈值。

本文档描述 AI Novel 接入 Agent 的完整开发计划。当前目标是让用户通过自然语言提出创作目标，由 Agent 理解意图、制定 Plan、等待确认，并在 Act 阶段通过后端进程内函数调用完成写作、拆解、校验、入库等动作。

核心目标：

```text
Agent Runtime、Tools、Skills、Rules、LLM Gateway 统一放在 apps/api，
Worker 中的核心 AI 能力逐步迁移为 NestJS Service，
Agent 通过 Tool 直接函数调用 Service，
避免 API ↔ Worker HTTP 调用。
```

最终形态：

```text
Web → apps/api Controller → AgentRunService → AgentRuntime
  → AgentPlanner / AgentExecutor
  → ToolRegistry / Policy / Trace
  → NestJS Service / Prisma / LLM Gateway
```

执行约束：

- Plan / Act 由 API 后端同步完成。
- Agent 调 Tool 是进程内函数调用。
- 不设计独立 Agent 执行进程。
- Redis 只用于缓存、锁、上下文暂存等，不承担 Agent 执行调度。
- 对 LLM 慢请求通过超时、重试、步骤记录、前端 loading 和必要的流式响应优化处理。

---

## 2. 总体里程碑

```text
阶段 0：准备与基线确认
阶段 1：Agent 数据模型与 API 基础
阶段 2：LLM Gateway 迁移到 API
阶段 3：Agent Runtime / ToolRegistry / Policy / Executor
阶段 4：Agent 同步执行闭环
阶段 5：接入 chapter_write
阶段 6：接入 project_import_preview / outline_design
阶段 7：逐步迁移 Worker Pipeline 到 API Service
阶段 8：前端 Agent Workspace
阶段 9：清理 Worker 依赖与文档更新
```

---

## 3. 阶段 0：准备与基线确认

### 目标

确认当前系统可运行，并明确迁移边界。

### 工作项

- 梳理 Worker 现有 pipeline：
  - `generate_chapter.py`
  - `postprocess_chapter.py`
  - `polish_chapter.py`
  - `fact_validation.py`
  - `rebuild_memory.py`
- 梳理 Worker service：
  - `llm_gateway.py`
  - `prompt_builder.py`
  - `retrieval_service.py`
  - `validation_engine.py`
  - `summary_service.py`
  - `fact_extractor.py`
  - `memory_writer.py`
- 梳理 API 当前 Prisma schema 和 Service 能力。
- 明确 Redis 在 Agent 架构中只承担缓存、锁、上下文暂存等辅助职责。

### 交付物

- Worker 能力迁移清单；
- API 目标模块清单；
- MVP 范围确认。

---

## 4. 阶段 1：Agent 数据模型与 API 基础

### 目标

建立 AgentRun 生命周期和基础查询能力。

### 数据库改动

在 `apps/api/prisma/schema.prisma` 新增：

```text
AgentRun
AgentPlan
AgentStep
AgentArtifact
AgentApproval
```

### API 模块

新增：

```text
apps/api/src/modules/agent-runs/
  agent-runs.module.ts
  agent-runs.controller.ts
  agent-runs.service.ts
  dto/create-agent-plan.dto.ts
  dto/execute-agent-run.dto.ts
```

### 接口

```text
POST /api/agent-runs/plan
GET  /api/agent-runs/:id
GET  /api/projects/:projectId/agent-runs
POST /api/agent-runs/:id/act
POST /api/agent-runs/:id/cancel
```

### 验收标准

- 可以创建 AgentRun；
- 可以查询 AgentRun、Plan、Step、Artifact；
- 可以把 AgentRun 状态从 `planning` 更新到 `waiting_approval`；
- 可以记录用户审批。

### 当前进度

- 已在 `apps/api/prisma/schema.prisma` 新增 `AgentRun`、`AgentPlan`、`AgentStep`、`AgentArtifact`、`AgentApproval`。
- 已新增 `apps/api/src/modules/agent-runs/`，支持创建 Plan、查询 Run、按项目查询、Act 审批执行、取消。
- 已将 AgentRun 模块接入 `AppModule`。

---

## 5. 阶段 2：LLM Gateway 迁移到 API

### 目标

Agent Planner 需要在 API 内调用 LLM，因此优先迁移 LLM Gateway。

### 新增模块

```text
apps/api/src/modules/llm/
  llm.module.ts
  llm-gateway.service.ts
  llm-provider.service.ts
  dto/llm-chat.dto.ts
```

### 功能要求

- 支持 OpenAI-compatible `/chat/completions`；
- 支持按 appStep 路由模型配置；
- 支持超时、重试、错误格式化；
- 返回文本、usage、model、rawPayload 摘要；
- 第一版不强制支持 function calling，但接口预留 `tools` 字段。

### 迁移来源

参考：

```text
apps/worker/app/services/llm_gateway.py
apps/api/src/modules/guided/llm.service.ts
```

### 验收标准

- API 内可以成功调用 LLM；
- Agent Planner 可以依赖 `LlmGatewayService`；
- 错误信息对用户和日志可读。

### 当前进度

- 已新增 `apps/api/src/modules/llm/llm-gateway.service.ts`，兼容 OpenAI `/chat/completions`。
- 已支持 appStep 路由、环境变量兜底、超时、重试、usage/model/rawPayloadSummary 返回和 `tools` 字段预留。
- 已新增 `chatJson<T>()` 结构化 JSON 解析入口，可解析纯 JSON、```json fenced block 和前后带说明文本的 JSON 候选；Planner 已接入 LLM JSON Plan，并保留确定性 baseline fallback。

---

## 6. 阶段 3：Agent Runtime / ToolRegistry / Policy / Executor

### 目标

实现 Agent 的核心运行时。

### 新增文件

```text
apps/api/src/modules/agent-runs/
  agent-runtime.service.ts
  agent-planner.service.ts
  agent-executor.service.ts
  agent-policy.service.ts
  agent-trace.service.ts

apps/api/src/modules/agent-tools/
  agent-tools.module.ts
  base-tool.ts
  tool-registry.service.ts

apps/api/src/modules/agent-skills/
  agent-skills.module.ts
  skill-registry.service.ts
  builtin-skills.ts

apps/api/src/modules/agent-rules/
  agent-rules.module.ts
  rule-engine.service.ts
  builtin-rules.ts
```

### Runtime 职责

- `plan(agentRunId)`：生成 AgentPlan 和 Artifact；
- `act(agentRunId)`：执行已确认 Plan；
- 管理状态流转；
- 捕获错误并写入 AgentRun.error。

### Planner 职责

- 调用 Intent Classifier；
- 选择 Skill；
- 筛选 Tools；
- 拼接 Rules / Skills / Tools / Context；
- 调 LLM 输出 JSON Plan；
- 校验 Plan。

### Executor 职责

- 遍历 Plan steps；
- 解析变量引用；
- 调用 ToolRegistry；
- 执行 Policy 检查；
- 调用 Tool.run；
- 保存 AgentStep。

### Policy 第一版规则

```text
Plan 模式禁止执行有正式业务写入的 Tool
Act 模式只能执行 Plan 中声明的 Tool
requiresApproval=true 的 Tool 必须有 Approval
禁止调用未注册 Tool
限制 maxSteps / maxLlmCalls
```

### 验收标准

- Planner 能生成结构化 Plan；
- Executor 能执行 mock Tool；
- Policy 能拦截非法 Tool；
- AgentStep 能记录每一步输入、输出、错误。

### 当前进度

- 已新增 Runtime、Planner、Executor、Policy、Trace 核心服务。
- 已新增 ToolRegistry / BaseTool，并注册无副作用 `echo_report` mock Tool 与只读 `resolve_chapter` Tool。
- 已新增 SkillRegistry / RuleEngine 和内置 MVP Skill / 硬规则。
- 已实现同步执行路径：Plan 生成 `AgentPlan` + `AgentArtifact`，Act 审批后执行 `echo_report` 并记录 `AgentStep`。
- Executor 已补强步骤级审批范围、`{{steps.N.output.path}}` 变量引用解析、Tool 单步超时和高风险工具未显式审批时的人工复核中断。

---

## 7. 阶段 4：Agent 同步执行闭环

### 目标

把 AgentRun API、Runtime、Planner、Executor、Policy、ToolRegistry 串成可运行闭环。Controller 收到请求后调用 Service，Service 在当前请求内完成 Plan 或 Act，并把步骤、产物、错误写入数据库。

### 后端调用链

```text
AgentRunsController
  → AgentRunsService
  → AgentRuntime.plan() / AgentRuntime.act()
  → AgentPlanner / AgentExecutor
  → ToolRegistry.get()
  → Policy.assertAllowed()
  → Tool.run()
  → AgentTraceService.record()
```

### 工作项

- `POST /api/agent-runs/plan` 同步创建 AgentRun、生成 Plan、保存 Artifact，并返回 `waiting_approval`。
- `POST /api/agent-runs/:id/act` 同步校验 Approval、执行已确认 Plan，并返回执行结果。
- 每个 step 执行前后都写入 `AgentStep`。
- 执行失败时记录 `AgentRun.error` 和失败 step。
- 命中高风险步骤时停止执行并进入 `waiting_review`。
- 为 LLM 调用和 Tool 调用设置单步超时、最大步骤数和最大模型调用次数。

### 验收标准

- Plan 请求返回时已经生成可展示计划和预览产物；
- Act 请求返回时已经完成已确认步骤或明确进入 `waiting_review` / `failed`；
- mock Tool、LLM Planner、Policy 拦截、Trace 记录都能跑通；
- 不依赖外部执行进程即可完成 Agent 最小闭环。

### 当前进度

- `POST /api/agent-runs/plan` 已同步创建 AgentRun、生成 AgentPlan、保存 Artifact，并返回 `waiting_approval`。
- `POST /api/agent-runs/:id/act` 已记录审批并同步执行 Plan，支持传入 `approvedStepNos` 限定审批范围。
- Executor 执行前后通过 AgentTrace 写入 AgentStep，失败时会记录失败 step 并由 Runtime 写入 AgentRun.error。
- 高风险 Tool 未显式审批时会停止执行，并将 AgentRun 更新为 `waiting_review`。
- Tool 执行已加入单步超时；LLM 调用已有 Gateway 级超时和重试。`maxLlmCalls` 仍待 Planner 真正接入 LLM 后统一计数。

---

## 8. 阶段 5：接入 chapter_write

### 目标

让 Agent 支持“帮我写某章正文”，并完成上下文读取、正文生成、后处理、事实校验、草稿入库和结果汇总。

### Agent 能力

```text
用户自然语言
  → Intent: chapter_write
  → Skill: chapter-writing
  → Plan: resolve_chapter / collect_context / write_chapter / fact_validation / report_result
  → Act: 调用后端 Service 完成生成和入库
```

### Tools

```text
resolve_chapter
collect_chapter_context
write_chapter
postprocess_chapter
fact_validation
report_result
```

### 第一版实现策略

- `resolve_chapter` 调用现有章节 Service 查询章节。
- `collect_chapter_context` 读取项目、卷、章节、角色、伏笔、前文摘要、记忆召回数据。
- `write_chapter` 优先封装迁移后的 `GenerateChapterService`；迁移未完成前只保留最小兼容层，并明确后续删除。
- `fact_validation` 调用迁移后的校验 Service。
- `rebuild_memory` Tool，基于当前草稿重建章节自动记忆，供后续上下文召回。
- `report_result` Tool，汇总 draftId、摘要、字数、校验问题、记忆回写结果和下一步建议。

### 验收标准

- 用户输入“帮我写第 X 章”能生成结构化 Plan；
- 用户确认后能生成章节草稿并入库；
- AgentRun 输出包含 draftId、summary、actualWordCount、validationIssues；
- Plan 模式不会写草稿表。

### 当前进度

- 已新增 `resolve_chapter` Tool，通过 `chapterId` 或章节编号在当前项目内解析章节，并返回标题、状态、目标、冲突、大纲和预期字数等后续写作上下文。
- 已将 `resolve_chapter` 注册进 ToolRegistry，并通过 Prisma 只读查询保证无正式业务写入副作用。
- 已新增 `collect_chapter_context` Tool，读取项目资料、目标章节、前 5 章当前草稿摘录、角色、设定和记忆片段，作为章节写作上下文。
- 已新增 `write_chapter` Tool，通过 API 内 `LlmGatewayService` 调用生成模型，创建新的 `ChapterDraft` 当前版本，并更新章节 `status= drafted` 与 `actualWordCount`。
- 已新增 `report_result` Tool，汇总 draftId、chapterId、actualWordCount、summary、validationIssues 和下一步建议，供 AgentRun 结果展示。
- Planner 已能识别“第 X 章/章节/正文”类目标，生成 `resolve_chapter → collect_chapter_context → write_chapter → report_result` 的章节写作 Plan，并从用户目标中提取章节号和目标字数。
- 已新增 `postprocess_chapter` Tool，调用 API 内 `PostProcessChapterService` 执行轻量确定性后处理：标准化换行/尾随空白、必要时创建新草稿版本，并同步章节字数。
- 已新增 `fact_validation` Tool，复用 API 内 `ValidationService.runFactRules()` 删除并重建当前章节事实规则问题，输出 `issues`、`createdCount` 和事实计数。
- Planner 已将章节写作 Plan 扩展为 `resolve_chapter → collect_chapter_context → write_chapter → postprocess_chapter → fact_validation → rebuild_memory → report_result`，并要求用户审批写入/校验/记忆回写步骤。
- `report_result` 已汇总后处理步骤与校验问题，`validationIssues` 不再固定为空数组。
- 已新增 `rebuild_memory` Tool，调用 API 内 `MemoryRebuildService` 替换当前章节由 Agent 自动生成的 `MemoryChunk`，`report_result` 会展示 `memoryRebuild` 结果。
- 已新增 `extract_chapter_facts` Tool，调用 API 内 `FactExtractorService` 抽取章节摘要、剧情事件、角色状态和伏笔，并写入事实层表。
- 已新增 `review_memory` Tool，调用 API 内 `MemoryReviewService` 审计 `pending_review` 记忆并更新为确认或拒绝状态。
- Planner 已将章节写作 Plan 继续扩展为 `resolve_chapter → collect_chapter_context → write_chapter → postprocess_chapter → fact_validation → extract_chapter_facts → rebuild_memory → review_memory → report_result`，覆盖正文、后处理、事实校验、事实沉淀、记忆重建和记忆复核。
- 已新增 `auto_repair_chapter` Tool，调用 API 内 `ChapterAutoRepairService` 对校验问题最多执行一轮最小必要修复，避免无限自动改稿。
- Planner 已将章节写作 Plan 升级为 `resolve_chapter → collect_chapter_context → write_chapter → postprocess_chapter → fact_validation → auto_repair_chapter → extract_chapter_facts → rebuild_memory → review_memory → report_result`，事实抽取和记忆重建会优先使用自动修复后的草稿。
- `write_chapter` Tool 已改为调用 API 内 `GenerateChapterService`，由 `PromptBuilderService` 和 `RetrievalService` 负责装配项目/分卷/文风/角色/伏笔/前文/设定/记忆上下文，不再在 Tool 内直接拼接简化 Prompt。
- 已通过 `pnpm --dir apps/api build` 验证 API 构建成功。

---

## 9. 阶段 6：接入 project_import_preview / outline_design

### 目标

支持用户提供一份文案，Agent 将其拆分、完善并生成项目资料、角色、世界观、大纲预览；也支持用户要求“帮我写文章大纲”“把第一卷拆成 30 章”。

### 文案拆解 Tools

```text
analyze_source_text
extract_project_profile_preview
extract_characters_preview
extract_lorebook_preview
extract_outline_preview
build_import_preview
persist_project_assets
validate_imported_assets
```

### 大纲设计 Tools

```text
inspect_project_context
generate_outline_preview
split_volume_to_chapters
validate_outline
persist_outline
```

### Plan 阶段输出

Plan 阶段只写入 `AgentArtifact`，不写正式业务表：

```text
project_import_preview
characters_preview
lorebook_preview
outline_preview
chapter_outline_preview
```

### Act 阶段写入

用户确认后才执行：

```text
persist_project_profile
persist_characters
persist_lorebook_entries
persist_volumes
persist_chapters
persist_outline
```

### 验收标准

- 用户文案可生成结构化预览；
- 用户可查看并确认预览内容；
- 用户确认后可以写入角色、设定、卷、章节；
- 大纲生成支持章节目标、冲突、钩子、字数建议和连续性检查。

### 当前进度

- 已新增 `inspect_project_context` Tool，读取项目、卷、已有章节、角色和设定上下文。
- 已新增 `generate_outline_preview` Tool，优先使用 LLM JSON 输出卷/章节大纲预览；无 LLM 配置或 JSON 失败时使用确定性 fallback，保证 Agent 闭环可运行。
- 已新增 `persist_outline` Tool，审批后写入 Volume 和 Chapter；只创建缺失章节并更新 `planned` 状态章节，避免覆盖已起草/已审阅章节。
- Planner 已能识别大纲/卷/拆成 N 章类目标，生成 `inspect_project_context → generate_outline_preview → persist_outline → report_result` 的结构化 Plan，并将 `persist_outline` 作为高风险审批步骤。
- 已新增 `validate_outline` Tool，在持久化前只读校验章节编号、章节数一致性、连续性、必填字段和预期字数风险；Planner 已将大纲链路升级为 `inspect_project_context → generate_outline_preview → validate_outline → persist_outline → report_result`，仍只要求审批真正写入的 `persist_outline` 步骤。
- 已新增 `analyze_source_text` Tool，对用户提供的文案进行确定性段落拆分和关键词提取。
- 已新增 `build_import_preview` Tool，优先使用 LLM JSON 输出项目资料、角色、设定、卷和章节预览；无 LLM 配置或 JSON 失败时使用确定性 fallback。
- 已新增 `persist_project_assets` Tool，审批后写入项目资料、追加角色和设定、upsert 卷，并只创建缺失章节或更新 `planned` 章节，避免覆盖已起草内容。
- Planner 已能识别文案/拆解/角色/世界观类目标，生成 `analyze_source_text → build_import_preview → persist_project_assets → report_result` 的结构化 Plan，并将 `persist_project_assets` 作为高风险审批步骤。
- 已新增 `validate_imported_assets` Tool，在导入写入前只读校验项目资料完整性、角色/卷/章节重复、设定必填字段和章节引用卷号风险；Planner 已将导入链路升级为 `analyze_source_text → build_import_preview → validate_imported_assets → persist_project_assets → report_result`，仍只要求审批真正写入的 `persist_project_assets` 步骤。
- 已调整 Planner 意图分类优先级，让“大纲/拆成 N 章/章节大纲”优先于泛化“章节/正文”，减少章节大纲被误判为正文写作的情况。
- Runtime 已在 Act 成功后将关键 Tool 输出提升为细分 AgentArtifact：`outline_preview`、`outline_validation_report`、`outline_persist_result`、`project_profile_preview`、`characters_preview`、`lorebook_preview`、`import_validation_report`、`import_persist_result`，方便前端按产物类型展示。
- `report_result` 已按章节写作、大纲设计、文案导入三类输出不同后续建议，并在 outline/import 校验存在 issue 时优先提示用户检查校验报告。
- 已通过 `pnpm --dir apps/api build` 验证 API 构建成功。

---

## 10. 阶段 7：逐步迁移 Worker Pipeline 到 API Service

### 目标

消除 Python Worker 主链路依赖，实现 Agent Tool 直接调用 NestJS Service。

### 迁移顺序

#### 10.1 轻量确定性能力优先

```text
FactValidationPipeline → FactValidationService
ValidationEngine → ValidationEngineService
PostProcessChapterPipeline → PostProcessChapterService
```

#### 10.2 LLM 周边能力

```text
PromptBuilder → PromptBuilderService
SummaryService → SummaryService
FactExtractor → FactExtractorService
PolishChapterPipeline → PolishChapterService
```

#### 10.3 召回和记忆

```text
RetrievalService → RetrievalService
MemoryWriter → MemoryWriterService
RebuildMemoryPipeline → MemoryRebuildService
```

### 当前进度

- 已新增 `apps/api/src/modules/memory/memory-rebuild.service.ts`，作为 `RebuildMemoryPipeline` 的 API 内过渡实现。
- 已新增 `rebuild_memory` Tool 并注册到 ToolRegistry，章节写作 Act 链路会在事实校验后重建当前章节自动记忆。
- 当前 `MemoryRebuildService` 只替换 `metadata.generatedBy = agent_memory_rebuild` 的自动记忆，避免误删人工维护或其他来源的记忆；本轮已改为调用 `MemoryWriterService` 写入章节摘要和关键场景多 chunk，并尽量附加 embedding。
- 已新增 `apps/api/src/modules/facts/fact-extractor.service.ts`，迁移 Worker `SummaryService` 与 `FactExtractor` 核心能力，支持摘要、剧情事件、角色状态和伏笔抽取，并写入 `StoryEvent`、`CharacterStateSnapshot`、`ForeshadowTrack`。
- 已新增 `apps/api/src/modules/memory/memory-review.service.ts`，迁移 Worker `MemoryReviewPipeline` 核心能力，对 `pending_review` 记忆输出 confirm/reject 决策并更新状态。
- 已新增 `extract_chapter_facts` / `review_memory` Tools 并注册到 ToolRegistry，章节写作和章节润色 Act 链路均已接入。
- 已新增 `apps/api/src/modules/memory/retrieval.service.ts`，迁移 Worker `RetrievalService` 的核心召回接口；本轮已支持 embedding 查询向量 + MemoryChunk embedding cosine 相似度优先排序，embedding 不可用时自动降级关键词重叠 + 重要度/新近度排序。
- 已新增 `apps/api/src/modules/llm/embedding-gateway.service.ts` 与 `apps/api/src/modules/memory/memory-writer.service.ts`，迁移 Worker MemoryWriter 的 embedding 附加和记忆写入职责到 API 内。
- 已新增 `apps/api/src/modules/generation/prompt-builder.service.ts`，迁移 Worker `PromptBuilder` 的章节写作上下文拼装能力，支持 DB PromptTemplate 优先与内置 fallback。
- 已新增 `apps/api/src/modules/generation/generate-chapter.service.ts`，迁移 Worker `GenerateChapterPipeline` 的章节生成主链路核心：加载项目/章节/分卷/文风/角色/伏笔/前文，执行召回，构建 Prompt，调用 LLM，并创建 `ChapterDraft` 当前版本。
- 已新增 `apps/api/src/modules/generation/chapter-auto-repair.service.ts` 和 `auto_repair_chapter` Tool，支持对事实校验问题最多一轮自动修复，并写入 `agent_auto_repair` 草稿版本。
- `write_chapter` Tool 已切换为调用 `GenerateChapterService`，Agent 章节生成不再通过 Worker 路由，也不再使用 Tool 内简化 Prompt。
- 旧 `POST /chapters/:chapterId/generate` 已切换为 API 内同步链路：创建 `GenerationJob` 后直接执行 `GenerateChapterService → PostProcessChapterService → FactExtractorService → ValidationService → MemoryRebuildService → MemoryReviewService`，不再投递 Redis 队列或调用 Worker internal route。
- 旧 `POST /chapters/:chapterId/polish` 已切换为 API 内 `PolishChapterService`，并同步执行事实抽取、校验、记忆重建与记忆复核。
- `POST /projects/:projectId/memory/rebuild` 已切换为 `MemoryRebuildService.rebuildProject()`，支持单章/全项目与 dry-run diffSummary，不再依赖 Worker rebuild。
- 已删除 API 内 `GenerationQueueService` 的 Worker dispatch 实现，并移除 LLM 配置更新时通知 Worker reload 的逻辑。

#### 10.4 章节生成主链路

```text
GenerateChapterPipeline → GenerateChapterService
```

### 验收标准

- `write_chapter` Tool 不再通过 Worker 路由；
- 章节生成、后处理、校验、记忆回写都在 API 内完成；
- 生成结果与迁移前字段兼容；
- 旧 Worker 代码只作为参考或过渡实现存在。

---

## 11. 阶段 8：前端 Agent Workspace

### 目标

提供 Agent 主入口，让用户以自然语言驱动创作任务。

### 新增组件

```text
apps/web/components/agent/
  AgentWorkspace.tsx
  AgentInputBox.tsx
  AgentPlanView.tsx
  AgentTimeline.tsx
  AgentArtifactPreview.tsx
  AgentApprovalDialog.tsx
  AgentResultReport.tsx

apps/web/hooks/useAgentRun.ts
```

### 功能

- 输入自然语言目标；
- 生成 Plan；
- 展示 Agent 理解、风险、步骤和预览；
- 用户确认执行；
- 展示执行时间线；
- 展示最终报告；
- 支持失败重试、重新规划、取消执行。

### 验收标准

- 用户可完成 Plan → Approval → Act 全流程；
- AgentStep 时间线可读；
- Artifact 可预览；
- 失败状态有明确错误提示。

### 当前进度

- 已新增 `apps/web/hooks/useAgentRun.ts`，封装 `POST /agent-runs/plan`、`GET /agent-runs/:id`、`POST /agent-runs/:id/act`、`POST /agent-runs/:id/cancel`，并维护当前 Run、loading、error 和 actionMessage。
- `useAgentRun` 已新增 `listByProject(projectId)` 和 `runHistory` 状态，复用后端 `GET /projects/:projectId/agent-runs` 拉取项目内最近 Run。
- 已新增 `apps/web/components/agent/AgentWorkspace.tsx`，以“Agent Ops Console”风格提供自然语言任务输入、示例任务、计划简报、执行时间线、Artifact 预览、审批控制台和最终报告。
- `AgentWorkspace` 的 ArtifactPanel 已增强为分类型摘要卡片：支持 `outline_preview`、`outline_validation_report`、`import_validation_report`、`project_profile_preview`、`characters_preview`、`lorebook_preview`、`outline_persist_result`、`import_persist_result`、`chapter_draft_result`、`memory_rebuild_report` 等产物的业务化摘要，同时保留原始 JSON 便于调试。
- `AgentWorkspace` 左侧已新增历史 Run 面板，进入工作台时自动拉取当前项目最近 Run，支持手动刷新和点击恢复完整 Run 详情。
- `AgentWorkspace` 已新增多版本 Plan 标签展示，方便重新规划后识别当前最新版本。
- `AgentWorkspace` 已对 Artifact 按类型和标题去重，避免 Plan/Act 或多次 replan 产生重复卡片淹没有效结果。
- `AgentWorkspace` 已支持步骤级审批勾选，传入空数组时后端会严格按“无写入步骤被审批”处理，不再退化为全量审批。
- ArtifactPanel 已新增 `auto_repair_report` 摘要卡片，展示自动修复是否跳过、修复问题数和修复后字数。
- `AgentWorkspace` 已新增最新 Plan 相对上一版本的差异摘要，展示新增步骤、移除步骤和审批数量变化。
- ArtifactPanel 已新增产物搜索和原始 JSON 二级折叠，长产物默认展示业务摘要，按需展开调试信息。
- TimelinePanel 已在需审批步骤上展示写入风险提示，提醒用户取消勾选会使后端不把对应步骤视为已审批。
- 已在 `WorkspaceSidebar` 增加“Agent 工作台”导航入口，并在 `apps/web/app/page.tsx` 接入 `agent` activeView。
- 已修复 Web 构建过程中暴露的 TypeScript 严格类型问题：`ProviderForm` 的可选 `apiKey` 删除类型转换，以及 `useGuidedSession` 中弱类型 stepData key 到 `StepKey` 的收窄。
- 已通过 `pnpm --dir apps/api build` 与 `pnpm --dir apps/web build` 验证 API / Web 构建成功。

---

## 12. 阶段 9：清理 Worker 依赖与文档更新

### 目标

在 API 完成核心能力迁移后，移除 Python Worker 运行依赖。

### 工作项

- 删除或归档 Worker internal route 调用；
- README 更新启动方式；
- Docker 编排去掉 Worker 服务；
- `.env.example` 清理 Worker 专用变量；
- 文档更新为 Agent-Centric Backend Monolith 同步执行架构；
- 保留旧 Worker 代码一段时间作为参考，确认稳定后移除。

### 验收标准

- 本地核心功能不再依赖 Python Worker；
- 章节生成和 Agent 任务均由 API 内 Service 执行；
- 文档、环境变量、启动脚本一致。

---

## 13. 开发优先级建议

### P0：Agent 基建

```text
Agent 数据模型
AgentRun API
LlmGatewayService
AgentRuntime
AgentPlanner
AgentExecutor
AgentPolicy
AgentTrace
ToolRegistry
SkillRegistry
RuleEngine
```

### P1：核心 Agent 能力

```text
chapter_write Skill / Tools
project_import_preview Skill / Tools
outline_design Skill / Tools
Agent Workspace 基础 UI
```

### P2：Worker 能力迁移

```text
FactValidationService
PostProcessChapterService
PolishChapterService
PromptBuilderService
FactExtractorService
SummaryService
```

### P3：完整创作闭环

```text
GenerateChapterService 完整迁移
Memory / Retrieval 完整迁移
项目导入 Act 写入
大纲持久化
旧 Worker 依赖清理
```

---

## 14. 风险与应对

| 风险 | 应对 |
|---|---|
| 一次性迁移 Worker 工作量过大 | 按 Tool 维度迁移，优先迁移确定性能力，再迁移生成主链路 |
| LLM JSON Plan 不稳定 | JSON schema 校验 + 自动修复重试 + fallback 规则 |
| Agent 误写数据 | Plan/Act 分离 + Policy + Approval |
| 单次请求耗时过长 | 单步超时、最大步骤数、前端 loading、必要时采用流式响应 |
| 迁移后生成质量变化 | 保留旧 Prompt，逐步对齐输出字段 |
| 数据写入中途失败 | Prisma transaction + AgentStep trace + failed 状态 |
| Tool 越权调用 | ToolRegistry 白名单 + RuleEngine |

---

## 15. 推荐 Sprint 拆分

### Sprint 1：Agent 数据层和 API

- 新增 Prisma Agent 模型；
- 新增 AgentRun API；
- 支持创建、查询、取消、审批；
- 保存 AgentPlan、AgentStep、AgentArtifact。

### Sprint 2：Agent Runtime 核心

- 实现 AgentRuntime；
- 实现 AgentPlanner；
- 实现 AgentExecutor；
- 实现 AgentPolicy；
- 实现 AgentTrace；
- 支持 mock plan / mock tool 闭环。

### Sprint 3：Tools / Skills / Rules

- 实现 BaseTool、ToolRegistry；
- 实现 SkillRegistry 和内置 Skill；
- 实现 RuleEngine 和内置硬规则；
- Planner 请求 LLM 时注入 Tools / Skills / Rules；
- 校验 LLM 输出的 JSON Plan。

### Sprint 4：章节写作 Agent

- 实现 chapter-writing Skill；
- 实现 resolve_chapter、collect_chapter_context、write_chapter、fact_validation、report_result；
- 接入 LlmGatewayService；
- 完成章节草稿入库和结果报告。

### Sprint 5：文案拆解和大纲 Agent

- 实现 import-breakdown Skill；
- 实现 outline-design Skill；
- 实现文案分析、角色预览、世界观预览、大纲预览；
- 实现用户确认后的项目资料写入。

### Sprint 6：Worker 迁移第一批

- 迁移 FactValidation；
- 迁移 PostProcess；
- 迁移 Polish；
- 更新对应 Tool 为直接调用 API Service。

### Sprint 7：生成主链路迁移

- 迁移 PromptBuilder；
- 迁移 Summary / FactExtractor；
- 迁移 Retrieval / MemoryWriter；
- 迁移 GenerateChapterService；
- 清理 Worker 依赖。

---

## 16. 完成定义

Agent-Centric MVP 完成时应满足：

```text
1. 用户可以自然语言创建 AgentRun。
2. Agent 可以生成结构化 Plan。
3. 用户可以确认 Plan 并进入 Act。
4. Executor 可以通过 ToolRegistry 调用工具。
5. Policy 能阻止非法写入。
6. AgentStep 能完整记录执行过程。
7. Planner 请求 LLM 时会注入 Tools、Skills、Rules 和项目上下文。
8. 至少支持 chapter_write、project_import_preview、outline_design 三类任务。
9. Agent Tool 以 API 内函数调用为目标形态。
10. Worker 核心能力具备明确迁移路径。
```
