# Agent-Centric 创作系统设计文档

## 1. 目标

本设计目标是将当前 AI Novel 从“功能按钮 + 固定 Pipeline”的系统，升级为以 Agent 为主入口的创作系统。

用户未来可以直接用自然语言提出目标：

```text
帮我写第 12 章正文，压迫感强一点。
这是我的小说文案，帮我拆成角色、世界观和前三卷大纲。
帮我检查当前大纲有没有剧情矛盾。
把第一卷拆成 30 章，每章要有目标、冲突和钩子。
```

Agent 负责理解目标、制定方案、调用工具、执行任务、校验结果，并在用户确认后写入项目数据。

---

## 2. 核心结论

推荐采用 **Agent-Centric Backend Monolith 同步执行架构**：

```text
apps/web
  ↓
apps/api
  - REST API
  - AgentRun 管理
  - 用户审批
  - 状态查询
  - AgentRuntime
  - ToolRegistry
  - GenerationService
  - ValidationService
  - MemoryService
  - LlmGateway
  ↓
PostgreSQL / Redis / LLM Provider
```

关键点：

- Agent Runtime 放到 `apps/api`。
- Worker 中的 Python pipeline 能力逐步迁移为 NestJS Service。
- Agent 调用 Tool 时直接函数调用，不再通过 API 调 Worker。
- Plan / Act 都在 API 后端同步执行，Controller 调用 Service，Service 调用 Agent Runtime。
- 不引入独立任务调度层或独立 Agent 执行进程。
- Redis 后续只保留缓存、锁、上下文暂存等用途，不承担 Agent 执行调度。

---

## 3. 设计原则

### 3.1 Agent 是主入口

用户不再需要理解底层“生成、润色、校验、记忆重建”等按钮，而是直接对 Agent 提目标。

```text
用户目标 → Agent → Plan → Tool → Service → DB / LLM
```

### 3.2 Plan / Act 双模式

Agent 分为两个阶段：

```text
Plan 模式：理解目标、制定方案、生成预览，不写正式业务数据。
Act 模式：用户确认后，按计划执行工具、写入数据、校验结果。
```

### 3.3 LLM 不直接操作系统

LLM 只能输出结构化计划或 ToolCall。真实执行必须经过：

```text
ToolRegistry 白名单
Policy 权限检查
Schema 参数校验
Approval 审批检查
Executor 执行
Trace 记录
```

### 3.4 Pipeline 工具化复用

现有 Worker pipeline 不直接废弃，迁移时先包装成 Tool，再逐步重写为 TypeScript Service。

```text
GenerateChapterPipeline → write_chapter Tool → GenerateChapterService
PolishChapterPipeline   → polish_chapter Tool → PolishChapterService
FactValidationPipeline  → fact_validation Tool → FactValidationService
RebuildMemoryPipeline   → rebuild_memory Tool → MemoryRebuildService
```

---

## 4. 核心概念

### 4.1 Agent

Agent 是任务执行体，负责：

- 理解用户目标；
- 判断任务类型；
- 选择 Skill；
- 加载 Rules；
- 筛选 Tools；
- 制定 Plan；
- 执行 Act；
- 生成结果报告。

推荐 Agent 类型：

```text
CreativeAgent            总入口 Agent
ImportAgent              文案拆解 / 导入 Agent
OutlineAgent             大纲 Agent
CharacterAgent           角色 Agent
WorldbuildingAgent       世界观 Agent
ChapterWritingAgent      章节写作 Agent
RevisionAgent            修改 / 润色 Agent
ConsistencyAgent         一致性检查 Agent
MemoryAgent              记忆整理 Agent
```

第一版可以只实现 `CreativeAgent`，内部基于 taskType 调度不同工具。

### 4.2 Tool

Tool 是 Agent 可调用的受控能力。

Tool 可以包装：

- NestJS Service；
- Prisma Repository；
- LLM Gateway；
- 迁移前的 Worker Client；
- 迁移后的业务 Pipeline Service。

Tool 必须声明：

```text
name
description
inputSchema
outputSchema
allowedModes
riskLevel
requiresApproval
sideEffects
```

### 4.3 Skill

Skill 是专业方法论，不直接执行写库动作。

示例：

```text
chapter-writing       章节正文写作技能
import-breakdown      用户文案拆解导入技能
outline-design        大纲设计技能
character-design      角色塑造技能
worldbuilding         世界观构建技能
continuity-check      连贯性检查技能
```

Skill 包含适用场景、推荐步骤、默认工具、输出格式、检查清单和禁忌事项。

### 4.4 Rule

Rule 是 Agent 必须遵守的约束。

规则类型：

```text
Hard Rule       代码强制，LLM 不能绕过
Soft Rule       注入 Prompt，引导 LLM 行为
Approval Rule   命中后等待用户确认
Validation Rule 执行后校验
```

第一版硬规则：

```text
Plan 模式禁止写正式业务表
Act 模式只能执行已批准计划
禁止调用未注册工具
写入角色/设定/大纲必须用户确认
删除操作必须显式二次确认
自动修稿最多 1 轮
禁止未审批覆盖已确认事实
```

---

## 5. Plan / Act 状态机

```text
planning
  ↓
waiting_approval
  ↓
acting
  ↓
succeeded
```

异常状态：

```text
failed
cancelled
waiting_review
```

| 状态 | 含义 |
|---|---|
| planning | Agent 正在理解目标和制定计划 |
| waiting_approval | 计划已生成，等待用户确认 |
| acting | 正在执行已确认计划 |
| waiting_review | 执行中遇到高风险或不确定项，等待确认 |
| succeeded | 执行完成 |
| failed | 执行失败 |
| cancelled | 用户取消 |

---

## 6. 数据模型

### 6.1 AgentRun

记录一次用户目标。

```prisma
model AgentRun {
  id          String   @id @default(uuid())
  projectId   String
  chapterId   String?
  agentType   String
  taskType    String?
  status      String
  mode        String
  goal        String
  input       Json
  output      Json?
  error       String?
  policy      Json?
  createdBy   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  plans       AgentPlan[]
  steps       AgentStep[]
  artifacts   AgentArtifact[]
  approvals   AgentApproval[]
}
```

### 6.2 AgentPlan

记录 Agent 制定的执行计划。

```prisma
model AgentPlan {
  id                String   @id @default(uuid())
  agentRunId         String
  version            Int      @default(1)
  status             String
  taskType           String
  summary            String
  assumptions        Json?
  risks              Json?
  steps              Json
  requiredApprovals  Json?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  agentRun           AgentRun @relation(fields: [agentRunId], references: [id])
}
```

### 6.3 AgentStep

记录每一步工具调用、LLM 调用或决策。

```prisma
model AgentStep {
  id          String   @id @default(uuid())
  agentRunId  String
  stepNo      Int
  stepType    String
  name        String
  toolName    String?
  status      String
  mode        String
  input       Json?
  output      Json?
  error       String?
  startedAt   DateTime?
  finishedAt  DateTime?
  createdAt   DateTime @default(now())

  agentRun    AgentRun @relation(fields: [agentRunId], references: [id])
}
```

### 6.4 AgentArtifact

保存 Plan 阶段或执行阶段产生的中间产物。

```prisma
model AgentArtifact {
  id            String   @id @default(uuid())
  agentRunId    String
  artifactType  String
  title         String
  content       Json
  status        String
  sourceStepNo  Int?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  agentRun      AgentRun @relation(fields: [agentRunId], references: [id])
}
```

Artifact 类型：

```text
project_import_preview
characters_preview
lorebook_preview
outline_preview
chapter_draft_preview
consistency_report
revision_plan
```

### 6.5 AgentApproval

记录用户审批。

```prisma
model AgentApproval {
  id            String   @id @default(uuid())
  agentRunId    String
  approvalType  String
  status        String
  target        Json
  approvedBy    String?
  approvedAt    DateTime?
  comment       String?
  createdAt     DateTime @default(now())

  agentRun      AgentRun @relation(fields: [agentRunId], references: [id])
}
```

---

## 7. 后端模块设计

### 7.1 Agent 模块

```text
apps/api/src/modules/agent-runs/
  agent-runs.module.ts
  agent-runs.controller.ts
  agent-runs.service.ts
  agent-runtime.service.ts
  agent-planner.service.ts
  agent-executor.service.ts
  agent-policy.service.ts
  agent-trace.service.ts
  dto/
```

职责：

- 创建 AgentRun；
- 生成 Plan；
- 处理用户审批；
- 同步调用 AgentRuntime 执行 Plan / Act；
- 查询步骤和产物；
- 更新状态。

### 7.2 Tool 模块

```text
apps/api/src/modules/agent-tools/
  agent-tools.module.ts
  base-tool.ts
  tool-registry.service.ts
  tools/
    resolve-chapter.tool.ts
    write-chapter.tool.ts
    fact-validation.tool.ts
    import-preview.tool.ts
    persist-project-assets.tool.ts
    outline-preview.tool.ts
    persist-outline.tool.ts
```

### 7.3 Skill 模块

```text
apps/api/src/modules/agent-skills/
  agent-skills.module.ts
  skill-registry.service.ts
  builtin-skills.ts
```

### 7.4 Rule 模块

```text
apps/api/src/modules/agent-rules/
  agent-rules.module.ts
  rule-engine.service.ts
  builtin-rules.ts
```

### 7.5 LLM 模块

```text
apps/api/src/modules/llm/
  llm.module.ts
  llm-gateway.service.ts
  dto/
```

### 7.6 迁移后的业务模块

```text
apps/api/src/modules/generation/
  generate-chapter.service.ts
  polish-chapter.service.ts
  postprocess-chapter.service.ts
  prompt-builder.service.ts

apps/api/src/modules/memory/
  retrieval.service.ts
  memory-writer.service.ts
  memory-rebuild.service.ts

apps/api/src/modules/validation/
  validation-engine.service.ts
  fact-validation.service.ts

apps/api/src/modules/facts/
  fact-extractor.service.ts
```

---

## 8. Tool 调用机制

### 8.1 ToolCall

LLM 或 Planner 输出结构化 ToolCall：

```json
{
  "stepNo": 2,
  "name": "生成章节正文",
  "tool": "write_chapter",
  "mode": "act",
  "requiresApproval": true,
  "args": {
    "projectId": "p1",
    "chapterId": "{{steps.1.output.chapterId}}",
    "instruction": "压迫感强一点",
    "wordCount": 3500
  }
}
```

### 8.2 BaseTool

```ts
export interface ToolContext {
  agentRunId: string;
  projectId: string;
  chapterId?: string;
  mode: 'plan' | 'act';
  approved: boolean;
  userId?: string;
  outputs: Record<number, unknown>;
  policy: Record<string, unknown>;
}

export interface BaseTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  allowedModes: Array<'plan' | 'act'>;
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  sideEffects: string[];
  run(args: TInput, context: ToolContext): Promise<TOutput>;
}
```

### 8.3 执行流程

```text
Executor 读取 step
  ↓
ToolRegistry.get(step.tool)
  ↓
Policy.assertAllowed(tool, context)
  ↓
resolveArgs(step.args, previousOutputs)
  ↓
validateInputSchema(args)
  ↓
trace.startStep()
  ↓
tool.run(args, context)
  ↓
trace.finishStep()
  ↓
保存输出供后续步骤引用
```

---

## 9. LLM 请求设计

第一阶段推荐使用 **Prompt 声明工具 + JSON Plan 输出**，暂不强依赖 function calling。

Planner 请求 LLM 时注入：

```text
System Rules
Mode Rules
Selected Skill
Available Tools
Project Context
User Message
Output Contract
```

示例：

```text
你是 CreativeAgent Planner。
当前模式：plan。
Plan 模式不能写正式业务表。
你只能使用 Available Tools 中的工具。
不能编造工具。
输出必须是 JSON。

Selected Skill:
import-breakdown

Available Tools:
1. analyze_source_text(...)
2. extract_characters_preview(...)
3. extract_lorebook_preview(...)
4. build_import_preview(...)
5. persist_project_assets(... actOnly, requiresApproval)

User Message:
这是我的小说文案，帮我拆成角色、世界观和前三卷大纲。
```

后续可扩展 `LlmGatewayService` 支持 OpenAI-compatible tools/function calling，但执行仍必须经过 ToolRegistry 和 Policy。

---

## 10. API 设计

### 10.1 对 Web 暴露

```text
POST /api/agent-runs/plan
GET  /api/agent-runs/:id
GET  /api/projects/:projectId/agent-runs
POST /api/agent-runs/:id/act
POST /api/agent-runs/:id/cancel
POST /api/agent-runs/:id/approve-step
```

### 10.2 创建 Plan

```http
POST /api/agent-runs/plan
```

```json
{
  "projectId": "project-id",
  "message": "这是我的文案，帮我拆成角色、世界观和前三卷大纲。",
  "context": {
    "currentChapterId": null
  },
  "attachments": []
}
```

响应：

```json
{
  "agentRunId": "agent-run-id",
  "status": "waiting_approval",
  "plan": {},
  "artifacts": []
}
```

### 10.3 执行 Act

```http
POST /api/agent-runs/:id/act
```

```json
{
  "approval": true,
  "approvedStepNos": [3]
}
```

响应：

```json
{
  "agentRunId": "agent-run-id",
  "status": "acting"
}
```

---

## 11. 同步执行设计

本阶段明确不引入独立任务调度层。Agent 的 Plan / Act 请求由 API 后端同步执行：

```text
Web
  ↓
AgentRunsController
  ↓
AgentRunsService
  ↓
AgentRuntime.plan() / AgentRuntime.act()
  ↓
AgentPlanner / AgentExecutor
  ↓
Tool.run()
  ↓
NestJS Service / Prisma / LLM Gateway
```

同步执行约束：

- Controller 不直接写业务逻辑，只负责 DTO 校验和调用 Service。
- Service 调用 AgentRuntime，并在返回前完成当前 Plan / Act。
- 所有步骤仍写入 AgentStep，便于失败排查。
- LLM 调用需要设置超时、重试和错误格式化。
- Act 执行过程中如遇需要确认的高风险步骤，立即停止并将 AgentRun 置为 `waiting_review`。
- 如果 HTTP 超时成为问题，再单独评估流式响应、分步提交或缩小单次执行范围，但不改变“API 内同步函数调用”的当前设计目标。

---

## 12. 前端设计

```text
apps/web/components/agent/
  AgentWorkspace.tsx
  AgentInputBox.tsx
  AgentPlanView.tsx
  AgentTimeline.tsx
  AgentArtifactPreview.tsx
  AgentApprovalDialog.tsx
  AgentResultReport.tsx

apps/web/hooks/
  useAgentRun.ts
```

交互：

```text
用户输入目标
  ↓
生成计划
  ↓
展示 Agent 理解、步骤、风险、预览
  ↓
用户确认执行
  ↓
展示执行时间线
  ↓
展示最终结果
```

---

## 13. 典型场景

### 13.1 写章节正文

用户：

```text
帮我写第 12 章正文，压迫感强一点，字数 3500。
```

Plan：

```text
1. resolve_chapter
2. write_chapter
3. fact_validation
4. report_result
```

Act：

```text
resolve_chapter → ChapterService
write_chapter → GenerateChapterService / 迁移前 WorkerClient
fact_validation → FactValidationService
report_result → 汇总草稿、摘要、校验问题、入库结果
```

### 13.2 文案拆解入库

用户：

```text
这是我的小说创意……帮我拆成角色、世界观和前三卷大纲。
```

Plan：

```text
1. analyze_source_text
2. extract_project_profile_preview
3. extract_characters_preview
4. extract_lorebook_preview
5. extract_outline_preview
6. build_import_preview
7. persist_project_assets(requiresApproval)
```

Act：

```text
persist_project_profile
persist_characters
persist_lorebook_entries
persist_volumes
persist_chapters
validate_imported_assets
```

### 13.3 生成大纲

用户：

```text
帮我把第一卷拆成 30 章。
```

Plan：

```text
1. inspect_project_context
2. generate_outline_preview
3. validate_outline
4. persist_outline(requiresApproval)
```

---

## 14. 风险控制

| 风险 | 控制方式 |
|---|---|
| LLM 编造工具 | ToolRegistry 白名单校验 |
| Plan 模式误写库 | Policy 硬规则禁止 |
| Agent 越权修改角色/设定 | Approval Rule |
| 自动循环消耗过高 | maxSteps / maxLlmCalls |
| 批量导入污染项目 | Artifact 预览 + 用户确认 |
| Prompt 输出 JSON 不合法 | JSON parser + retry / fallback |
| 写入中途失败 | AgentStep 记录 + failed 状态 |
| 事实库被错误覆盖 | 高风险写入审批 + Validation |

---

## 15. MVP 范围

第一版建议只做：

```text
1. AgentRun / AgentPlan / AgentStep / AgentArtifact / AgentApproval
2. CreativeAgent Plan / Act
3. ToolRegistry / Policy / Executor / Trace
4. LlmGatewayService
5. chapter_write 场景
6. project_import_preview 场景
```

MVP 目标：

```text
用户能用自然语言让 Agent 制定计划；
用户确认后，Agent 能执行章节写作或文案拆解预览；
所有步骤可追踪、可审批、可回看。
```
